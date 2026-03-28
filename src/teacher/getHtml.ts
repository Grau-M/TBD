import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getThemePreference } from '../themePreference';

export function getHtml(webview: vscode.Webview, context: vscode.ExtensionContext, apiOnline = true): string {
  const nonce = getNonce();
  const themePreference = getThemePreference(context);
  // add a cache-busting query so updated static script is always loaded in development
  const scriptFile = vscode.Uri.file(context.asAbsolutePath('src/teacher/static/teacher.js')).with({ query: `v=${Date.now()}` });
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src', 'teacher', 'static', 'teacher.js'));
  const renderersUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src', 'teacher', 'static', 'renderers.js'));

  const viewsRoot = context.asAbsolutePath('src/teacher/views');
  const sidebarHtml = fs.readFileSync(path.join(viewsRoot, 'sidebar.html'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(viewsRoot, 'dashboard.html'), 'utf8');
  const logsHtml = fs.readFileSync(path.join(viewsRoot, 'logs.html'), 'utf8');
  const settingsHtml = fs.readFileSync(path.join(viewsRoot, 'settings.html'), 'utf8');
  const deletionsHtml = fs.readFileSync(path.join(viewsRoot, 'deletions.html'), 'utf8');
  const classHtml = fs.readFileSync(path.join(viewsRoot, 'class.html'), 'utf8');
  

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} https: 'unsafe-inline';" />
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Teacher Dashboard</title>
  <style>
    :root { 
        --bg: #f7fafc; --surface: #ffffff; --muted: #4b5563; --fg: #0f1724; 
        --border: rgba(0,0,0,0.1); --card-shadow: rgba(2,6,23,0.06); 
      --accent: #2563eb; --accent-2:#7c3aed; --date-icon-filter: invert(14%) sepia(7%) saturate(1516%) hue-rotate(177deg) brightness(93%) contrast(91%);
    }
    .dark, :root.dark { 
        --bg: #071021; --surface: #0b1220; --muted: #9aa4b2; --fg: #e6eef8; 
        --border: rgba(255,255,255,0.08); --card-shadow: rgba(2,6,23,0.6); 
      --accent: #3b82f6; --accent-2:#8b5cf6; --date-icon-filter: invert(95%) sepia(8%) saturate(226%) hue-rotate(180deg) brightness(94%) contrast(95%);
    }

    body { background: var(--bg); color: var(--fg); height: 100vh; overflow: hidden; display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .app-container { display: flex; height: 100%; max-width: none; margin: 0; width: 100%; box-sizing: border-box; min-width: 0; }
    .sidebar { width: 240px; background: var(--surface); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .tab-btn { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px; cursor: pointer; color: var(--muted); font-weight: 500; transition: all 0.2s; border: 1px solid transparent; background: transparent; width: 100%; text-align: left; }
    .tab-btn:hover { background: rgba(125,125,125,0.05); color: var(--fg); }
    .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: 0 4px 12px rgba(37,99,235,0.3); }
    .tab-btn:disabled { opacity: 0.38; cursor: not-allowed; filter: grayscale(1); box-shadow: none; }
    .tab-btn:disabled.active { background: transparent; color: var(--muted); border-color: transparent; box-shadow: none; }
    .tab-btn:disabled:hover { background: transparent; color: var(--muted); }
    .main-content { flex: 1; padding: 24px; overflow-y: auto; position: relative; min-width: 0; }
    .tab-pane { display: none; animation: fadeIn 0.2s ease-out; }
    .tab-pane.active { display: block; }
    .connection-down-view {
      display: none;
      align-items: center;
      justify-content: center;
      min-height: calc(100vh - 96px);
      padding: 28px 0;
    }
    .connection-down-card {
      max-width: 640px;
      width: 100%;
      text-align: center;
      padding: 34px 28px;
    }
    .connection-down-icon {
      font-size: 3rem;
      margin-bottom: 14px;
      display: block;
    }
    .connection-down-title {
      margin: 0 0 10px;
      font-size: 1.4rem;
    }
    .connection-down-copy {
      margin: 0;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.6;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    .spinner { width: 36px; height: 36px; border-radius: 50%; border: 4px solid rgba(0,0,0,0.08); border-top-color: var(--accent); animation: spin 1s linear infinite; margin: 12px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 4px 6px var(--card-shadow); min-width: 0; }
    .class-card { display: flex; flex-direction: column; justify-content: space-between; min-height: 280px; transition: transform 0.22s ease, box-shadow 0.22s ease; }
    .class-card:hover { transform: translateY(-3px); box-shadow: 0 12px 28px rgba(2,6,23,0.35); }
    .class-card .class-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; }
    .class-card .class-meta-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top: 10px; }
    .class-card .class-meta-grid > div { font-size: 0.88rem; }
    .class-card .class-meta-grid .label { color: var(--muted); font-weight: 600; }
    .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; min-width: 0; gap: 12px; }
    .top-nav { width: 100%; }
    h1 { font-size: 1.5rem; font-weight: 700; color: var(--fg); margin: 0; }
    h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; color: var(--fg); }
    .form-group { margin-bottom: 16px; position: relative; }
    label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 0.9rem; color: var(--muted); }
    input[type="text"], input[type="number"], input[type="date"], input[type="time"], select { width: 100%; padding: 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border); color: var(--fg); font-size: 0.95rem; min-height: 42px; min-width: 0; }
    input[type="date"] {
      color-scheme: dark light;
      cursor: pointer;
      position: relative;
      user-select: none;
      -webkit-user-select: none;
      -moz-user-select: none;
      -ms-user-select: none;
      caret-color: transparent;
    }
    input[type="time"] {
      color-scheme: dark light;
      cursor: pointer;
    }
    input[type="time"]::-webkit-datetime-edit,
    input[type="time"]::-webkit-datetime-edit-hour-field,
    input[type="time"]::-webkit-datetime-edit-minute-field,
    input[type="time"]::-webkit-datetime-edit-ampm-field {
      color: var(--fg);
    }
    input[type="date"]::-webkit-datetime-edit,
    input[type="date"]::-webkit-datetime-edit-text,
    input[type="date"]::-webkit-datetime-edit-month-field,
    input[type="date"]::-webkit-datetime-edit-day-field,
    input[type="date"]::-webkit-datetime-edit-year-field {
      color: var(--fg);
    }
    input[type="date"]:invalid::-webkit-datetime-edit {
      color: var(--muted);
    }
    /* WebKit CSS-only strategy: make picker indicator cover the full input area. */
    input[type="date"]::-webkit-calendar-picker-indicator {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      cursor: pointer;
      background: transparent;
      color: transparent;
      opacity: 0.01;
      filter: var(--date-icon-filter);
    }
    input:focus { outline: 2px solid var(--accent); border-color: transparent; }
    .search-container { position: relative; }
    .search-container input[type="text"] { padding-right: 40px; }
    .search-container .clear-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 0.95rem; padding: 4px; }
    .search-meta { display:flex; gap:8px; align-items:center; font-size:0.95rem; color:var(--muted); }
    .search-meta #log-count { color: var(--muted); font-weight:600; }
    .dropdown-list { position: absolute; top: 100%; left: 0; right: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 0 0 8px 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); max-height: 250px; overflow-y: auto; z-index: 50; display: none; margin-top: 4px; min-width: 0; }
    .dropdown-list.show { display: block; }
    .dropdown-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: 0.9rem; color: var(--fg); overflow-wrap: anywhere; word-break: break-word; }
    .dropdown-item:last-child { border-bottom: none; }
    .dropdown-item:hover { background: rgba(125,125,125,0.05); color: var(--accent); }
    .event { background: rgba(125,125,125,0.03); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid var(--border); min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
    .event.paste { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.05); }
    .event.fast { border-left-color: #8b5cf6; background: rgba(139, 92, 246, 0.05); }
    .meta { color: var(--muted); font-size: 0.85rem; margin-top: 4px; overflow-wrap: anywhere; word-break: break-word; }
    .btn { padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; border: none; transition: transform 0.1s; }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: var(--accent); color: white; }
    .btn-secondary { background: var(--bg); border: 1px solid var(--border); color: var(--muted); }
    #hamburger { display: none; }
    .btn-danger { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); }
    #logs-view { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 20px; }
    #dashboard-view { margin-top: 20px; }
    .meeting-day-label { display:inline-flex; align-items:center; gap:6px; margin:0; padding:6px 10px; border:1px solid var(--border); border-radius:999px; background:var(--bg); cursor:pointer; transition: background 0.2s ease, border-color 0.2s ease; font-size:0.9rem; color:var(--fg); user-select:none; }
    .meeting-day-label:hover { background: rgba(59,130,246,0.08); }
    .meeting-day-label input { appearance:none; width:16px; height:16px; border-radius:4px; border:1px solid var(--border); background:transparent; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
    .meeting-day-label input:checked { background: var(--accent); border-color: var(--accent); }
    .meeting-day-label input:checked::after { content:''; width:8px; height:8px; border-radius:2px; background:white; display:block; }
    .meeting-day-label input:focus-visible, .meeting-day-label:focus-visible { outline: none; }
    .meeting-day-label.focused { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.35); background: rgba(37, 99, 235, 0.12); }
    /* Deletions responsive rows */
    .deletion-row { display:flex; flex-direction:column; gap:8px; }
    .deletion-row .meta { margin-top:0; }
    @media (min-width:700px) {
      .deletion-row { flex-direction:row; justify-content:space-between; align-items:center; }
    }
    /* Responsive: collapse sidebar into hamburger for small widths */
    @media (max-width:865px) {
      /* position sidebar below the fixed top-nav so it doesn't get covered */
        .sidebar { display: none; position: fixed; left: 0; top: 0; height: 100%; width: 240px; transform: translateX(-100%); transition: transform 220ms ease; z-index: 150; }
        .sidebar.open { display: flex; transform: translateX(0); z-index: 240; }
      #hamburger { display: inline-flex; align-items: center; justify-content: center; font-size: 18px; }
      .backdrop { display:none; }
      .backdrop.show { display:block; position:fixed; inset:0; background: rgba(0,0,0,0.45); z-index: 210; }
      .main-content { padding: 16px; }
      /* make the small-screen top nav fixed so hamburger+theme stay visible while scrolling
        and page content scrolls underneath it. */
      .top-nav { position: fixed; top: 0; left: 0; right: 0; width: 100%; height: 56px; z-index: 220; display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; background: var(--surface); box-shadow: 0 6px 18px rgba(2,6,23,0.18); backdrop-filter: blur(6px); border-bottom: 1px solid rgba(0,0,0,0.06); }
      /* ensure page content sits under the fixed nav (avoid overlap) */
      .main-content { padding-top: calc(16px + 56px); }
      /* keep sidebar underneath the top nav when opened */
      .sidebar { top: 0; z-index: 150; }
    }
    /* Extra small screens: stack dashboard cards one-per-row */
    @media (max-width:579px) {
      .top-cards { grid-template-columns: 1fr !important; gap: 10px !important; }
      .stats-row { grid-template-columns: 1fr !important; gap: 10px !important; }
      /* make cards full width and allow auto height */
      .top-cards .card, .stats-row .card, .card { width: 100% !important; min-width: auto !important; height: auto !important; }
      /* slightly reduce padding to fit narrow screens */
      .card { padding: 12px !important; }
    }
    pre { white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
    @media (max-width: 700px) {
      .main-content { padding: 16px; }
      .card { padding: 16px; }
      .header-row { flex-direction: column; align-items: stretch; }
    }
  </style>
</head>
<body>

  <div class="app-container">
    ${sidebarHtml}

    <main class="main-content">
      <div class="top-nav" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <button id="hamburger" class="btn btn-secondary" style="min-width:40px; height:36px; padding:6px 8px; border-radius:8px;">☰</button>
          <div></div>
        </div>
      </div>

      <div id="connection-down-view" class="connection-down-view">
        <div class="card connection-down-card">
          <span class="connection-down-icon">☁️</span>
          <h2 class="connection-down-title">Server unavailable</h2>
          <p class="connection-down-copy">The connection to the server has been lost, try again later.</p>
        </div>
      </div>

      <div id="connection-down-view" class="connection-down-view">
        <div class="card connection-down-card">
          <span class="connection-down-icon">☁️</span>
          <h2 class="connection-down-title">Server unavailable</h2>
          <p class="connection-down-copy">The connection to the server has been lost, try again later.</p>
        </div>
      </div>

      ${dashboardHtml}
      ${logsHtml}
      ${deletionsHtml}
      ${settingsHtml}
      ${classHtml}

    </main>
  </div>

  <script nonce="${nonce}" src="${renderersUri}"></script>
  <script nonce="${nonce}">window.__TBD_THEME_PREFERENCE__ = '${themePreference}';</script>
  <script nonce="${nonce}">window.__TBD_TEACHER_API_ONLINE__ = ${apiOnline ? 'true' : 'false'};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {text += possible.charAt(Math.floor(Math.random() * possible.length));}
  return text;
}