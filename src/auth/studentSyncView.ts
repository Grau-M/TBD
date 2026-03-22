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
    // 1. Check our conditions
    const hasCourse = !!assignment?.courseName;
    const hasAssignment = !!assignment?.assignmentName;
    const canSync = hasCourse && hasAssignment;

    // 2. Set up our dynamic UI states
    const statusText = canSync ? "✅ Correct Assignment Linked" : "⚠️ Sync Unavailable";
    const statusColor = canSync ? "var(--success)" : "var(--error)";
    const errorMessage = "Student isn't registered in a course or workspace isn't connected to an assignment.";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            --bg: var(--vscode-editor-background); 
            --surface: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); 
            --muted: var(--vscode-descriptionForeground); 
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.2)); 
            --accent: var(--vscode-button-background); 
            --accent-hover: var(--vscode-button-hoverBackground);
            --success: #16a34a; 
            --error: #dc2626;
        }

        body {
            background: var(--bg); color: var(--fg);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh;
        }

        .card {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 20px; padding: 40px; width: 100%; max-width: 480px;
            box-shadow: 0 12px 48px rgba(0,0,0,0.14);
        }

        .header { text-align: center; margin-bottom: 24px; }
        .logo { font-size: 3rem; margin-bottom: 12px; display: block; }
        .title { font-size: 1.5rem; font-weight: 800; margin: 0; }
        
        /* New Error Banner Styles */
        .error-banner {
            background: rgba(220, 38, 38, 0.1); 
            color: var(--error); 
            padding: 12px 16px; 
            border: 1px solid var(--error); 
            border-radius: 8px; 
            margin-bottom: 24px; 
            font-size: 0.9rem; 
            font-weight: 600; 
            text-align: center;
            line-height: 1.4;
        }

        .info-grid { display: grid; gap: 16px; margin-bottom: 32px; }
        .field { background: var(--bg); padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
        .value { font-size: 0.95rem; font-weight: 600; }

        .btn-sync {
            width: 100%; padding: 14px; font-size: 1rem; font-weight: 700;
            border-radius: 10px; border: none; cursor: pointer;
            background: var(--accent); color: var(--vscode-button-foreground, white); transition: all 0.2s;
        }
        .btn-sync:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }
        .btn-sync:disabled { background: var(--muted); cursor: not-allowed; opacity: 0.6; }

        .status-tag {
            display: inline-block; padding: 6px 12px; border-radius: 8px;
            font-size: 0.8rem; font-weight: 700; margin-top: 12px;
            color: white;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <span class="logo" role="img" aria-label="Shield Logo">🛡️</span>
            <h1 class="title">Sync Dashboard</h1>
            <div class="status-tag" style="background: ${statusColor}">${statusText}</div>
        </div>

        ${!canSync ? `<div class="error-banner">❌ ${errorMessage}</div>` : ''}

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

        <button id="syncBtn" class="btn-sync" ${!canSync ? 'disabled' : ''}>
            ${canSync ? '🔄 Force Sync to Assignment' : 'Sync Disabled'}
        </button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const syncBtn = document.getElementById('syncBtn');

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