import * as vscode from 'vscode';
import { storageManager } from './state';

let panel: vscode.WebviewPanel | undefined;
let sessionPassword: string | undefined;

export async function openTeacherView(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }

    // 1. Prompt for session password immediately
    const initialPassword = await vscode.window.showInputBox({
        prompt: `Enter Administrator Password to open Teacher Dashboard`,
        password: true,
        ignoreFocusOut: true
    });

    if (!initialPassword) {
        return; // User cancelled
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
        sessionPassword = undefined;
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

                // Use session password or prompt if missing
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
                        // Attempt partial recovery
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
                        // Fallback for raw text
                        let safe = String(content);
                        safe = safe.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '\uFFFD');
                        if (safe.length > 200_000) safe = safe.slice(0, 200_000) + '\n\n[truncated]';
                        panel?.webview.postMessage({ command: 'rawData', filename, data: safe, partial });
                    }
                } catch (err: any) {
                    panel?.webview.postMessage({ command: 'error', message: String(err) });
                }
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
    /* Theme Variables */
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
    
    .app-container { display: flex; height: 100%; width: 100%; }
    
    /* Sidebar */
    .sidebar { width: 240px; background: var(--surface); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 8px; }
    .tab-btn { 
        display: flex; align-items: center; gap: 10px; padding: 10px 14px; 
        border-radius: 8px; cursor: pointer; color: var(--muted); 
        font-weight: 500; transition: all 0.2s; border: 1px solid transparent; 
        background: transparent; width: 100%; text-align: left;
    }
    .tab-btn:hover { background: rgba(125,125,125,0.05); color: var(--fg); }
    .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: 0 4px 12px rgba(37,99,235,0.3); }
    
    /* Main Content */
    .main-content { flex: 1; padding: 24px; overflow-y: auto; position: relative; }
    .tab-pane { display: none; animation: fadeIn 0.2s ease-out; }
    .tab-pane.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

    /* Cards & Components */
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

    .theme-toggle { position: absolute; top: 20px; right: 20px; background: var(--surface); border: 1px solid var(--border); padding: 8px; border-radius: 50%; cursor: pointer; }
    
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
      <button id="themeToggle" class="theme-toggle">🌓</button>

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
            <input id="log-search-input" type="text" placeholder="Start typing a name..." autocomplete="off" />
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
    let isInitialLoad = true;

    // --- DOM Elements ---
    const searchInput = document.getElementById('log-search-input');
    const dropdown = document.getElementById('log-dropdown');
    const logCountLabel = document.getElementById('log-count');
    const refreshBtn = document.getElementById('refresh-logs');
    
    const dashboardView = document.getElementById('dashboard-view');
    const dashboardEmpty = document.getElementById('dashboard-empty');
    const dashboardLogName = document.getElementById('dashboard-log-name');

    const logsView = document.getElementById('logs-view');
    const logsViewerContainer = document.getElementById('logs-viewer-container');
    const logsLogName = document.getElementById('logs-log-name');
    
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
    
    document.getElementById('nav-dashboard').addEventListener('click', () => switchTab('dashboard'));
    document.getElementById('nav-logs').addEventListener('click', () => switchTab('logs'));
    document.getElementById('nav-settings').addEventListener('click', () => switchTab('settings'));
    document.getElementById('btn-goto-logs').addEventListener('click', () => switchTab('logs'));

    document.getElementById('close-log').addEventListener('click', () => {
        logsViewerContainer.style.display = 'none';
        logsView.innerHTML = '';
        logsLogName.textContent = '';
        searchInput.value = ''; 
    });

    // --- Dropdown Logic ---
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

    // --- RENDER LOGIC ---
    function renderParsed(parsed, filename) {
        // Clear & Setup
        dashboardView.innerHTML = ''; 
        logsView.innerHTML = '';
        dashboardEmpty.style.display = 'none'; 
        logsViewerContainer.style.display = 'block';
        dashboardLogName.textContent = 'Viewing: ' + filename;
        logsLogName.textContent = 'Event Log: ' + filename;
        
        // Calculate Score
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

        // Render Dashboard (Score Only)
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

        // Render Logs (Events Only)
        if (Array.isArray(parsed.events)) {
            const container = document.createElement('div');
            parsed.events.slice().reverse().forEach(e => {
                const row = document.createElement('div');
                let className = 'event';
                let flagReason = '';

                if (e.eventType === 'paste') {
                    const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : null);
                    if (len !== null && len > currentSettings.pasteLength) {
                        className += ' paste';
                        flagReason = '(Large Paste)';
                    } else if (len === null) className += ' paste'; 
                }
                if (e.eventType === 'input' && e.flightTime && parseInt(e.flightTime) < currentSettings.flight) {
                    className += ' fast';
                    flagReason = '(Fast Input)';
                }
                
                row.className = className;
                let html = \`
                    <div style="display:flex; justify-content:space-between;">
                        <div><strong>\${e.eventType || 'Unknown'}</strong> \${flagReason}</div>
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

    // --- Message Handling ---
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
            case 'logList':
                logNamesCache = msg.data.sort().reverse(); 
                logCountLabel.textContent = logNamesCache.length + ' logs found';
                if (isInitialLoad && logNamesCache.length > 0) {
                    isInitialLoad = false;
                    const latest = logNamesCache[0];
                    searchInput.value = latest; 
                    vscode.postMessage({ command: 'openLog', filename: latest });
                    switchTab('dashboard');
                } else if (isInitialLoad) {
                    isInitialLoad = false;
                    switchTab('dashboard');
                }
                break;
            case 'logData':
                renderParsed(msg.data, msg.filename);
                switchTab('dashboard');
                break;
            case 'rawData':
                logsViewerContainer.style.display = 'block';
                logsView.innerHTML = '<pre>' + msg.data + '</pre>';
                dashboardView.innerHTML = '<div class="card"><h2>Raw Data Only</h2><p class="meta">Score unavailable.</p></div>';
                switchTab('dashboard');
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
                // Only alert if it's not a harmless "cancelled" error
                if(!msg.message.includes('cancelled')) console.error(msg.message);
                break;
        }
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

    // Theme Toggle
    const themeToggle = document.getElementById('themeToggle');
    let isDark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) document.documentElement.classList.add('dark');
    themeToggle.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        isDark = !isDark;
    });

    // Init
    vscode.postMessage({ command: 'listLogs' });
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