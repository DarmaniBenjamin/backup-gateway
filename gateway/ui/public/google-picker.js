// Google's folder picker, in its own small window (opened from the Google Drive folder chooser).
// It's the only page allowed to load Google's script. The chosen folder goes back to the window
// that opened it; the gateway itself checks the folder again before using it.
(function () {
  const pending = decodeURIComponent(location.hash.slice(1));
  const statusEl = document.getElementById("status");
  const closeBtn = document.getElementById("close");
  closeBtn.addEventListener("click", () => window.close());

  function send(message) {
    if (window.opener) window.opener.postMessage({ source: "bg-google-picker", ...message }, location.origin);
  }
  function fail(text) {
    statusEl.textContent = text;
    statusEl.className = "error";
    document.getElementById("hint").hidden = true;
    closeBtn.hidden = false;
    send({ error: text });
  }
  if (!window.opener || !pending) return fail("Open this from the gateway's Google Drive folder chooser.");

  async function token() {
    const res = await fetch(`/admin/api/cloud/drive/pending/${encodeURIComponent(pending)}/picker`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Backup-UI": "1" },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The gateway said ${res.status}`);
    return body;
  }

  function loadGoogle() {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://apis.google.com/js/api.js";
      s.onload = () => window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google's picker didn't load.")) });
      s.onerror = () => reject(new Error("Can't reach Google. Check this computer's internet connection."));
      document.head.appendChild(s);
    });
  }

  Promise.all([token(), loadGoogle()])
    .then(([t]) => {
      const p = window.google.picker;
      const view = new p.DocsView(p.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes("application/vnd.google-apps.folder");
      new p.PickerBuilder()
        .setTitle("Choose the folder for the backups")
        .addView(view)
        .setOAuthToken(t.accessToken)
        .setDeveloperKey(t.apiKey)
        .setAppId(t.appId)
        .setOrigin(location.origin)
        .setCallback((data) => {
          if (data.action === p.Action.PICKED && data.docs && data.docs[0]) {
            send({ folder: { id: data.docs[0].id, name: data.docs[0].name } });
            window.close();
          } else if (data.action === p.Action.CANCEL) {
            send({ cancelled: true });
            window.close();
          }
        })
        .build()
        .setVisible(true);
      statusEl.textContent = "Choose a folder in the Google window.";
    })
    .catch((err) => fail(err.message));
})();
