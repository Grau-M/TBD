import * as vscode from 'vscode';
import { storageManager } from './state';

let panel: vscode.WebviewPanel | undefined;
let sessionPassword: string | undefined;

export async function openTeacherView(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }

    // Prompt for session password when opening the teacher view
    const initialPassword = await vscode.window.showInputBox({
        prompt: `Enter Administrator Password to open Teacher Dashboard`,
        password: true,
        ignoreFocusOut: true
    });

    if (!initialPassword) {
        // user cancelled; do not open the view
        return;
    }

    sessionPassword = initialPassword;

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
        sessionPassword = undefined; // clear session password when panel closed
    }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async message => {
        try {
            // --- LOG HANDLING ---
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

                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ 
                        prompt: `Enter Administrator Password to view ${filename}`, 
                        password: true, 
                        ignoreFocusOut: true 
                    });

                    if (!password) {
                        panel?.webview.postMessage({ command: 'error', message: 'Password required' });
                        return;
                    }
                    // store for session
                    sessionPassword = password;
                }

                try {
                    const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
                    const content = res.text;
                    const partial = res.partial;

                    let parsed: any = null;
                    try { 
                        parsed = JSON.parse(content); 
                    } catch {
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
                        let safe = String(content);
                        safe = safe.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '\uFFFD');
                        if (safe.length > 200_000) safe = safe.slice(0, 200_000) + '\n\n[truncated]';
                        panel?.webview.postMessage({ command: 'rawData', filename, data: safe, partial });
                    }
                } catch (err: any) {
                    panel?.webview.postMessage({ command: 'error', message: String(err) });
                }
            }

            // --- DASHBOARD ANALYSIS (decrypt & aggregate all logs) ---
            if (message.command === 'analyzeLogs') {
                const files = await storageManager.listLogFiles();
                if (!files || files.length === 0) {
                    panel?.webview.postMessage({ command: 'dashboardData', data: { totalLogs: 0, totalEvents: 0 } });
                    return;
                }

                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({
                        prompt: `Enter Administrator Password to analyze all logs`,
                        password: true,
                        ignoreFocusOut: true
                    });

                    if (!password) {
                        panel?.webview.postMessage({ command: 'error', message: 'Password required for analysis' });
                        return;
                    }
                    sessionPassword = password;
                }

                const aggregate: any = {
                    totalLogs: files.length,
                    totalEvents: 0,
                    pasteCount: 0,
                    deleteCount: 0,
                    keystrokeCount: 0,
                    pasteLengths: [],
                    partialCount: 0,
                    perFile: []
                };

                for (const f of files) {
                    try {
                        const res = await storageManager.retrieveLogContentWithPassword(password, f.uri);
                        const content = res.text;
                        if (res.partial) aggregate.partialCount++;

                        let parsed: any = null;
                        try { parsed = JSON.parse(content); } catch {
                            try {
                                const s = content.indexOf('{');
                                const e = content.lastIndexOf('}');
                                if (s !== -1 && e > s) parsed = JSON.parse(content.slice(s, e + 1));
                            } catch (_) { parsed = null; }
                        }

                        const fileStats: any = { name: f.label, events: 0, paste: 0, delete: 0, keystrokes: 0, avgPasteLength: 0 };

                        if (parsed && Array.isArray(parsed.events)) {
                            fileStats.events = parsed.events.length;
                            for (const e of parsed.events) {
                                const t = (e.eventType || '').toString().toLowerCase();
                                // paste
                                if (t === 'paste' || t === 'clipboard' || t === 'pasteevent') {
                                    fileStats.paste++;
                                    const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : (typeof e.text === 'string' ? e.text.length : 0));
                                    if (len && len > 0) aggregate.pasteLengths.push(len);
                                }
                                // deletes/backspace
                                if (t === 'delete' || t === 'deletion' || t === 'backspace') {
                                    fileStats.delete++;
                                }
                                // treat key/keystroke events (best-effort)
                                if (t === 'key' || t === 'keystroke' || t === 'keypress' || t === 'input') {
                                    fileStats.keystrokes++;
                                }
                            }

                            aggregate.totalEvents += fileStats.events;
                            aggregate.pasteCount += fileStats.paste;
                            aggregate.deleteCount += fileStats.delete;
                            aggregate.keystrokeCount += fileStats.keystrokes;
                        }

                        aggregate.perFile.push(fileStats);
                    } catch (err: any) {
                        // skip file but record partial/failed
                        aggregate.perFile.push({ name: f.label, error: String(err) });
                    }
                }

                // compute derived metrics
                const total = aggregate.totalEvents || 1;
                const pasteRatio = Math.min(1, aggregate.pasteCount / total);
                const deleteRatio = Math.min(1, aggregate.deleteCount / total);
                const avgPasteLength = aggregate.pasteLengths.length ? (aggregate.pasteLengths.reduce((a: number, b: number) => a + b, 0) / aggregate.pasteLengths.length) : 0;

                // Simple heuristic for AI probability (0-100)
                // More/larger pastes increase probability. This is a heuristic, not a verdict.
                const normalizedPasteLen = Math.min(1, avgPasteLength / 1000); // 1000 chars -> 1.0
                let score = (pasteRatio * 0.6 + normalizedPasteLen * 0.35 + deleteRatio * 0.05) * 100;
                score = Math.max(0, Math.min(100, Math.round(score)));

                aggregate.metrics = {
                    pasteRatio: Math.round(pasteRatio * 1000) / 10,
                    deleteRatio: Math.round(deleteRatio * 1000) / 10,
                    avgPasteLength: Math.round(avgPasteLength),
                    aiProbability: score
                };

                panel?.webview.postMessage({ command: 'dashboardData', data: aggregate });
            }

            // --- SETTINGS HANDLING ---
            if (message.command === 'getSettings') {
                const current = context.globalState.get('tbdSettings', {
                    inactivityThreshold: 5,
                    flightTimeThreshold: 50,
                    pasteLengthThreshold: 50
                });
                panel?.webview.postMessage({ command: 'loadSettings', settings: current });
            }

            if (message.command === 'saveSettings') {
                await context.globalState.update('tbdSettings', message.settings);
                panel?.webview.postMessage({ command: 'settingsSaved', success: true });
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
        --bg: #f7fafc; --surface: #ffffff; --muted: #4b5563; --fg: #0f1724; 
        --border: rgba(0,0,0,0.1); --card-shadow: rgba(2,6,23,0.06); 
        --accent: #2563eb; --accent-2:#7c3aed; 
    }
    .dark, :root.dark { 
        --bg: #071021; --surface: #0b1220; --muted: #9aa4b2; --fg: #e6eef8; 
        --border: rgba(255,255,255,0.08); --card-shadow: rgba(2,6,23,0.6); 
        --accent: #3b82f6; --accent-2:#8b5cf6; 
    }

    body { background: var(--bg); color: var(--fg); height: 100vh; overflow: hidden; display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    
    .app-container { display: flex; height: 100%; max-width: none; margin: 0; width: 100%; box-sizing: border-box; }
    
    .sidebar { width: 240px; background: var(--surface); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 8px; }
    .tab-btn { 
        display: flex; align-items: center; gap: 10px; padding: 10px 14px; 
        border-radius: 8px; cursor: pointer; color: var(--muted); 
        font-weight: 500; transition: all 0.2s; border: 1px solid transparent; 
        background: transparent; width: 100%; text-align: left;
    }
    .tab-btn:hover { background: rgba(125,125,125,0.05); color: var(--fg); }
    .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: 0 4px 12px rgba(37,99,235,0.3); }
    
    .main-content { flex: 1; padding: 24px; overflow-y: auto; position: relative; }
    .tab-pane { display: none; animation: fadeIn 0.2s ease-out; }
    .tab-pane.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

    /* simple spinner */
    .spinner { width: 36px; height: 36px; border-radius: 50%; border: 4px solid rgba(0,0,0,0.08); border-top-color: var(--accent); animation: spin 1s linear infinite; margin: 12px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 4px 6px var(--card-shadow); }
    .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    h1 { font-size: 1.5rem; font-weight: 700; color: var(--fg); margin: 0; }
    h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; color: var(--fg); }
    
    .form-group { margin-bottom: 16px; position: relative; }
    label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 0.9rem; color: var(--muted); }
    
    input[type="text"], input[type="number"], select { 
        width: 100%; padding: 10px; border-radius: 8px; 
        background: var(--bg); border: 1px solid var(--border); 
        color: var(--fg); font-size: 0.95rem; 
    }
    input:focus { outline: 2px solid var(--accent); border-color: transparent; }
    
    /* Dropdown Styling */
    .search-container { position: relative; }
    .dropdown-list {
        position: absolute;
        top: 100%; left: 0; right: 0;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 0 0 8px 8px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.1);
        max-height: 250px;
        overflow-y: auto;
        z-index: 50;
        display: none; 
        margin-top: 4px;
    }
    .dropdown-list.show { display: block; }
    .dropdown-item {
        padding: 10px 14px;
        cursor: pointer;
        border-bottom: 1px solid var(--border);
        font-size: 0.9rem;
        color: var(--fg);
    }
    .dropdown-item:last-child { border-bottom: none; }
    .dropdown-item:hover { background: rgba(125,125,125,0.05); color: var(--accent); }
    
    /* Event Styling */
    .event { background: rgba(125,125,125,0.03); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid var(--border); }
    .event.paste { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.05); } 
    .event.fast { border-left-color: #8b5cf6; background: rgba(139, 92, 246, 0.05); } 
    .meta { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }
    
    .btn { padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; border: none; transition: transform 0.1s; }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: var(--accent); color: white; }
    .btn-secondary { background: var(--bg); border: 1px solid var(--border); color: var(--muted); }
    .btn-danger { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); }

    /* theme toggle is placed in the top bar; no absolute positioning to avoid overlap */
    
    /* View Containers */
    #logs-view { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 20px; }
    #dashboard-view { margin-top: 20px; }
  </style>
</head>
<body>

  <div class="app-container">
    
    <aside class="sidebar">
      <div style="margin-bottom: 20px; padding: 0 10px;">
        <h1 style="font-size:1.2rem;">Teacher View</h1>
        <div class="meta">Capstone Integrity Tool</div>
      </div>
      
      <button id="nav-dashboard" class="tab-btn active">
        <span>📊</span> Dashboard
      </button>
      <button id="nav-logs" class="tab-btn">
        <span>📂</span> Logs
      </button>
      <button id="nav-settings" class="tab-btn">
        <span>⚙️</span> Settings
      </button>

      <div style="margin-top:auto; padding:10px;">
        <div id="status" class="meta" style="font-size:0.8rem;">Ready</div>
      </div>
    </aside>

        <main class="main-content">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div></div>
                <button id="themeToggle" class="btn btn-secondary" style="min-width:40px; height:36px; padding:6px 8px; border-radius:8px;">🌓</button>
            </div>

      <div id="dashboard-tab" class="tab-pane active">
        <div class="header-row">
          <h1>Analysis Dashboard</h1>
          <div class="meta" id="dashboard-log-name">No log loaded</div>
        </div>

        <div id="dashboard-empty" class="card" style="text-align:center; padding: 40px;">
          <h2 style="color:var(--muted)">No Session Data Loaded</h2>
          <p class="meta">Select a student log from the <strong>Logs</strong> tab to view integrity analysis.</p>
          <button id="btn-goto-logs" class="btn btn-primary" style="margin-top:16px;">Find Student Log</button>
        </div>

        <div id="dashboard-view"></div>
      </div>

      <div id="logs-tab" class="tab-pane">
        <div class="header-row">
          <h1>Session Logs</h1>
        </div>

        <div class="card">
          <div class="form-group search-container">
            <label>Search Student Logs</label>
            <input id="log-search-input" type="text" placeholder="Start typing a name (e.g. 'john')..." autocomplete="off" />
            <div id="log-dropdown" class="dropdown-list"></div>
            <div class="meta" style="margin-top:8px;">
               <span id="log-count">Loading logs...</span>
               <button id="refresh-logs" style="background:none; border:none; color:var(--accent); cursor:pointer; margin-left:10px; font-size:0.85rem;">Refresh List</button>
            </div>
          </div>
        </div>

        <div id="logs-viewer-container" style="display:none;">
            <div class="header-row" style="margin-bottom:10px;">
                <h2 id="logs-log-name" style="margin:0;">Event Log</h2>
                <button id="close-log" class="btn btn-secondary" style="font-size:0.8rem; padding:4px 10px;">Close</button>
            </div>
            <div id="logs-view"></div>
        </div>

      </div>

      <div id="settings-tab" class="tab-pane">
        <div class="header-row">
          <h1>Configuration</h1>
        </div>
        <div class="card">
          <h2>Analysis Thresholds</h2>
          <p class="meta" style="margin-bottom:16px;">Adjust how the system flags suspicious behavior.</p>
          
          <div class="form-group">
            <label>Inactivity Threshold (minutes)</label>
            <input type="number" id="inactivityInput" value="5" min="1" max="60" />
            <div class="meta">Time before a student is considered "Away".</div>
          </div>
          
          <div class="form-group">
            <label>Flight Time Filter (ms)</label>
            <input type="number" id="flightInput" value="50" min="0" max="500" />
            <div class="meta">Keystrokes faster than this are flagged as potential copy/pastes.</div>
          </div>

          <div class="form-group">
            <label>Paste Length Flag (chars)</label>
            <input type="number" id="pasteLengthInput" value="50" min="1" max="10000" />
            <div class="meta">Pastes longer than this will be visually flagged.</div>
          </div>

          <div style="display:flex; gap:10px; margin-top:24px; border-top:1px solid var(--border); padding-top:20px;">
            <button id="saveSettings" class="btn btn-primary">Save Changes</button>
            <button id="resetSettings" class="btn btn-danger">Reset to Defaults</button>
          </div>
          <div id="settings-msg" class="meta" style="margin-top:10px; height:20px;"></div>
        </div>
      </div>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    // --- State ---
    let logNamesCache = [];
    const defaults = { inactivity: 5, flight: 50, pasteLength: 50 };
    let currentSettings = { ...defaults };

    // --- DOM Elements ---
    const searchInput = document.getElementById('log-search-input');
    const dropdown = document.getElementById('log-dropdown');
    const logCountLabel = document.getElementById('log-count');
    const refreshBtn = document.getElementById('refresh-logs');
    const status = document.getElementById('status');
    
    // Dashboard Elements
    const dashboardView = document.getElementById('dashboard-view');
    const dashboardEmpty = document.getElementById('dashboard-empty');
    const dashboardLogName = document.getElementById('dashboard-log-name');

    // Logs Elements
    const logsView = document.getElementById('logs-view');
    const logsViewerContainer = document.getElementById('logs-viewer-container');
    const logsLogName = document.getElementById('logs-log-name');
    
    // Settings Elements
    const inactivityInput = document.getElementById('inactivityInput');
    const flightInput = document.getElementById('flightInput');
    const pasteLengthInput = document.getElementById('pasteLengthInput');
    const settingsMsg = document.getElementById('settings-msg');

    // --- Tab Logic ---
    function switchTab(tabName) {
        document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        const pane = document.getElementById(tabName + '-tab');
        if (pane) pane.classList.add('active');
        const btn = document.getElementById('nav-' + tabName);
        if (btn) btn.classList.add('active');
    }
    
    document.getElementById('nav-dashboard').addEventListener('click', () => {
        switchTab('dashboard');
        try { dashboardLogName.textContent = 'Analyzing logs...'; } catch (e) {}
        try { showDashboardLoading(); } catch (e) { /* ignore */ }
        vscode.postMessage({ command: 'analyzeLogs' });
    });
    document.getElementById('nav-logs').addEventListener('click', () => { switchTab('logs'); vscode.postMessage({ command: 'listLogs' }); });
    document.getElementById('nav-settings').addEventListener('click', () => switchTab('settings'));
    document.getElementById('btn-goto-logs').addEventListener('click', () => switchTab('logs'));

    document.getElementById('close-log').addEventListener('click', () => {
        logsViewerContainer.style.display = 'none';
        logsView.innerHTML = '';
        logsLogName.textContent = '';
        searchInput.value = ''; 
    });

    const themeToggle = document.getElementById('themeToggle');
    // restore persisted theme from webview state if present
    const _state = vscode.getState ? vscode.getState() : {};
    let isDark = (_state && _state.theme === 'dark') || document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) document.documentElement.classList.add('dark');
    // set initial icon
    if (themeToggle) themeToggle.textContent = isDark ? '🌙' : '☀️';
    if (themeToggle) themeToggle.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        isDark = !isDark;
        themeToggle.textContent = isDark ? '🌙' : '☀️';
        if (vscode.setState) vscode.setState({ theme: isDark ? 'dark' : 'light' });
    });

    function renderDropdown(items) {
        dropdown.innerHTML = '';
        if (items.length === 0) {
            dropdown.innerHTML = '<div class="dropdown-item" style="cursor:default; color:var(--muted);">No logs found</div>';
            return;
        }
        
        items.forEach(name => {
            const div = document.createElement('div');
            div.className = 'dropdown-item';
            div.textContent = name;
            div.addEventListener('mousedown', (e) => {
                 e.preventDefault(); 
                 openLogFile(name);
            });
            dropdown.appendChild(div);
        });
    }

    function openLogFile(filename) {
        searchInput.value = filename;
        dropdown.classList.remove('show');
        status.textContent = 'Decrypting ' + filename + '...';
        vscode.postMessage({ command: 'openLog', filename });
    }

    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const filtered = logNamesCache.filter(n => n.toLowerCase().includes(term));
        renderDropdown(filtered);
        dropdown.classList.add('show');
    });

    searchInput.addEventListener('focus', () => {
        const term = searchInput.value.toLowerCase();
        const filtered = logNamesCache.filter(n => n.toLowerCase().includes(term));
        renderDropdown(filtered);
        dropdown.classList.add('show');
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('show');
        }
    });

    refreshBtn.addEventListener('click', () => {
        status.textContent = 'Refreshing list...';
        vscode.postMessage({ command: 'listLogs' });
    });

    // --- MAIN RENDER LOGIC ---
    function renderParsed(parsed, filename) {
        // 1. CLEAR & SETUP
        dashboardView.innerHTML = ''; 
        logsView.innerHTML = '';
        
        dashboardEmpty.style.display = 'none'; 
        logsViewerContainer.style.display = 'block';

        dashboardLogName.textContent = 'Viewing: ' + filename;
        logsLogName.textContent = 'Event Log: ' + filename;
        
        // 2. CALCULATE SCORE
        let totalEvents = 0;
        let flaggedEvents = 0;
        let integrityScore = 100;

        if (Array.isArray(parsed.events)) {
            totalEvents = parsed.events.length;
            parsed.events.forEach(e => {
                let flagged = false;
                if (e.eventType === 'paste') {
                    const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : null);
                    if (len !== null && len > currentSettings.pasteLength) flagged = true;
                    else if (len === null) flagged = true; 
                }
                if (e.eventType === 'input' && e.flightTime && parseInt(e.flightTime) < currentSettings.flight) {
                    flagged = true;
                }
                if(flagged) flaggedEvents++;
            });

            if (totalEvents > 0) {
                const ratio = flaggedEvents / totalEvents;
                integrityScore = Math.max(0, Math.round((1 - ratio) * 100));
            }
        }

        let scoreColor = '#10b981'; // Green
        if (integrityScore < 85) scoreColor = '#f59e0b'; // Yellow
        if (integrityScore < 50) scoreColor = '#ef4444'; // Red

        // 3. RENDER DASHBOARD (Score + Summary ONLY)
        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'card';
        scoreDiv.style.borderLeft = '6px solid ' + scoreColor;
        scoreDiv.innerHTML = \`
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <h2 style="margin:0; font-size:2rem; color:\${scoreColor}">\${integrityScore}%</h2>
                    <div class="meta" style="font-size:1rem;">Integrity Score</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-weight:600; font-size:1.2rem;">\${flaggedEvents} <span style="font-weight:400; color:var(--muted)">/ \${totalEvents}</span></div>
                    <div class="meta">Flagged Events</div>
                </div>
            </div>
            <div class="meta" style="margin-top:12px; border-top:1px solid var(--border); padding-top:8px;">
                Score affected by <strong style="color:#f59e0b">Suspicious Pastes (> \${currentSettings.pasteLength} chars)</strong> and <strong style="color:#8b5cf6">Fast Typing (< \${currentSettings.flight}ms)</strong>.
            </div>
        \`;
        dashboardView.appendChild(scoreDiv);

        // Render Session Header (Shared Info) in Dashboard
        if (parsed.sessionHeader) {
            const h = parsed.sessionHeader;
            const headerDiv = document.createElement('div');
            headerDiv.className = 'card';
            headerDiv.innerHTML = \`
                <div style="display:flex; justify-content:space-between;">
                    <div>
                        <h2>Session \${h.sessionNumber || ''}</h2>
                        <div class="meta">User: \${h.startedBy || 'N/A'}</div>
                        <div class="meta">Workspace: \${h.project || 'N/A'}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="meta">\${h.startTime ? new Date(h.startTime).toLocaleString() : ''}</div>
                        <div class="meta">VS Code: \${h.metadata?.vscodeVersion || 'N/A'}</div>
                    </div>
                </div>
            \`;
            dashboardView.appendChild(headerDiv);
        }

        // 4. RENDER LOGS (Detailed List ONLY)
        if (Array.isArray(parsed.events)) {
            const container = document.createElement('div');
            parsed.events.slice().reverse().forEach(e => {
                const row = document.createElement('div');
                let className = 'event';
                let flagReason = '';

                // Paste Flag
                if (e.eventType === 'paste') {
                    const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : null);
                    if (len !== null && len > currentSettings.pasteLength) {
                        className += ' paste';
                        flagReason = '(Large Paste)';
                    } else if (len === null) {
                        className += ' paste'; 
                    }
                }
                // Flight Flag
                if (e.eventType === 'input' && e.flightTime && parseInt(e.flightTime) < currentSettings.flight) {
                    className += ' fast';
                    flagReason = '(Fast Input)';
                }
                
                row.className = className;
                
                let html = \`
                    <div style="display:flex; justify-content:space-between;">
                        <div>
                            <strong>\${e.eventType || 'Unknown'}</strong> \${flagReason}
                        </div>
                        <span class="meta">\${e.time || ''}</span>
                    </div>
                \`;
                
                Object.keys(e).forEach(k => {
                    if (!['eventType', 'time'].includes(k)) {
                        html += \`<div class="meta">\${k}: \${JSON.stringify(e[k])}</div>\`;
                    }
                });
                
                row.innerHTML = html;
                container.appendChild(row);
            });
            logsView.appendChild(container);
        }
    }

    function renderDashboard(data) {
        const container = document.getElementById('dashboard-view');
        // hide the empty placeholder when rendering dashboard content
        if (dashboardEmpty) dashboardEmpty.style.display = 'none';
        // update header to reflect aggregated results
        try {
            if (data && typeof data.totalLogs === 'number') {
                dashboardLogName.textContent = \`Analyzed: \${data.totalLogs} logs\`;
            } else {
                dashboardLogName.textContent = 'No log loaded';
            }
        } catch (e) {}
        container.innerHTML = '';
        if (!data || !data.metrics) {
            container.innerHTML = '<div class="meta">No data available.</div>';
            return;
        }

        const m = data.metrics;

        const top = document.createElement('div');
        top.style.display = 'grid';
        top.style.gridTemplateColumns = '1fr 1fr 1fr';
        top.style.gap = '12px';

        const makeCard = (title, value, subtitle) => {
            const c = document.createElement('div');
            c.className = 'card';
            c.style.padding = '12px';
            c.innerHTML = '<div style="font-weight:700; font-size:1.1rem;">' + value + '</div><div class="meta">' + title + (subtitle ? ' • ' + subtitle : '') + '</div>';
            return c;
        };

        top.appendChild(makeCard('AI Probability', m.aiProbability + '%'));
        top.appendChild(makeCard('Paste %', m.pasteRatio + '%', 'of all events'));
        top.appendChild(makeCard('Delete %', m.deleteRatio + '%', 'of all events'));

        const statsRow = document.createElement('div');
        statsRow.style.display = 'flex';
        statsRow.style.gap = '12px';
        statsRow.style.marginTop = '12px';

        const avgPaste = makeCard('Avg Paste Length', m.avgPasteLength + ' chars');
        const totals = makeCard('Totals', data.totalLogs + ' logs • ' + data.totalEvents + ' events');
        statsRow.appendChild(avgPaste);
        statsRow.appendChild(totals);

        // AI progress bar
        const barCard = document.createElement('div');
        barCard.className = 'card';
        barCard.style.padding = '12px';
        barCard.innerHTML = '<div style="font-weight:700; margin-bottom:8px;">AI Probability</div>';
        const barOuter = document.createElement('div');
        barOuter.style.background = 'var(--bg)';
        barOuter.style.border = '1px solid var(--border)';
        barOuter.style.borderRadius = '8px';
        barOuter.style.height = '18px';
        const barInner = document.createElement('div');
        barInner.style.height = '100%';
        barInner.style.width = m.aiProbability + '%';
        barInner.style.background = 'linear-gradient(90deg, var(--accent), var(--accent-2))';
        barInner.style.borderRadius = '8px';
        barOuter.appendChild(barInner);
        barCard.appendChild(barOuter);

        container.appendChild(top);
        container.appendChild(statsRow);
        container.appendChild(barCard);

        // Per-file breakdown
        const filesCard = document.createElement('div');
        filesCard.className = 'card';
        filesCard.style.marginTop = '12px';
        filesCard.innerHTML = '<h2>Per-file breakdown</h2>';
        const table = document.createElement('div');
        table.style.display = 'grid';
        table.style.gridTemplateColumns = '2fr 1fr 1fr 1fr';
        table.style.gap = '8px';
        table.style.marginTop = '8px';
        table.innerHTML = '<div style="font-weight:700">File</div><div style="font-weight:700">Events</div><div style="font-weight:700">Paste</div><div style="font-weight:700">Delete</div>';

        (data.perFile || []).forEach(f => {
            const name = document.createElement('div');
            name.textContent = f.name || (f.error ? '(failed)' : 'unknown');
            const ev = document.createElement('div'); ev.textContent = f.events ? String(f.events) : '-';
            const p = document.createElement('div'); p.textContent = f.events ? (Math.round((f.paste||0) / Math.max(1,f.events) * 1000)/10) + '%' : (f.error ? 'err' : '-');
            const d = document.createElement('div'); d.textContent = f.events ? (Math.round((f.delete||0) / Math.max(1,f.events) * 1000)/10) + '%' : (f.error ? 'err' : '-');
            table.appendChild(name); table.appendChild(ev); table.appendChild(p); table.appendChild(d);
        });

        filesCard.appendChild(table);
        container.appendChild(filesCard);
    }

    function showDashboardLoading() {
        const container = document.getElementById('dashboard-view');
        // hide the empty placeholder while loading
        if (dashboardEmpty) dashboardEmpty.style.display = 'none';
        if (!container) return;
        container.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'card';
        card.style.textAlign = 'center';
        card.innerHTML = '<div style="font-weight:700; margin-bottom:8px;">Loading dashboard</div>';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        card.appendChild(spinner);
        container.appendChild(card);
    }

    // renderOptions removed — dropdown approach is used via renderDropdown

    // --- Action Listeners ---
    const refreshDashboardBtn = document.getElementById('refreshDashboard');
    if (refreshDashboardBtn) refreshDashboardBtn.addEventListener('click', () => {
        if (status) status.textContent = 'Analyzing logs...';
        showDashboardLoading();
        vscode.postMessage({ command: 'analyzeLogs' });
    });

    document.getElementById('saveSettings').addEventListener('click', () => {
        const settings = {
            inactivityThreshold: parseInt(inactivityInput.value),
            flightTimeThreshold: parseInt(flightInput.value),
            pasteLengthThreshold: parseInt(pasteLengthInput.value)
        };
        vscode.postMessage({ command: 'saveSettings', settings });
    });

    document.getElementById('resetSettings').addEventListener('click', () => {
        inactivityInput.value = defaults.inactivity;
        flightInput.value = defaults.flight;
        pasteLengthInput.value = defaults.pasteLength;
        vscode.postMessage({ command: 'saveSettings', settings: defaults });
    });

    // --- Message Handling ---
    // --- Messages ---
    window.addEventListener('message', event => {
        const msg = event.data;

        switch (msg.command) {
            case 'logList':
                logNamesCache = msg.data.sort().reverse();
                logCountLabel.textContent = logNamesCache.length + ' logs found';
                // populate dropdown with the latest list (do not change the user's current tab)
                renderDropdown(logNamesCache);
                break;
            case 'logData':
                renderParsed(msg.data, msg.filename);
                status.textContent = 'Loaded ' + msg.filename;
                break;
            case 'dashboardData':
                renderDashboard(msg.data);
                status.textContent = 'Dashboard updated';
                break;
            case 'rawData':
                // For raw data, we just dump it in logs view
                logsViewerContainer.style.display = 'block';
                logsView.innerHTML = '<pre>' + msg.data + '</pre>';
                dashboardView.innerHTML = '<div class="card"><h2>Raw Data Only</h2><p class="meta">Score unavailable.</p></div>';
                status.textContent = 'Loaded ' + msg.filename;
                break;
            case 'loadSettings':
                if (msg.settings) {
                    currentSettings = {
                        inactivity: msg.settings.inactivityThreshold || defaults.inactivity,
                        flight: msg.settings.flightTimeThreshold || defaults.flight,
                        pasteLength: msg.settings.pasteLengthThreshold || defaults.pasteLength
                    };
                    inactivityInput.value = currentSettings.inactivity;
                    flightInput.value = currentSettings.flight;
                    pasteLengthInput.value = currentSettings.pasteLength;
                }
                break;
            case 'settingsSaved':
                currentSettings.inactivity = parseInt(inactivityInput.value);
                currentSettings.flight = parseInt(flightInput.value);
                currentSettings.pasteLength = parseInt(pasteLengthInput.value);
                settingsMsg.textContent = 'Settings saved successfully!';
                setTimeout(() => settingsMsg.textContent = '', 3000);
                break;
            case 'error':
                status.textContent = 'Error: ' + msg.message;
                break;
        }
    });

    // --- Init ---
    // Ensure UI shows dashboard only and clear unexpected persisted state
    try { switchTab('dashboard'); } catch (e) { /* ignore */ }
    // hide the default empty placeholder on init so it doesn't overlap loading UI
    try { if (dashboardEmpty) dashboardEmpty.style.display = 'none'; } catch (e) {}
    if (vscode.setState) try { vscode.setState({ theme: isDark ? 'dark' : 'light' }); } catch (e) { /* ignore */ }
    // Load dashboard with a loading indicator; do not load logs until Logs tab is selected
    showDashboardLoading();
    vscode.postMessage({ command: 'analyzeLogs' });
    vscode.postMessage({ command: 'getSettings' });

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