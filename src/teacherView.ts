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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Teacher Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px; }
    #logs { margin-bottom: 12px; }
    select { width: 60%; }
    .event { border: 1px solid #ddd; padding: 8px; margin: 6px 0; border-radius: 4px; }
    .header { background:#f6f6f6; padding:8px; border-radius:4px; margin-bottom:12px }
    .meta { color: #555; font-size: 0.9em }
  </style>
</head>
<body>
  <h1>Teacher Dashboard</h1>
  <div id="logs">
    <label for="logSelect">Select Session Log:</label>
    <select id="logSelect"><option>Loading...</option></select>
    <button id="open">Open</button>
    <button id="refresh">Refresh</button>
    <div id="status" class="meta"></div>
  </div>
  <div id="view"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const select = document.getElementById('logSelect');
    const openBtn = document.getElementById('open');
    const refreshBtn = document.getElementById('refresh');
    const status = document.getElementById('status');
    const view = document.getElementById('view');

    function clearView() { view.innerHTML = ''; }

    function renderHeader(h) {
      const div = document.createElement('div');
      div.className = 'header';
      const title = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = 'Session ' + (h.sessionNumber || '');
      const em = document.createElement('em');
      em.textContent = h.startedBy || '';
      title.appendChild(strong);
      title.appendChild(document.createTextNode(' — started by '));
      title.appendChild(em);
      title.appendChild(document.createTextNode(' at ' + (h.startTime || '')));
      div.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const ext = (h.metadata && h.metadata.extensionVersion) ? h.metadata.extensionVersion : 'n/a';
      const vs = (h.metadata && h.metadata.vscodeVersion) ? h.metadata.vscodeVersion : 'n/a';
      meta.textContent = 'Extension: ' + ext + ' • VSCode: ' + vs;
      div.appendChild(meta);
      return div;
    }

    function renderEvent(e) {
      const d = document.createElement('div');
      d.className = 'event';
      const head = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = (e.eventType || e.type || 'event');
      const span = document.createElement('span');
      span.className = 'meta';
      span.textContent = (e.time || '') + (e.flightTime ? (' • ' + e.flightTime + 'ms') : '');
      head.appendChild(strong);
      head.appendChild(document.createTextNode(' '));
      head.appendChild(span);
      d.appendChild(head);
      const ul = document.createElement('div');
      ul.className = 'meta';
      const keys = Object.keys(e).filter(k => !['eventType','time','flightTime'].includes(k));
      for (const k of keys) {
        const row = document.createElement('div');
        row.textContent = k + ': ' + JSON.stringify(e[k]);
        ul.appendChild(row);
      }
      d.appendChild(ul);
      return d;
    }

    function renderParsed(parsed) {
      clearView();
      if (parsed.sessionHeader) {
        view.appendChild(renderHeader(parsed.sessionHeader));
      }
      if (Array.isArray(parsed.events)) {
        if (parsed.events.length === 0) {
          const p = document.createElement('div'); p.textContent = 'No events recorded.'; view.appendChild(p);
        } else {
          for (const ev of parsed.events.slice().reverse()) { // show recent first
            view.appendChild(renderEvent(ev));
          }
        }
      } else {
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(parsed, null, 2); view.appendChild(pre);
      }
    }

    function renderRaw(text) {
      clearView();
      const pre = document.createElement('pre'); pre.textContent = text; view.appendChild(pre);
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'logList') {
        select.innerHTML = '';
        for (const name of msg.data) {
          const o = document.createElement('option'); o.value = name; o.textContent = name; select.appendChild(o);
        }
        status.textContent = 'Found ' + msg.data.length + ' logs';
      }
      if (msg.command === 'logData') {
        status.textContent = 'Showing ' + msg.filename + (msg.partial ? ' (partial)' : '');
        if (msg.partial) {
          const warn = document.createElement('div');
          warn.style.color = '#b45f5f';
          warn.textContent = 'WARNING: File appears tampered or truncated. Showing best-effort parsed data.';
          view.appendChild(warn);
        }
        renderParsed(msg.data);
      }
      if (msg.command === 'rawData') {
        status.textContent = 'Showing ' + msg.filename + ' (raw)';
        renderRaw(msg.data);
      }
      if (msg.command === 'error') {
        status.textContent = 'Error: ' + msg.message;
      }
    });

    openBtn.addEventListener('click', () => {
      const filename = select.value;
      if (!filename) return;
      status.textContent = 'Requesting...';
      vscode.postMessage({ command: 'openLog', filename });
    });

    refreshBtn.addEventListener('click', () => {
      status.textContent = 'Refreshing list...';
      vscode.postMessage({ command: 'listLogs' });
    });

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
