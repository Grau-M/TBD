import * as vscode from 'vscode';
import { WorkspaceAuthSession } from '../auth';
import { state, storageManager } from '../state';
import { apiGet } from '../api';
import { updateApiKeyStatus } from '../statusBar';
import { registerWebviewPanel } from '../webviewRegistry';

interface ClassQuickPickItem extends vscode.QuickPickItem {
    classId: number;
    teacherAuthUserId: number;
}

interface AssignmentQuickPickItem extends vscode.QuickPickItem {
    assignmentId: number;
}

let panel: vscode.WebviewPanel | undefined;
let openingPanel = false;

export async function openStudentSyncView(context: vscode.ExtensionContext) {
    const currentPanel = panel;
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    if (openingPanel) {
        return;
    }

    openingPanel = true;

    const session = context.workspaceState.get<WorkspaceAuthSession>('tbd.auth.workspaceSession.v1');

    if (!session?.authenticated) {
        vscode.window.showErrorMessage("Access Denied: You must be logged in to view the Sync Dashboard.");
        openingPanel = false;
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'syncDashboardView',
        'TBD: Sync Dashboard',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'img')]
        }
    );

    const activePanel = panel;
    registerWebviewPanel(activePanel);

    let apiStatus = 'Offline';
    try {
        const health = await apiGet('/health');
        apiStatus = health?.status ? 'Online' : 'Offline';
        state.isApiOnline = apiStatus === 'Online';
    } catch (e) {
        apiStatus = 'Offline';
        state.isApiOnline = false;
    }

    const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = currentWorkspaceFolder?.uri.fsPath || '';

    let assignmentInfo: any = null;

    // --- ROBUST DATABASE-FIRST WORKSPACE CHECK ---
    // Instead of relying purely on local memory, we ask the database if this exact folder is linked.
    if (session.role === 'Student' && workspaceRoot) {
        try {
            const classes = await (storageManager as any).listStudentClasses(session.authUserId);
            if (classes && classes.length > 0) {
                for (const c of classes) {
                    const assignments = await (storageManager as any).listStudentAssignmentsForClass(session.authUserId, c.id);
                    if (assignments) {
                        // Find an assignment where the saved path matches the current workspace path
                        const linked = assignments.find((a: any) => 
                            a.workspaceRootPath && 
                            vscode.Uri.file(a.workspaceRootPath).fsPath === vscode.Uri.file(workspaceRoot).fsPath
                        );
                        
                        if (linked) {
                            assignmentInfo = {
                                classId: c.id,
                                courseName: c.courseName || c.courseCode || `Class ID: ${c.id}`,
                                assignmentId: linked.assignmentId,
                                assignmentName: linked.assignmentName || linked.name || linked.WorkplaceName || linked.workplaceName || `Assignment ID: ${linked.assignmentId}`,
                                workspaceRootPath: String(linked.workspaceRootPath || workspaceRoot || '')
                            };

                            state.activeCourse = assignmentInfo.courseName;
                            state.activeAssignment = assignmentInfo.assignmentName;
                            
                            // Heal the local session state so other parts of the extension know it's linked
                            session.workspaceLinkedClassId = c.id;
                            session.workspaceLinkedAssignmentId = linked.assignmentId;
                            await context.workspaceState.update('tbd.auth.workspaceSession.v1', session);
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("[TBD Logger] Failed to fetch assignments from DB for sync view", e);
        }

        // Fallback to local memory if DB check failed (e.g., offline)
        if (!assignmentInfo) {
            assignmentInfo = await (storageManager as any).validateAssignmentLink(session.authUserId, workspaceRoot);
        }

        if (assignmentInfo) {
            state.activeCourse = assignmentInfo.courseName || state.activeCourse;
            state.activeAssignment = assignmentInfo.assignmentName || state.activeAssignment;
        }
    }

    updateApiKeyStatus(apiStatus === 'Online');

    const logoImageUri = activePanel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'src', 'img', 'CloudSync.png')
    ).toString();

    const render = () => {
        activePanel.webview.html = getDashboardHtml(session, assignmentInfo, apiStatus, logoImageUri);
    };

    render();

    activePanel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'forceSync') {
            try {
                await vscode.commands.executeCommand('tbd-logger.forceSync');
                activePanel.webview.postMessage({ command: 'syncComplete' });
            } catch (err) {
                vscode.window.showErrorMessage("Sync Failed.");
                activePanel.webview.postMessage({ command: 'syncError' });
            }
        } 
        
        else if (message.command === 'triggerManualSync') {
            if (!currentWorkspaceFolder) {
                const choice = await vscode.window.showWarningMessage(
                    "You must have a workspace folder open to link an assignment.",
                    "Open Folder"
                );
                if (choice === "Open Folder") {
                    vscode.commands.executeCommand('vscode.openFolder');
                }
                activePanel.webview.postMessage({ command: 'syncReset' });
                return;
            }

            try {
                const classes = await (storageManager as any).listStudentClasses(session.authUserId);
                if (!classes || classes.length === 0) {
                    vscode.window.showInformationMessage("You are not currently enrolled in any active classes.");
                    activePanel.webview.postMessage({ command: 'syncReset' });
                    return;
                }

                const classItems: ClassQuickPickItem[] = classes.map((c: any) => ({
                    label: c.courseName || `Class ${c.id}`,
                    description: c.courseCode,
                    classId: c.id,
                    teacherAuthUserId: c.teacherAuthUserId || 0
                }));
                
                const selectedClass = await vscode.window.showQuickPick<ClassQuickPickItem>(classItems, {
                    placeHolder: 'Select the Class for this assignment',
                    ignoreFocusOut: true
                });

                if (!selectedClass) {
                    activePanel.webview.postMessage({ command: 'syncReset' });
                    return;
                }

                const assignments = await (storageManager as any).listStudentAssignmentsForClass(session.authUserId, selectedClass.classId);
                const availableAssignments = assignments.filter((a: any) => !a.workspaceRootPath);

                if (availableAssignments.length === 0) {
                    vscode.window.showInformationMessage("All assignments in this class are already linked to other workspaces.");
                    activePanel.webview.postMessage({ command: 'syncReset' });
                    return;
                }

                const assignmentItems: AssignmentQuickPickItem[] = availableAssignments.map((a: any) => ({
                    label: a.assignmentName || `Assignment ${a.assignmentId}`,
                    description: a.dueDate ? `Due: ${a.dueDate}` : '',
                    assignmentId: a.assignmentId
                }));

                const selectedAssignment = await vscode.window.showQuickPick<AssignmentQuickPickItem>(assignmentItems, {
                    placeHolder: 'Select the Assignment to link to this workspace',
                    ignoreFocusOut: true
                });

                if (!selectedAssignment) {
                    activePanel.webview.postMessage({ command: 'syncReset' });
                    return;
                }

                const workspaceName = currentWorkspaceFolder.name;
                const workspaceRootPath = currentWorkspaceFolder.uri.fsPath;
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Linking workspace to assignment...",
                    cancellable: false
                }, async () => {
                    await (storageManager as any).linkStudentWorkspaceToAssignment({
                        studentAuthUserId: session.authUserId,
                        teacherAuthUserId: selectedClass.teacherAuthUserId,
                        classId: selectedClass.classId,
                        assignmentId: selectedAssignment.assignmentId,
                        workspaceName: workspaceName,
                        workspaceRootPath,
                        workspaceFoldersJson: JSON.stringify([{ name: workspaceName, uri: currentWorkspaceFolder.uri.toString() }])
                    });
                });

                // UPDATE LOCAL SESSION STATE SO THE EXTENSION REMEMBERS THE LINK
                session.workspaceLinkedClassId = selectedClass.classId;
                session.workspaceLinkedAssignmentId = selectedAssignment.assignmentId;
                await context.workspaceState.update('tbd.auth.workspaceSession.v1', session);

                state.activeCourse = selectedClass.label;
                state.activeAssignment = selectedAssignment.label;
                state.isSessionActive = true;
                state.currentUserRole = session.role || 'Student';
                state.isApiOnline = apiStatus === 'Online';
                updateApiKeyStatus(apiStatus === 'Online');

                await vscode.commands.executeCommand('tbd-logger.refreshStatusBar');

                vscode.window.showInformationMessage(`Successfully linked workspace to ${selectedAssignment.label}.`);
                
                // Inject the names directly into the UI state so they display correctly right away
                assignmentInfo = {
                    classId: selectedClass.classId,
                    courseName: selectedClass.label,
                    assignmentId: selectedAssignment.assignmentId,
                    assignmentName: selectedAssignment.label,
                    workspaceRootPath
                };

                state.activeCourse = selectedClass.label;
                state.activeAssignment = selectedAssignment.label;
                state.isApiOnline = apiStatus === 'Online';
                updateApiKeyStatus(apiStatus === 'Online');

                render();

            } catch (error: any) {
                if (String(error).includes('500') || String(error).includes('Unique')) {
                    vscode.window.showErrorMessage(`Failed to link assignment. This workspace may already be linked in the database.`);
                } else {
                    vscode.window.showErrorMessage(`Failed to link assignment: ${error.message || error}`);
                }
                activePanel.webview.postMessage({ command: 'syncReset' });
            }
        }
    });

    activePanel.onDidDispose(() => {
        panel = undefined;
        openingPanel = false;
    });

    openingPanel = false;
}

function getDashboardHtml(session: any, assignment: any, apiStatus: string, logoImageUri: string) {
    const isOnline = apiStatus === 'Online';
    const statusColor = isOnline ? 'var(--success)' : 'var(--error)';
    const syncStatusText = isOnline ? 'Sync Online' : 'Sync Offline';

    let mainContent = '';

    if (session.role === 'Teacher' || session.role === 'Admin') {
        mainContent = `
            <div class="header">
                <span class="logo">
                    <img class="logo-image" src="${logoImageUri}" alt="" aria-hidden="true" />
                </span>
                <h1 class="title">System Health Dashboard</h1>
                <div class="status-tag" style="background: ${statusColor}">API: ${apiStatus}</div>
            </div>
            <div class="info-grid">
                <div class="field">
                    <div class="label">Backend Server Operational Status</div>
                    <div class="value" style="color: ${statusColor}">${apiStatus}</div>
                </div>
                <div class="field">
                    <div class="label">API Calls & Routing Health</div>
                    <div class="value">${isOnline ? 'Active & Responding' : 'Unreachable'}</div>
                </div>
                <div class="field">
                    <div class="label">Logged In As</div>
                    <div class="value">${session.displayName} (${session.role})</div>
                </div>
            </div>
        `;
    } else {
        const isLinked = !!assignment?.classId && !!assignment?.assignmentId;

        mainContent = `
            <div class="header">
                <span class="logo">
                    <img class="logo-image" src="${logoImageUri}" alt="" aria-hidden="true" />
                </span>
                <h1 class="title">Sync Dashboard</h1>
                <div class="status-tag" style="background: ${statusColor}">${syncStatusText}</div>
            </div>
        `;

        if (isLinked) {
            mainContent += `
                <div class="info-grid">
                    <div class="field">
                        <div class="label">Course</div>
                        <div class="value">${assignment.courseName || `Class ID: ${assignment.classId}`}</div>
                    </div>
                    <div class="field">
                        <div class="label">Assignment</div>
                        <div class="value">${assignment.assignmentName || 'Active Assignment'}</div>
                    </div>
                    <div class="field">
                        <div class="label">Workspace Path</div>
                        <div class="value">${assignment.workspaceRootPath || 'N/A'}</div>
                    </div>
                </div>
                <button id="forceSyncBtn" class="btn-sync" ${isOnline ? '' : 'disabled title="Manual sync is unavailable while the API is offline."'}>
                    Manual Sync
                </button>
            `;
        } else {
            mainContent += `
                <div class="error-banner" style="background: rgba(245, 158, 11, 0.1); color: #b45309; border-color: rgba(245, 158, 11, 0.2);">
                    ⚠️ Please connect to an assignment.
                </div>
                <button id="manualSyncBtn" class="btn-sync">
                    🔗 Connect Workspace to Assignment
                </button>
            `;
        }
    }

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
            min-width: 0;
        }

        .header { text-align: center; margin-bottom: 24px; }
        .logo { margin-bottom: 12px; display: block; }
        .logo-image {
            width: 96px;
            height: 96px;
            display: block;
            margin: 0 auto;
            object-fit: contain;
        }
        .title { font-size: 1.5rem; font-weight: 800; margin: 0; }
        
        .error-banner {
            padding: 12px 16px; 
            border-radius: 8px; 
            margin-bottom: 24px; 
            font-size: 0.95rem; 
            font-weight: 600; 
            text-align: center;
        }

        .info-grid { display: grid; gap: 16px; margin-bottom: 32px; }
        .field { background: var(--bg); padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
        .value { font-size: 0.95rem; font-weight: 600; overflow-wrap: anywhere; word-break: break-word; min-width: 0; }

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

        .info-grid,
        .field {
            min-width: 0;
        }

        @media (max-width: 560px) {
            body { padding: 16px; }
            .card { padding: 24px; border-radius: 16px; }
            .title { font-size: 1.35rem; }
            .logo-image { width: 76px; height: 76px; }
            .error-banner { margin-bottom: 18px; }
        }
    </style>
</head>
<body>
    <div class="card">
        ${mainContent}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const forceBtn = document.getElementById('forceSyncBtn');
        if (forceBtn) {
            forceBtn.addEventListener('click', () => {
                if (forceBtn.disabled) {
                    return;
                }
                forceBtn.disabled = true;
                forceBtn.innerText = '⌛ Syncing...';
                vscode.postMessage({ command: 'forceSync' });
            });
        }

        const manualBtn = document.getElementById('manualSyncBtn');
        if (manualBtn) {
            manualBtn.addEventListener('click', () => {
                manualBtn.disabled = true;
                manualBtn.innerText = '⌛ Opening Selector...';
                vscode.postMessage({ command: 'triggerManualSync' });
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'syncComplete' && forceBtn) {
                forceBtn.disabled = false;
                forceBtn.innerText = '✅ Sync Successful';
                forceBtn.style.background = 'var(--success)';
                setTimeout(() => { 
                    forceBtn.innerText = 'Manual Sync';
                    forceBtn.style.background = 'var(--accent)';
                }, 3000);
            } else if (message.command === 'syncError' && forceBtn) {
                forceBtn.disabled = false;
                forceBtn.innerText = '❌ Sync Failed'; 
                forceBtn.style.background = 'var(--error)';
            } else if (message.command === 'syncReset' && manualBtn) {
                manualBtn.disabled = false;
                manualBtn.innerText = '🔗 Connect Workspace to Assignment';
            }
        });
    </script>
</body>
</html>`;
}