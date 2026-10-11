// BackupAgentSetup.exe: the "download and double-click" way to install the backup agent on Windows.
//
// It's the same file for every device. When you download it from the gateway (Devices > Add
// device > Windows), the gateway adds that device's one-time install link to the end of the file:
//
//     [this program][JSON {"script": "...", "client": "...", "expires": "..."}][8-byte length, big-endian]["BGSETUP1"]
//
// The program reads the link back, asks Windows for administrator rights, and runs the same
// PowerShell install as the one-line command: download the agent from the gateway, check its
// SHA-256, install it as a background task, enroll. No settings to type.
//
// Plain C with only Windows' own libraries (no C runtime), so the file is a few KB.
// A ready-built copy is kept next to this file; rebuild it with:  npm run build-windows-setup

#include <windows.h>
#include <shlobj.h>

#define MAGIC "BGSETUP1"
#define MAX_INFO (64 * 1024)

// No C runtime: the compiler may still call these for struct copies and zeroing
void *memset(void *dst, int c, size_t n) {
  unsigned char *d = dst;
  while (n--) *d++ = (unsigned char)c;
  return dst;
}
void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = dst;
  const unsigned char *s = src;
  while (n--) *d++ = *s++;
  return dst;
}

static HANDLE out;

static void say(const wchar_t *text) {
  DWORD n;
  WriteConsoleW(out, text, lstrlenW(text), &n, NULL);
}

static void say_utf8(const char *text, int len) {
  wchar_t wide[1024];
  int n = MultiByteToWideChar(CP_UTF8, 0, text, len, wide, 1023);
  if (n <= 0) return;
  wide[n] = 0;
  say(wide);
}

static void pause_and_exit(UINT code) {
  wchar_t buf[64];
  DWORD n;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  say(L"\r\nPress Enter to close this window.");
  FlushConsoleInputBuffer(in);
  ReadConsoleW(in, buf, 63, &n, NULL);
  ExitProcess(code);
}

static void fail(const wchar_t *text) {
  say(text);
  pause_and_exit(1);
}

// Finds "key":"value" in the small JSON the gateway wrote and copies the value (simple escapes
// only: the gateway never writes anything else). Returns the length, or -1.
static int json_string(const char *json, int len, const char *key, char *dst, int cap) {
  int klen = lstrlenA(key);
  for (int i = 0; i + klen + 3 < len; i++) {
    if (json[i] != '"') continue;
    int k = 0;
    while (k < klen && json[i + 1 + k] == key[k]) k++;
    if (k != klen || json[i + 1 + klen] != '"' || json[i + 2 + klen] != ':' || json[i + 3 + klen] != '"') continue;
    int n = 0;
    for (int j = i + 4 + klen; j < len; j++) {
      char c = json[j];
      if (c == '"') {
        dst[n] = 0;
        return n;
      }
      if (c == '\\') {
        if (++j >= len) return -1;
        c = json[j];
        if (c == 'n' || c == 't' || c == 'r') c = ' ';
        else if (c != '"' && c != '\\' && c != '/') return -1;
      }
      if (n + 1 >= cap) return -1;
      dst[n++] = c;
    }
    return -1;
  }
  return -1;
}

// The install link must be a plain web address: nothing that could break out of the command line
static BOOL safe_url(const char *url) {
  if (lstrcmpA(url, "") == 0) return FALSE;
  const char *http = "http://", *https = "https://";
  int ok = 1;
  for (int i = 0; i < 7; i++) ok &= url[i] == http[i];
  if (!ok) {
    ok = 1;
    for (int i = 0; i < 8; i++) ok &= url[i] == https[i];
  }
  if (!ok) return FALSE;
  for (const char *p = url; *p; p++) {
    char c = *p;
    BOOL allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ':' || c == '/' ||
                   c == '.' || c == '-' || c == '_' || c == '~' || c == '%' || c == '[' || c == ']';
    if (!allowed) return FALSE;
  }
  return TRUE;
}

// Reads the install link that the gateway appended to this file
static BOOL read_trailer(const wchar_t *path, char *info, int *info_len) {
  HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return FALSE;
  BOOL ok = FALSE;
  LARGE_INTEGER size, pos;
  unsigned char tail[16];
  DWORD got;
  if (!GetFileSizeEx(f, &size) || size.QuadPart < 16) goto done;
  pos.QuadPart = size.QuadPart - 16;
  if (!SetFilePointerEx(f, pos, NULL, FILE_BEGIN) || !ReadFile(f, tail, 16, &got, NULL) || got != 16) goto done;
  for (int i = 0; i < 8; i++)
    if (tail[8 + i] != (unsigned char)MAGIC[i]) goto done;
  unsigned long long n = 0;
  for (int i = 0; i < 8; i++) n = (n << 8) | tail[i];
  if (n == 0 || n >= MAX_INFO || (long long)n > size.QuadPart - 16) goto done;
  pos.QuadPart = size.QuadPart - 16 - (long long)n;
  if (!SetFilePointerEx(f, pos, NULL, FILE_BEGIN) || !ReadFile(f, info, (DWORD)n, &got, NULL) || got != n) goto done;
  info[n] = 0;
  *info_len = (int)n;
  ok = TRUE;
done:
  CloseHandle(f);
  return ok;
}

static char info[MAX_INFO];
static char url[2048], client[256], expires[256];
static wchar_t self[MAX_PATH * 2], cmdline[4096], ps[MAX_PATH + 64], wurl[2048];

void start(void) {
  out = GetStdHandle(STD_OUTPUT_HANDLE);
  SetConsoleTitleW(L"Backup agent setup");

  DWORD selflen = GetModuleFileNameW(NULL, self, MAX_PATH * 2);
  if (selflen == 0 || selflen >= MAX_PATH * 2) fail(L"Can't find this installer's own file.\r\n");

  int info_len = 0;
  if (!read_trailer(self, info, &info_len) || json_string(info, info_len, "script", url, sizeof url) < 0 || !safe_url(url)) {
    fail(L"This installer doesn't have an install link in it.\r\n"
         L"Download it from the gateway's web UI: Devices > Add device > Windows PC.\r\n");
  }

  if (!IsUserAnAdmin()) {
    // Ask Windows for administrator rights (the usual "allow changes" prompt) and start again
    HINSTANCE r = ShellExecuteW(NULL, L"runas", self, NULL, NULL, SW_SHOWNORMAL);
    if ((INT_PTR)r > 32) ExitProcess(0);
    fail(GetLastError() == ERROR_CANCELLED ? L"The installer needs administrator rights: choose Yes when Windows asks.\r\n"
                                           : L"The installer needs administrator rights and Windows didn't give them.\r\n");
  }

  int clen = json_string(info, info_len, "client", client, sizeof client);
  int elen = json_string(info, info_len, "expires", expires, sizeof expires);
  say(L"Backup agent setup");
  if (clen > 0) {
    say(L" for ");
    say_utf8(client, clen);
  }
  say(L"\r\n");
  if (elen > 0) {
    say(L"(this installer works once, until ");
    say_utf8(expires, elen);
    say(L")\r\n");
  }
  say(L"\r\n");

  // Windows PowerShell from System32 by its full path, never whatever "powershell" is in the folder
  // this file was downloaded to
  UINT sys = GetSystemDirectoryW(ps, MAX_PATH);
  if (sys == 0 || sys >= MAX_PATH) fail(L"Can't find the Windows folder.\r\n");
  lstrcatW(ps, L"\\WindowsPowerShell\\v1.0\\powershell.exe");

  if (MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, 2048) <= 0) fail(L"Bad install link.\r\n");
  lstrcpyW(cmdline, L"\"");
  lstrcatW(cmdline, ps);
  lstrcatW(cmdline, L"\" -NoProfile -ExecutionPolicy Bypass -Command \"irm '");
  lstrcatW(cmdline, wurl);
  lstrcatW(cmdline, L"' | iex\"");

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof si);
  memset(&pi, 0, sizeof pi);
  si.cb = sizeof si;
  if (!CreateProcessW(ps, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fail(L"Couldn't start Windows PowerShell.\r\n");
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  pause_and_exit(code);
}
