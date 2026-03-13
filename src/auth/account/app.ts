import * as vscode from 'vscode';
import * as path from 'path';
import { DbStorageManager } from '../../dbStorageManager';
import { WorkspaceAuthSession } from '../../auth';
import { getAccountHtml } from './getHtml';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let accountPanel: vscode.WebviewPanel | undefined;

async function promptStudentClassJoin(storageManager: DbStorageManager, authUserId: number): Promise<boolean> {
    const joinCode = await vscode.window.showInputBox({
        title: 'Join Class',
        prompt: 'Enter the class join code provided by your teacher',
        placeHolder: 'Example: TBD-A1B2C3',
        ignoreFocusOut: true
    });

    if (!joinCode) {
        return false;
    }

    const linkedClass = await storageManager.findClassByJoinCode(joinCode.trim());
    if (!linkedClass) {
        vscode.window.showErrorMessage('Class join code not found. Please verify the code with your teacher.');
        return false;
    }

    await storageManager.enrollStudentInClass(authUserId, linkedClass);
    vscode.window.showInformationMessage(`Joined ${linkedClass.courseName} (${linkedClass.courseCode}).`);
    return true;
}

export async function openAccountView(
    context: vscode.ExtensionContext,
    storageManager: DbStorageManager,
    details: { ideUser: string; workspaceName: string }
): Promise<WorkspaceAuthSession | undefined> {
    const session = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
    if (!session?.authenticated) {
        vscode.window.showErrorMessage('You must be logged in to view account information.');
        return undefined;
    }

    if (accountPanel) {
        accountPanel.reveal(vscode.ViewColumn.One);
        return undefined;
    }

    return new Promise<WorkspaceAuthSession | undefined>((resolve) => {
        accountPanel = vscode.window.createWebviewPanel(
            'tbdAccountView',
            'TBD Logger — Account',
            { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(context.extensionPath)],
                retainContextWhenHidden: false
            }
        );

        accountPanel.webview.html = getAccountHtml(accountPanel.webview, context, {
            displayName: session.displayName,
            role: session.role,
            provider: session.provider,
            email: session.email,
            ideUser: details.ideUser,
            workspaceName: details.workspaceName,
            canViewClasses: session.role === 'Student'
        });

        accountPanel.onDidDispose(() => {
            accountPanel = undefined;
            resolve(undefined);
        }, null, context.subscriptions);

        accountPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'saveAccount': {
                        const currentSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
                        if (!currentSession?.authenticated) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Session expired. Please sign in again.' });
                            return;
                        }

                        const newDisplayName = String(message.displayName || '').trim();
                        if (!newDisplayName) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Display name cannot be empty.' });
                            return;
                        }

                        await storageManager.updateAuthUserDisplayName(currentSession.authUserId, newDisplayName);
                        const updatedSession: WorkspaceAuthSession = {
                            ...currentSession,
                            displayName: newDisplayName
                        };
                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, updatedSession);

                        accountPanel?.webview.postMessage({ command: 'accountSaved' });
                        resolve(updatedSession);
                        break;
                    }
                    case 'loadStudentClasses': {
                        const currentSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
                        if (!currentSession?.authenticated || currentSession.role !== 'Student') {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Student class dashboard is unavailable.' });
                            return;
                        }

                        const classes = await storageManager.listStudentClasses(currentSession.authUserId);
                        accountPanel?.webview.postMessage({ command: 'studentClassesData', data: classes });
                        break;
                    }
                    case 'loadStudentClassAssignments': {
                        const currentSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
                        if (!currentSession?.authenticated || currentSession.role !== 'Student') {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Student class dashboard is unavailable.' });
                            return;
                        }

                        const classId = Number(message.classId);
                        if (!Number.isFinite(classId) || classId <= 0) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Invalid class selection.' });
                            return;
                        }

                        const assignments = await storageManager.listStudentAssignmentsForClass(currentSession.authUserId, classId);
                        accountPanel?.webview.postMessage({
                            command: 'studentClassAssignmentsData',
                            data: { classId, assignments }
                        });
                        break;
                    }
                    case 'joinStudentClass': {
                        const currentSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
                        if (!currentSession?.authenticated || currentSession.role !== 'Student') {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Student class dashboard is unavailable.' });
                            return;
                        }

                        const joined = await promptStudentClassJoin(storageManager, currentSession.authUserId);
                        accountPanel?.webview.postMessage({ command: 'studentClassJoinResult', joined });
                        if (joined) {
                            const classes = await storageManager.listStudentClasses(currentSession.authUserId);
                            accountPanel?.webview.postMessage({ command: 'studentClassesData', data: classes });
                        }
                        break;
                    }
                    case 'linkStudentAssignmentWorkspace': {
                        const currentSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
                        if (!currentSession?.authenticated || currentSession.role !== 'Student') {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Student class dashboard is unavailable.' });
                            return;
                        }

                        const classId = Number(message.classId);
                        const assignmentId = Number(message.assignmentId);
                        if (!Number.isFinite(classId) || classId <= 0 || !Number.isFinite(assignmentId) || assignmentId <= 0) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Invalid assignment selection.' });
                            return;
                        }

                        const assignments = await storageManager.listStudentAssignmentsForClass(currentSession.authUserId, classId);
                        const target = assignments.find(a => a.assignmentId === assignmentId);
                        if (!target) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Assignment not found for this class.' });
                            return;
                        }

                        if (target.workspaceName || target.workspaceRootPath || target.linkedAt) {
                            accountPanel?.webview.postMessage({
                                command: 'accountError',
                                message: 'A workspace is already linked to this assignment and cannot be changed.'
                            });
                            return;
                        }

                        const picked = await vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: 'Select Assignment Workspace Folder',
                            title: `Select workspace folder for ${target.assignmentName || 'assignment'}`
                        });

                        if (!picked || picked.length === 0) {
                            return;
                        }

                        const folderUri = picked[0];
                        const workspaceName = path.basename(folderUri.fsPath || folderUri.path || 'workspace');
                        await storageManager.linkStudentWorkspaceToAssignment({
                            studentAuthUserId: currentSession.authUserId,
                            teacherAuthUserId: 0,
                            classId,
                            assignmentId,
                            workspaceName,
                            workspaceRootPath: folderUri.fsPath,
                            workspaceFoldersJson: JSON.stringify([
                                {
                                    name: workspaceName,
                                    uri: folderUri.toString()
                                }
                            ])
                        });

                        const refreshed = await storageManager.listStudentAssignmentsForClass(currentSession.authUserId, classId);
                        accountPanel?.webview.postMessage({
                            command: 'studentAssignmentWorkspaceLinked',
                            data: { classId, assignments: refreshed }
                        });
                        break;
                    }
                }
            } catch (e: any) {
                accountPanel?.webview.postMessage({
                    command: 'accountError',
                    message: String(e?.message || e)
                });
            }
        }, undefined, context.subscriptions);
    });
}
