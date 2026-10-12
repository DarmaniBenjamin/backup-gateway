// BackupAgentSetup.exe: the "download and double-click" way to install the backup agent on Windows.
//
// It's the SAME file for every device: nothing is added to it. Which device it's for is in its
// file name, which the gateway sets when it's downloaded from a short install link:
//
//     BackupAgentSetup_K7Q2MX_192.168.1.25_8080.exe      (http://192.168.1.25:8080/i/K7Q2MX)
//     BackupAgentSetup_K7Q2MX_backup.example.com_443s.exe (https, the "s" after the port)
//
// If the name was changed, it asks for the short link instead (or takes it as its first argument).
//
// Then it does what an ordinary installer does, in the open:
//   1. asks the gateway for this install's details (GET /i/<code>/setup.json)
//   2. downloads the agent package and checks its SHA-256 against those details
//   3. unpacks it with Windows' own tar.exe
//   4. runs the agent's installer, install.ps1, with Windows PowerShell
//      (-ExecutionPolicy RemoteSigned: the unpacked files are local, nothing is bypassed)
//   5. deletes the temporary files
//
// Being the same file for everyone (and not running downloaded code with "irm | iex", which is
// how a lot of malware works) is what lets antivirus and SmartScreen trust it, and lets it be
// code-signed once. The administrator prompt comes from its manifest (setup.rc).
//
// Rebuild it with:  npm run build-windows-setup   (needs Zig: sudo pacman -S zig)

#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define CODE_LEN 6
#define MAX_ARGS 16
#define MAX_JSON (64 * 1024)

typedef struct {
  BOOL https;
  wchar_t host[256];
  INTERNET_PORT port;
  wchar_t code[CODE_LEN + 1];
} Link;

static HANDLE out_handle;
static HINTERNET session;

// ---------- Talking to the person ----------

static void say(const wchar_t *fmt, ...) {
  wchar_t buf[4096];
  va_list ap;
  va_start(ap, fmt);
  int n = _vsnwprintf(buf, 4095, fmt, ap);
  va_end(ap);
  if (n < 0) n = 4095;
  buf[n] = 0;
  DWORD written;
  if (!WriteConsoleW(out_handle, buf, (DWORD)n, &written, NULL)) {
    // Not a console (output redirected): write UTF-8 instead
    char utf8[8192];
    int len = WideCharToMultiByte(CP_UTF8, 0, buf, n, utf8, sizeof utf8, NULL, NULL);
    WriteFile(out_handle, utf8, (DWORD)len, &written, NULL);
  }
}

static void read_line(wchar_t *buf, DWORD cap) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  DWORD n = 0;
  FlushConsoleInputBuffer(in);
  if (!ReadConsoleW(in, buf, cap - 1, &n, NULL)) {
    // Not a console (input piped in): read one line of UTF-8 instead
    char line[1024];
    DWORD got = 0, one;
    char c;
    while (got < sizeof line - 1 && ReadFile(in, &c, 1, &one, NULL) && one == 1 && c != '\n') line[got++] = c;
    line[got] = 0;
    n = (DWORD)MultiByteToWideChar(CP_UTF8, 0, line, -1, buf, (int)cap);
    n = n ? n - 1 : 0;
  }
  buf[n] = 0;
  while (n > 0 && (buf[n - 1] == L'\r' || buf[n - 1] == L'\n' || buf[n - 1] == L' ')) buf[--n] = 0;
}

static void finish(int code) {
  wchar_t buf[16];
  say(L"\r\nPress Enter to close this window.");
  read_line(buf, 16);
  ExitProcess((UINT)code);
}

static void fail(const wchar_t *fmt, ...) {
  wchar_t buf[2048];
  va_list ap;
  va_start(ap, fmt);
  _vsnwprintf(buf, 2047, fmt, ap);
  va_end(ap);
  buf[2047] = 0;
  say(L"\r\n%ls\r\n", buf);
  finish(1);
}

// ---------- The short link: in the file name, typed, or as the first argument ----------

static BOOL code_char(wchar_t c) {
  return (c >= L'2' && c <= L'9') || (c >= L'A' && c <= L'Z' && c != L'I' && c != L'L' && c != L'O');
}

static BOOL host_char(wchar_t c) {
  return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'.' || c == L'-';
}

static BOOL starts_with_i(const wchar_t *s, const wchar_t *prefix) {
  size_t n = wcslen(prefix);
  return _wcsnicmp(s, prefix, n) == 0;
}

// Reads 6 code characters (any case) into link->code
static const wchar_t *read_code(const wchar_t *p, Link *link) {
  for (int i = 0; i < CODE_LEN; i++) {
    wchar_t c = towupper(p[i]);
    if (!code_char(c)) return NULL;
    link->code[i] = c;
  }
  link->code[CODE_LEN] = 0;
  return p + CODE_LEN;
}

// "http://192.168.1.25:8080/i/K7Q2MX", "192.168.1.25:8080/i/k7q2mx", "https://backup.example.com/i/K7Q2MX"
static BOOL parse_link(const wchar_t *text, Link *link) {
  const wchar_t *p = text;
  while (*p == L' ' || *p == L'"') p++;
  link->https = FALSE;
  if (starts_with_i(p, L"https://")) {
    link->https = TRUE;
    p += 8;
  } else if (starts_with_i(p, L"http://")) {
    p += 7;
  }
  int h = 0;
  while (host_char(*p) && h < 255) link->host[h++] = *p++;
  link->host[h] = 0;
  if (h == 0) return FALSE;
  unsigned port = link->https ? 443 : 80;
  if (*p == L':') {
    p++;
    port = 0;
    int digits = 0;
    while (*p >= L'0' && *p <= L'9' && digits < 6) port = port * 10 + (unsigned)(*p++ - L'0'), digits++;
    if (digits == 0 || port == 0 || port > 65535) return FALSE;
  }
  link->port = (INTERNET_PORT)port;
  if (!starts_with_i(p, L"/i/")) return FALSE;
  p = read_code(p + 3, link);
  return p && (*p == 0 || *p == L'/' || *p == L' ' || *p == L'"');
}

// BackupAgentSetup_K7Q2MX_192.168.1.25_8080.exe (anything after the port is ignored, so a browser's
// " (1)" for a second download doesn't matter)
static BOOL parse_file_name(const wchar_t *path, Link *link) {
  const wchar_t *name = wcsrchr(path, L'\\');
  name = name ? name + 1 : path;
  if (!starts_with_i(name, L"BackupAgentSetup_")) return FALSE;
  const wchar_t *p = read_code(name + 17, link);
  if (!p || *p++ != L'_') return FALSE;
  int h = 0;
  while (host_char(*p) && h < 255) link->host[h++] = *p++;
  link->host[h] = 0;
  if (h == 0 || *p++ != L'_') return FALSE;
  unsigned port = 0;
  int digits = 0;
  while (*p >= L'0' && *p <= L'9' && digits < 6) port = port * 10 + (unsigned)(*p++ - L'0'), digits++;
  if (digits == 0 || port == 0 || port > 65535) return FALSE;
  link->port = (INTERNET_PORT)port;
  link->https = (*p == L's' || *p == L'S');
  return TRUE;
}

// ---------- Downloads (WinHTTP, Windows' own) ----------

typedef struct {
  char *data; // in memory (setup.json), or
  DWORD len, cap;
  HANDLE file; // to a file (the agent package)
  BCRYPT_HASH_HANDLE hash; // and its SHA-256 on the way
} Sink;

// GET path from the gateway. Returns the HTTP status, or 0 if it couldn't connect.
static DWORD http_get(const Link *link, const wchar_t *path, Sink *sink, DWORD *error) {
  DWORD status = 0;
  *error = 0;
  HINTERNET conn = WinHttpConnect(session, link->host, link->port, 0);
  HINTERNET req = conn ? WinHttpOpenRequest(conn, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                            link->https ? WINHTTP_FLAG_SECURE : 0)
                       : NULL;
  if (!req || !WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
      !WinHttpReceiveResponse(req, NULL)) {
    *error = GetLastError();
    goto done;
  }
  DWORD size = sizeof status;
  WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
                      WINHTTP_NO_HEADER_INDEX);
  if (status != 200) goto done;
  static char buf[64 * 1024];
  for (;;) {
    DWORD got = 0;
    if (!WinHttpReadData(req, buf, sizeof buf, &got)) {
      *error = GetLastError();
      status = 0;
      goto done;
    }
    if (got == 0) break;
    if (sink->hash && BCryptHashData(sink->hash, (PUCHAR)buf, got, 0) != 0) {
      status = 0;
      goto done;
    }
    if (sink->file) {
      DWORD w;
      if (!WriteFile(sink->file, buf, got, &w, NULL) || w != got) {
        *error = GetLastError();
        status = 0;
        goto done;
      }
    } else {
      if (sink->len + got + 1 > MAX_JSON) {
        status = 0;
        goto done;
      }
      memcpy(sink->data + sink->len, buf, got);
      sink->len += got;
      sink->data[sink->len] = 0;
    }
  }
done:
  if (req) WinHttpCloseHandle(req);
  if (conn) WinHttpCloseHandle(conn);
  return status;
}

static const wchar_t *net_error(DWORD error) {
  switch (error) {
    case ERROR_WINHTTP_CANNOT_CONNECT: return L"the gateway didn't answer (is it running, and is its port open in the firewall?)";
    case ERROR_WINHTTP_TIMEOUT: return L"the gateway took too long to answer";
    case ERROR_WINHTTP_NAME_NOT_RESOLVED: return L"that address couldn't be found";
    case ERROR_WINHTTP_SECURE_FAILURE: return L"the gateway's https certificate isn't valid";
    default: return L"a network error";
  }
}

// ---------- The install details (setup.json), written by the gateway ----------

// Reads the JSON string starting at p (just after its opening quote) into dst. Returns the
// position after the closing quote, or NULL.
static const char *json_read_string(const char *p, char *dst, int cap) {
  int n = 0;
  for (; *p; p++) {
    char c = *p;
    if (c == '"') {
      dst[n] = 0;
      return p + 1;
    }
    if ((unsigned char)c < 0x20) return NULL;
    if (c == '\\') {
      c = *++p;
      if (c == 'n' || c == 'r' || c == 't') c = ' ';
      else if (c != '"' && c != '\\' && c != '/') return NULL; // the gateway never writes others here
    }
    if (n + 1 >= cap) return NULL;
    dst[n++] = c;
  }
  return NULL;
}

// Finds "key": in the JSON and returns where its value starts
static const char *json_value(const char *json, const char *key) {
  char pattern[64];
  snprintf(pattern, sizeof pattern, "\"%s\"", key);
  const char *p = strstr(json, pattern);
  if (!p) return NULL;
  p += strlen(pattern);
  while (*p == ' ') p++;
  if (*p++ != ':') return NULL;
  while (*p == ' ') p++;
  return p;
}

static BOOL json_string(const char *json, const char *key, char *dst, int cap) {
  const char *p = json_value(json, key);
  return p && *p == '"' && json_read_string(p + 1, dst, cap) != NULL;
}

static wchar_t *widen(const char *utf8) {
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t *w = calloc((size_t)n, sizeof(wchar_t));
  if (w) MultiByteToWideChar(CP_UTF8, 0, utf8, -1, w, n);
  return w;
}

// Only plain characters reach the command line: no quotes or control characters
static BOOL safe_arg(const char *s) {
  for (; *s; s++)
    if (*s == '"' || (unsigned char)*s < 0x20) return FALSE;
  return TRUE;
}

static BOOL safe_path(const char *s) {
  if (strncmp(s, "/install/", 9) != 0) return FALSE;
  for (; *s; s++) {
    char c = *s;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '.' || c == '-' || c == '_'))
      return FALSE;
  }
  return TRUE;
}

// ---------- Running programs ----------

// Adds one argument to a command line, quoted the way Windows programs read them back
// (only when it needs quotes: an option like -Gateway must reach PowerShell as it is)
static void add_arg(wchar_t *cmd, size_t cap, const wchar_t *arg) {
  size_t n = wcslen(cmd);
  if (n && n + 1 < cap) cmd[n++] = L' ';
  if (arg[0] && !wcspbrk(arg, L" \t\"")) {
    for (const wchar_t *p = arg; *p && n + 1 < cap; p++) cmd[n++] = *p;
    cmd[n] = 0;
    return;
  }
  if (n + 1 < cap) cmd[n++] = L'"';
  for (const wchar_t *p = arg; *p && n + 3 < cap; p++) {
    if (*p == L'\\') {
      // backslashes before the closing quote are doubled
      const wchar_t *q = p;
      while (*q == L'\\') q++;
      int count = (int)(q - p);
      int times = (*q == 0) ? count * 2 : count;
      for (int i = 0; i < times && n + 3 < cap; i++) cmd[n++] = L'\\';
      p = q - 1;
    } else {
      cmd[n++] = *p;
    }
  }
  if (n + 1 < cap) cmd[n++] = L'"';
  cmd[n] = 0;
}

static DWORD run(const wchar_t *exe, wchar_t *cmdline) {
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si);
  ZeroMemory(&pi, sizeof pi);
  si.cb = sizeof si;
  if (!CreateProcessW(exe, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) return (DWORD)-1;
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return code;
}

static void remove_folder(const wchar_t *dir) {
  wchar_t from[MAX_PATH + 2];
  ZeroMemory(from, sizeof from);
  wcsncpy(from, dir, MAX_PATH);
  SHFILEOPSTRUCTW op;
  ZeroMemory(&op, sizeof op);
  op.wFunc = FO_DELETE;
  op.pFrom = from; // ends with two zeros
  op.fFlags = FOF_NO_UI;
  SHFileOperationW(&op);
}

// ---------- The install ----------

static char json[MAX_JSON];
static wchar_t self_path[MAX_PATH * 2];
static wchar_t temp_dir[MAX_PATH];

int wmain(int argc, wchar_t **argv) {
  out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
  SetConsoleTitleW(L"Backup agent setup");
  say(L"Backup agent setup\r\n\r\n");

  if (!IsUserAnAdmin()) fail(L"The installer needs administrator rights: right-click it > Run as administrator.");

  // Which install: the file name, or the link given as an argument, or ask for it
  Link link;
  ZeroMemory(&link, sizeof link);
  DWORD len = GetModuleFileNameW(NULL, self_path, MAX_PATH * 2);
  BOOL found = (argc > 1 && parse_link(argv[1], &link)) || (len > 0 && parse_file_name(self_path, &link));
  while (!found) {
    wchar_t typed[512];
    say(L"Type the install link shown on the gateway, e.g. 192.168.1.25:8080/i/K7Q2MX\r\n> ");
    read_line(typed, 512);
    if (!typed[0]) fail(L"No link typed. Find it on the gateway: Devices > Add device.");
    found = parse_link(typed, &link);
    if (!found) say(L"That doesn't look like an install link. Try again (or press Enter to stop).\r\n\r\n");
  }

  session = WinHttpOpen(L"BackupAgentSetup/2.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) fail(L"Windows couldn't start a download.");
  WinHttpSetTimeouts(session, 15000, 15000, 30000, 120000);

  // 1. The install's details
  say(L"Asking the gateway at %ls://%ls:%u for install %ls...\r\n", link.https ? L"https" : L"http", link.host, link.port, link.code);
  wchar_t path[64];
  swprintf(path, 64, L"/i/%ls/setup.json", link.code);
  Sink meta = {json, 0, MAX_JSON, NULL, NULL};
  DWORD error;
  DWORD status = http_get(&link, path, &meta, &error);
  if (status == 0) fail(L"Couldn't reach the gateway: %ls.", net_error(error));
  if (status == 404) fail(L"This install link has expired or was already used. Make a new one on the gateway (Devices > Add device).");
  if (status == 429) fail(L"Too many wrong links were tried from this computer. Wait 10 minutes, then try again.");
  if (status != 200) fail(L"The gateway answered with an error (HTTP %lu).", status);

  static char client[256], expires[128], zip_path[256], sha[80];
  if (!json_string(json, "zip", zip_path, sizeof zip_path) || !safe_path(zip_path) || !json_string(json, "sha256", sha, sizeof sha) ||
      strlen(sha) != 64)
    fail(L"The gateway's answer wasn't understood. Update the gateway, then try again.");
  json_string(json, "client", client, sizeof client);
  json_string(json, "expires", expires, sizeof expires);

  // The installer's options: ["-Gateway","http://...","-Code","...",...]
  static char args[MAX_ARGS][1024];
  int nargs = 0;
  const char *p = json_value(json, "args");
  if (!p || *p++ != '[') fail(L"The gateway's answer wasn't understood. Update the gateway, then try again.");
  for (;;) {
    while (*p == ' ' || *p == ',') p++;
    if (*p == ']') break;
    if (*p != '"' || nargs >= MAX_ARGS) fail(L"The gateway's answer wasn't understood.");
    p = json_read_string(p + 1, args[nargs], sizeof args[0]);
    if (!p || !safe_arg(args[nargs])) fail(L"The gateway's answer wasn't understood.");
    nargs++;
  }

  wchar_t *wclient = widen(client), *wexpires = widen(expires);
  if (wclient && wclient[0]) say(L"For: %ls\r\n", wclient);
  if (wexpires && wexpires[0]) say(L"(this link works once, until %ls)\r\n", wexpires);
  say(L"\r\n");

  // 2. The agent package, checked against its SHA-256
  wchar_t tmp_root[MAX_PATH];
  if (!GetTempPathW(MAX_PATH, tmp_root)) fail(L"Can't find the temporary folder.");
  swprintf(temp_dir, MAX_PATH, L"%lsBackupAgentSetup-%llx", tmp_root, (unsigned long long)GetTickCount64());
  if (!CreateDirectoryW(temp_dir, NULL)) fail(L"Can't make a temporary folder in %ls.", tmp_root);

  wchar_t zip_file[MAX_PATH];
  swprintf(zip_file, MAX_PATH, L"%ls\\agent.zip", temp_dir);
  HANDLE f = CreateFileW(zip_file, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) fail(L"Can't write to the temporary folder.");

  BCRYPT_ALG_HANDLE alg = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0 || BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) != 0)
    fail(L"Windows couldn't check the download (SHA-256).");

  say(L"Downloading the backup agent from the gateway...\r\n");
  wchar_t *wzip = widen(zip_path);
  Sink pkg = {NULL, 0, 0, f, hash};
  status = wzip ? http_get(&link, wzip, &pkg, &error) : 0;
  CloseHandle(f);
  if (status == 0) {
    remove_folder(temp_dir);
    fail(L"The download failed: %ls.", net_error(error));
  }
  if (status != 200) {
    remove_folder(temp_dir);
    fail(L"The download failed (HTTP %lu). The link may have just expired: make a new one.", status);
  }

  unsigned char digest[32];
  BCryptFinishHash(hash, digest, 32, 0);
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  if (_stricmp(hex, sha) != 0) {
    remove_folder(temp_dir);
    fail(L"The download failed its SHA-256 check. Nothing was installed.");
  }
  say(L"  [OK] download verified (SHA-256)\r\n");

  // 3. Unpack it with Windows' own tar.exe (Windows 10 1803 and newer, Server 2019 and newer);
  //    older Windows uses PowerShell's Expand-Archive
  wchar_t sys[MAX_PATH], tar[MAX_PATH + 16], ps[MAX_PATH + 64];
  if (!GetSystemDirectoryW(sys, MAX_PATH)) fail(L"Can't find the Windows folder.");
  swprintf(tar, MAX_PATH + 16, L"%ls\\tar.exe", sys);
  swprintf(ps, MAX_PATH + 64, L"%ls\\WindowsPowerShell\\v1.0\\powershell.exe", sys);
  static wchar_t cmd[8192];
  DWORD code;
  if (GetFileAttributesW(tar) != INVALID_FILE_ATTRIBUTES) {
    cmd[0] = 0;
    add_arg(cmd, 8192, tar);
    add_arg(cmd, 8192, L"-xf");
    add_arg(cmd, 8192, zip_file);
    add_arg(cmd, 8192, L"-C");
    add_arg(cmd, 8192, temp_dir);
    code = run(tar, cmd);
  } else {
    // Single quotes inside the paths are doubled for PowerShell
    wchar_t zq[MAX_PATH * 2], dq[MAX_PATH * 2];
    int a = 0, b = 0;
    for (const wchar_t *s = zip_file; *s && a < MAX_PATH * 2 - 2; s++) { if (*s == L'\'') zq[a++] = L'\''; zq[a++] = *s; }
    for (const wchar_t *s = temp_dir; *s && b < MAX_PATH * 2 - 2; s++) { if (*s == L'\'') dq[b++] = L'\''; dq[b++] = *s; }
    zq[a] = 0;
    dq[b] = 0;
    swprintf(cmd, 8192, L"\"%ls\" -NoProfile -Command \"Expand-Archive -LiteralPath '%ls' -DestinationPath '%ls'\"", ps, zq, dq);
    code = run(ps, cmd);
  }
  wchar_t script[MAX_PATH + 64];
  swprintf(script, MAX_PATH + 64, L"%ls\\agent\\install\\windows\\install.ps1", temp_dir);
  if (code != 0 || GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
    remove_folder(temp_dir);
    fail(L"Couldn't unpack the agent.");
  }

  // 4. The agent's installer
  cmd[0] = 0;
  add_arg(cmd, 8192, ps);
  wcscat(cmd, L" -NoProfile -ExecutionPolicy RemoteSigned -File");
  add_arg(cmd, 8192, script);
  for (int i = 0; i < nargs; i++) {
    wchar_t *w = widen(args[i]);
    if (!w) fail(L"The gateway's answer wasn't understood.");
    add_arg(cmd, 8192, w);
    free(w);
  }
  say(L"\r\n");
  code = run(ps, cmd);
  remove_folder(temp_dir);

  if (code == (DWORD)-1) fail(L"Couldn't start Windows PowerShell.");
  if (code != 0) say(L"\r\nThe install didn't finish (see above).\r\n");
  finish((int)code);
  return (int)code;
}
