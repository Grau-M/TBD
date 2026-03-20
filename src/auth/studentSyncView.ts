import * as vscode from 'vscode';
import { getWorkspaceAuthSession } from '../auth';
import { storageManager } from '../state';

export async function openStudentSyncView(context: vscode.ExtensionContext) {
    const session = getWorkspaceAuthSession(context);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // Fetch assignment data to confirm correct mapping
    const assignmentInfo = session?.authUserId 
        ? await (storageManager as any).validateAssignmentLink(session.authUserId, workspaceRoot)
        : null;

    const panel = vscode.window.createWebviewPanel(
        'studentSyncView',
        'TBD: Student Sync Dashboard',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    // Pass the fetched assignment information to the HTML
    panel.webview.html = getStudentSyncHtml(session, assignmentInfo);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'forceSync') {
            try {
                // Trigger the unified command in extension.ts
                await vscode.commands.executeCommand('tbd-logger.forceSync');
                panel.webview.postMessage({ command: 'syncComplete' });
            } catch (err) {
                vscode.window.showErrorMessage("Sync Failed.");
                panel.webview.postMessage({ command: 'syncError' });
            }
        }
    });
}

function getStudentSyncHtml(session: any, assignment: any) {
    const isLinked = !!assignment;
    const statusText = isLinked ? "✅ Correct Assignment Linked" : "⚠️ Workspace Not Linked";
    const statusColor = isLinked ? "var(--success)" : "var(--error)";
//add alt text to the logo for accessibility
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            --bg: #f0f4f8; --surface: #ffffff; --muted: #6b7280; --fg: #111827;
            --border: rgba(0,0,0,0.1); --accent: #2563eb; --success: #16a34a; --error: #dc2626;
        }
        :root.dark {
            --bg: #071021; --surface: #0b1220; --muted: #9aa4b2; --fg: #e6eef8;
            --border: rgba(255,255,255,0.08); --accent: #3b82f6; --success: #4ade80; --error: #f87171;
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
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }

        .card {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 20px; padding: 40px; width: 100%; max-width: 480px;
            box-shadow: 0 12px 48px rgba(0,0,0,0.14);
        }

        .header { text-align: center; margin-bottom: 32px; }
        .logo { font-size: 3rem; margin-bottom: 12px; display: block; }
        .title { font-size: 1.5rem; font-weight: 800; margin: 0; }
        
        .info-grid { display: grid; gap: 16px; margin-bottom: 32px; }
        .field { background: var(--bg); padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
        .value { font-size: 0.95rem; font-weight: 600; }

        .btn-sync {
            width: 100%; padding: 14px; font-size: 1rem; font-weight: 700;
            border-radius: 10px; border: none; cursor: pointer;
            background: var(--accent); color: white; transition: all 0.2s;
        }
        .btn-sync:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
        .btn-sync:disabled { background: var(--muted); cursor: not-allowed; opacity: 0.6; }

        .status-tag {
            display: inline-block; padding: 6px 12px; border-radius: 8px;
            font-size: 0.8rem; font-weight: 700; margin-top: 12px;
            color: white;
        }
    </style>
</head>
<body>
    <button id="theme-toggle" class="top-theme-btn" title="Toggle theme">🌓</button>

    <div class="card">
        <div class="header">
            <span class="logo">🛡️</span>
            <h1 class="title">Sync Dashboard</h1>
            <div class="status-tag" style="background: ${statusColor}">${statusText}</div>
        </div>

        <div class="info-grid">
            <div class="field">
                <div class="label">Course</div>
                <div class="value">${assignment?.courseName || 'Unregistered'}</div>
            </div>
            <div class="field">
                <div class="label">Target Assignment</div>
                <div class="value">${assignment?.assignmentName || 'Unknown Workspace'}</div>
            </div>
            <div class="field">
                <div class="label">Student</div>
                <div class="value">${session?.displayName || 'N/A'}</div>
            </div>
        </div>

        <button id="syncBtn" class="btn-sync" ${!isLinked ? 'disabled' : ''}>
            ${isLinked ? '🔄 Force Sync to Assignment' : '❌ Assignment Link Missing'}
        </button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const syncBtn = document.getElementById('syncBtn');
        const themeBtn = document.getElementById('theme-toggle');

        themeBtn.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
        });

        syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            syncBtn.innerText = '⌛ Syncing...';
            vscode.postMessage({ command: 'forceSync' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'syncComplete') {
                syncBtn.disabled = false;
                syncBtn.innerText = '✅ Sync Successful';
                syncBtn.style.background = 'var(--success)';
                setTimeout(() => { 
                    syncBtn.innerText = '🔄 Force Sync to Assignment';
                    syncBtn.style.background = 'var(--accent)';
                }, 3000);
            } else if (message.command === 'syncError') {
                syncBtn.disabled = false;
                syncBtn.innerText = '❌ Sync Failed'; 
                syncBtn.style.background = 'var(--error)';
            }
        });
    </script>
</body>
</html>`;
}