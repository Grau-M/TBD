import * as vscode from 'vscode';
import { getWorkspaceAuthSession } from '../auth';
import { flushBuffer } from '../flush';
import { state } from '../state';

export async function openStudentSyncView(context: vscode.ExtensionContext) {
    const session = getWorkspaceAuthSession(context);
    const panel = vscode.window.createWebviewPanel(
        'studentSyncView',
        'TBD: Student Sync Dashboard',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    // Get the workspace name for the "Assignment" field
    const workspaceName = vscode.workspace.name || 'Standalone Project';

    panel.webview.html = getStudentSyncHtml(panel.webview, context, session, workspaceName);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'forceSync') {
            if (state.isFlushing) {
                vscode.window.showInformationMessage("Sync already in progress...");
                return;
            }
            try {
                // Trigger the command to ensure status bar updates as well
                await vscode.commands.executeCommand('tbd-logger.forceSync');
                panel.webview.postMessage({ command: 'syncComplete' });
            } catch (err) {
                vscode.window.showErrorMessage("Sync Failed.");
                panel.webview.postMessage({ command: 'syncError' });
            }
        }
    });
}

function getStudentSyncHtml(webview: vscode.Webview, context: vscode.ExtensionContext, session: any, workspaceName: string) {
    // Note: We use the CSS variables from your getAuthHtml for perfect consistency
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            --bg: #f0f4f8; --surface: #ffffff; --muted: #6b7280; --fg: #111827;
            --border: rgba(0,0,0,0.1); --accent: #2563eb; --success: #16a34a;
        }
        :root.dark {
            --bg: #071021; --surface: #0b1220; --muted: #9aa4b2; --fg: #e6eef8;
            --border: rgba(255,255,255,0.08); --accent: #3b82f6; --success: #4ade80;
        }

        body {
            background: var(--bg); color: var(--fg);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh;
        }

        .top-theme-btn {
            position: fixed; top: 16px; right: 16px;
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 8px; padding: 8px; cursor: pointer; color: var(--fg);
        }

        .card {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 20px; padding: 40px; width: 100%; max-width: 480px;
            box-shadow: 0 12px 48px rgba(0,0,0,0.14);
        }

        .header { text-align: center; margin-bottom: 32px; }
        .logo { font-size: 3rem; margin-bottom: 12px; }
        .title { font-size: 1.5rem; font-weight: 800; margin: 0; }
        
        .info-grid { display: grid; gap: 16px; margin-bottom: 32px; }
        .field { background: var(--bg); padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
        .value { font-size: 1rem; font-weight: 500; }

        .btn-sync {
            width: 100%; padding: 14px; font-size: 1rem; font-weight: 700;
            border-radius: 10px; border: none; cursor: pointer;
            background: var(--accent); color: white; transition: all 0.2s;
        }
        .btn-sync:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn-sync:active { transform: translateY(0); }
        .btn-sync:disabled { background: var(--muted); cursor: not-allowed; }

        .status-tag {
            display: inline-block; padding: 4px 8px; border-radius: 6px;
            font-size: 0.75rem; font-weight: 700; margin-top: 8px;
            background: var(--success); color: white;
        }
    </style>
</head>
<body>
    <button id="theme-toggle" class="top-theme-btn">🌓</button>

    <div class="card">
        <div class="header">
            <div class="logo">🛡️</div>
            <h1 class="title">Sync Dashboard</h1>
            <div class="status-tag">Connected to Cloud</div>
        </div>

        <div class="info-grid">
            <div class="field">
                <div class="label">Student</div>
                <div class="value">${session?.displayName || 'Keenan Dias'}</div>
            </div>
            <div class="field">
                <div class="label">Email</div>
                <div class="value">${session?.email || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Assignment</div>
                <div class="value">${workspaceName}</div>
            </div>
        </div>

        <button id="syncBtn" class="btn-sync">🔄 Force Sync Now</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const syncBtn = document.getElementById('syncBtn');
        const themeBtn = document.getElementById('theme-toggle');

        // Theme Toggle Logic
        themeBtn.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
        });

        // Sync Logic
        syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            syncBtn.innerText = '⌛ Syncing logs...';
            vscode.postMessage({ command: 'forceSync' });
        });

        // Handle responses
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'syncComplete') {
                syncBtn.disabled = false;
                syncBtn.innerText = '✅ Sync Successful';
                setTimeout(() => { syncBtn.innerText = '🔄 Force Sync Now'; }, 3000);
            } else if (message.command === 'syncError') {
                syncBtn.disabled = false;
                syncBtn.innerText = '❌ Sync Failed';
                syncBtn.style.background = '#dc2626';
            }
        });
    </script>
</body>
</html>`;
}