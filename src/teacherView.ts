import * as vscode from 'vscode';
import { storageManager } from './state';

let panel: vscode.WebviewPanel | undefined;

export function openTeacherView(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'tbdTeacherView',
        'Teacher Dashboard',
        { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)]
        }
    );

    panel.webview.html = getHtml(panel.webview, context);

    panel.onDidDispose(() => {
        panel = undefined;
    }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async message => {
        try {
            if (message.command === 'listLogs') {
                const files = await storageManager.listLogFiles();
                panel?.webview.postMessage({ command: 'logList', data: files.map(f => f.label) });
            }

            if (message.command === 'openLog') {
                const filename: string = message.filename;
                const files = await storageManager.listLogFiles();
                const chosen = files.find(f => f.label === filename);
                if (!chosen) {
                    panel?.webview.postMessage({ command: 'error', message: 'Log not found' });
                    return;
                }
                // Prompt for admin password
                const password = await vscode.window.showInputBox({ prompt: `Enter Administrator Password to view ${filename}`, password: true, ignoreFocusOut: true });
                if (!password) {
                    panel?.webview.postMessage({ command: 'error', message: 'Password required' });
                    return;
                }
                try {
                  const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
                  const content = res.text;
                  const partial = res.partial;
                  // Try to parse JSON and send structured data. If full parse fails,
                  // attempt to salvage a JSON substring (useful for partially
                  // decrypted/truncated files) and notify the UI that data is
                  // partial.
                  let parsed: any = null;
                  try { parsed = JSON.parse(content); } catch {
                    try {
                      const s = content.indexOf('{');
                      const e = content.lastIndexOf('}');
                      if (s !== -1 && e > s) {
                        const sub = content.slice(s, e + 1);
                        parsed = JSON.parse(sub);
                      }
                    } catch (_) { parsed = null; }
                  }

                  if (parsed) {
                    panel?.webview.postMessage({ command: 'logData', filename, data: parsed, partial });
                  } else {
                    // If we couldn't parse anything, send raw content but
                    // trim long binary sequences and indicate it's binary.
                    let safe = String(content);
                    safe = safe.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '\uFFFD');
                    if (safe.length > 200_000) safe = safe.slice(0, 200_000) + '\n\n[truncated]';
                    panel?.webview.postMessage({ command: 'rawData', filename, data: safe, partial });
                  }
                } catch (err: any) {
                  panel?.webview.postMessage({ command: 'error', message: String(err) });
                }
            }
        } catch (e) {
            panel?.webview.postMessage({ command: 'error', message: String(e) });
        }
    }, undefined, context.subscriptions);
}

function getHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} https: 'unsafe-inline';" />
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Teacher Dashboard</title>
  <style>
    :root {
      --bg: #0f1724;
      --card: #0b1220;
      --muted: #9aa4b2;
      --accent: #2563eb;
      --accent-2: #7c3aed;
      --surface: #0b1220;
      --radius: 10px;
    }
    html,body { height:100%; margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; }

    /* Theme variables (light & dark) */
    :root { --bg: #f7fafc; --surface: #ffffff; --muted: #4b5563; --fg: #0f1724; --card-shadow: rgba(2,6,23,0.06); --accent: #2563eb; --accent-2:#7c3aed; }
    .dark, :root.dark { --bg: #071021; --surface: #0b1220; --muted: #9aa4b2; --fg: #e6eef8; --card-shadow: rgba(2,6,23,0.6); --accent: #2563eb; --accent-2:#7c3aed; }

    body { background: var(--bg); color: var(--fg); }
    .container { max-width:1100px; margin:18px auto; padding:20px; border-radius:var(--radius); background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.005)); box-shadow: 0 6px 30px var(--card-shadow); }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    h1 { margin:0; font-size:1.15rem; font-weight:600; color:#fff; }
    .toolbar { display:flex; gap:8px; align-items:center; margin-top:16px; }
    .control { display:flex; gap:8px; align-items:center; }
    .search { background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.06); padding:8px 10px; color:var(--muted); border-radius:8px; min-width:240px; }
    .dark .search { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.04); color: var(--muted); }
    select { background: transparent; color: var(--fg); border:1px solid rgba(0,0,0,0.06); padding:8px 10px; border-radius:8px; min-width:320px; }
    select, option { color: var(--fg); background: var(--surface); }
    .btn-group { display:inline-flex; border-radius:8px; overflow:hidden; box-shadow: 0 2px 6px rgba(2,6,23,0.5); }
    .btn { display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border:0; cursor:pointer; font-weight:600; color:#eaf2ff; background:transparent; }
    .btn.primary { background: linear-gradient(90deg,var(--accent),var(--accent-2)); }
    .btn.secondary { background: rgba(255,255,255,0.03); color: var(--muted); }
    .btn:active { transform: translateY(1px); }
    #status { margin-left:12px; color:var(--muted); font-size:0.9rem; }
    #view { margin-top:20px; }
    .card { background: var(--surface); border: 1px solid rgba(0,0,0,0.06); padding:14px; border-radius:10px; }
    .dark .card { border: 1px solid rgba(255,255,255,0.03); background: linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005)); }
    .session-header { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .meta { color:var(--muted); font-size:0.9rem; }
    .event { background: rgba(255,255,255,0.015); padding:12px; border-radius:8px; margin:10px 0; border-left: 3px solid rgba(255,255,255,0.03); }
    pre { white-space:pre-wrap; word-break:break-word; color:#cfe6ff; }
    .warning { background:#fff3f2; color:#8b1d1d; padding:8px; border-radius:8px; margin-bottom:12px; }
    .dark .warning { background:#3b1820; color:#ffd6d6; }
    @media (max-width:700px) { .toolbar { flex-direction:column; align-items:stretch; } select, .search { width:100%; } }
    /* small theme toggle */
    .theme-toggle { background: transparent; border: 1px solid rgba(255,255,255,0.04); color: var(--muted); padding:6px 10px; border-radius:8px; cursor:pointer }
    .theme-toggle:hover { opacity:0.9 }
  </style>
</head>
<body>
  <div class="container max-w-5xl mx-auto p-6 rounded-xl">
    <header>
      <div>
        <h1 class="text-2xl font-semibold" style="color:var(--fg)">Teacher Dashboard</h1>
        <div class="meta text-sm" style="color:var(--muted)">Inspect encrypted session logs and view events</div>
      </div>
      <div class="flex items-center gap-3">
        <div id="status" class="meta text-sm" style="color:var(--muted)">&nbsp;</div>
        <button id="themeToggle" class="theme-toggle px-3 py-1 rounded-md" title="Toggle theme">Toggle</button>
      </div>
    </header>

    <div class="toolbar mt-4">
      <div class="control flex items-center gap-3">
        <input id="search" class="search px-3 py-2 rounded-md" placeholder="Search logs..." />
        <select id="logSelect" class="px-3 py-2 rounded-md"><option>Loading...</option></select>
        <div class="btn-group ml-2" role="group">
          <button id="open" class="btn primary px-4 py-2">Open</button>
          <button id="refresh" class="btn secondary px-4 py-2">Refresh</button>
        </div>
      </div>
    </div>

    <div id="view" class="card"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const select = document.getElementById('logSelect');
    const openBtn = document.getElementById('open');
    const refreshBtn = document.getElementById('refresh');
    const status = document.getElementById('status');
    const view = document.getElementById('view');
    const search = document.getElementById('search');

    let logNamesCache = [];
    // Theme state persisted via webview state
    const prevTheme = vscode.getState() && vscode.getState().theme;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    let theme = prevTheme || (prefersDark ? 'dark' : 'light');
    if (theme === 'dark') document.documentElement.classList.add('dark');

    const themeToggle = document.getElementById('themeToggle');
    // set initial toggle label
    function updateToggleLabel() { themeToggle.textContent = (theme === 'dark') ? '🌙 Dark' : '🌞 Light'; }
    updateToggleLabel();
    themeToggle.addEventListener('click', () => {
      if (document.documentElement.classList.contains('dark')) {
        document.documentElement.classList.remove('dark');
        theme = 'light';
      } else {
        document.documentElement.classList.add('dark');
        theme = 'dark';
      }
      vscode.setState(Object.assign({}, vscode.getState(), { theme }));
      updateToggleLabel();
    });

    function clearView() { view.innerHTML = ''; }

    function fmtLocal(iso) {
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (_) { return iso; }
    }

    function renderHeader(h) {
      const outer = document.createElement('div');
      outer.className = 'session-header';

      const left = document.createElement('div');
      const title = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = 'Session ' + (h.sessionNumber || '');
      strong.style.display = 'block';
      strong.style.fontSize = '1.05rem';
      const small = document.createElement('div');
      small.className = 'meta';
      small.textContent = '';
      // User and Workspace lines
      const userLine = document.createElement('div'); userLine.textContent = 'User: ' + (h.startedBy || 'Unknown'); userLine.className = 'meta';
      const wsLine = document.createElement('div'); wsLine.textContent = 'Workspace: ' + (h.project || 'Unknown'); wsLine.className = 'meta';

      title.appendChild(strong);
      title.appendChild(userLine);
      title.appendChild(wsLine);
      left.appendChild(title);

      const right = document.createElement('div'); right.className = 'meta';
      // Start time
      if (h.startTime) {
        const s = document.createElement('div'); s.textContent = 'Started: ' + fmtLocal(h.startTime); s.className = 'meta'; right.appendChild(s);
      }
      // End time detection - check common fields
      const endCandidates = [h.endTime, h.closedAt, h.endTimestamp, h.endedAt, h.closeTime];
      const endVal = endCandidates.find(v => v !== undefined && v !== null);
      if (endVal) {
        const e = document.createElement('div'); e.textContent = 'Ended: ' + fmtLocal(endVal); e.className = 'meta'; right.appendChild(e);
      }

      outer.appendChild(left); outer.appendChild(right);
      return outer;
    }

    function renderEvent(e) {
      const d = document.createElement('div');
      d.className = 'event';
      const head = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = (e.eventType || e.type || 'event');
      const span = document.createElement('span'); span.className = 'meta'; span.textContent = (e.time || '') + (e.flightTime ? (' • ' + e.flightTime + 'ms') : '');
      head.appendChild(strong); head.appendChild(document.createTextNode(' ')); head.appendChild(span);
      d.appendChild(head);
      const ul = document.createElement('div'); ul.className = 'meta';
      const keys = Object.keys(e).filter(k => !['eventType','time','flightTime'].includes(k));
      for (const k of keys) { const row = document.createElement('div'); row.textContent = k + ': ' + JSON.stringify(e[k]); ul.appendChild(row); }
      d.appendChild(ul);
      return d;
    }

    function renderParsed(parsed) {
      clearView();
      if (parsed.sessionHeader) { view.appendChild(renderHeader(parsed.sessionHeader)); }
      if (Array.isArray(parsed.events)) {
        if (parsed.events.length === 0) { const p = document.createElement('div'); p.textContent = 'No events recorded.'; view.appendChild(p); }
        else { const container = document.createElement('div'); for (const ev of parsed.events.slice().reverse()) container.appendChild(renderEvent(ev)); view.appendChild(container); }
      } else { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(parsed, null, 2); view.appendChild(pre); }
    }

    function renderRaw(text) { clearView(); const pre = document.createElement('pre'); pre.textContent = text; view.appendChild(pre); }

    function renderWarning(msg) { const w = document.createElement('div'); w.className = 'warning'; w.textContent = msg; view.insertBefore(w, view.firstChild); }

    function setList(names) { logNamesCache = names.slice(); renderOptions(); }

    function renderOptions(filter = '') {
      select.innerHTML = '';
      const f = filter.trim().toLowerCase();
      const filtered = logNamesCache.filter(n => n.toLowerCase().includes(f));
      if (filtered.length === 0) { const o = document.createElement('option'); o.textContent = 'No logs found'; o.value = ''; select.appendChild(o); return; }
      for (const name of filtered) { const o = document.createElement('option'); o.value = name; o.textContent = name; select.appendChild(o); }
      status.textContent = 'Found ' + filtered.length + ' logs';
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'logList') { setList(msg.data); }
      if (msg.command === 'logData') { status.textContent = 'Showing ' + msg.filename + (msg.partial ? ' (partial)' : ''); if (msg.partial) renderWarning('WARNING: File appears tampered or truncated. Showing best-effort parsed data.'); renderParsed(msg.data); }
      if (msg.command === 'rawData') { status.textContent = 'Showing ' + msg.filename + ' (raw)'; renderRaw(msg.data); }
      if (msg.command === 'error') { status.textContent = 'Error: ' + msg.message; }
    });

    openBtn.addEventListener('click', () => { const filename = select.value; if (!filename) return; status.textContent = 'Requesting...'; vscode.postMessage({ command: 'openLog', filename }); });
    refreshBtn.addEventListener('click', () => { status.textContent = 'Refreshing list...'; vscode.postMessage({ command: 'listLogs' }); });
    search.addEventListener('input', (e) => { renderOptions(e.target.value); });

    // initial list fetch
    vscode.postMessage({ command: 'listLogs' });
  </script>
</body>
</html>`;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
