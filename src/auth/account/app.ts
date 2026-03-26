import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceAuthSession } from '../../auth';
import { getAccountHtml } from './getHtml';
import { getThemePreference, normalizeThemePreference, setThemePreference } from '../../themePreference';
import { registerWebviewPanel } from '../../webviewRegistry';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let accountPanel: vscode.WebviewPanel | undefined;
let openingAccountPanel = false;

async function joinStudentClassByCode(storageManager: any, authUserId: number, joinCode: string): Promise<{ joined: boolean; message?: string }> {
    const normalizedJoinCode = String(joinCode || '').trim();
    if (!normalizedJoinCode) {
        return { joined: false, message: 'Enter a class join code.' };
    }

    const linkedClass = await storageManager.findClassByJoinCode(normalizedJoinCode);
    if (!linkedClass) {
        return { joined: false, message: 'Class join code not found. Please verify the code with your teacher.' };
    }

    const isNewEnrollment = await storageManager.enrollStudentInClass(authUserId, linkedClass);
    if (isNewEnrollment) {
        return { joined: true, message: `Successfully joined ${linkedClass.courseName} (${linkedClass.courseCode}).` };
    }

    return { joined: true, message: `You are already enrolled in ${linkedClass.courseName}.` };
}

export async function openAccountView(
    context: vscode.ExtensionContext,
    storageManager: any,
    details: { ideUser: string; workspaceName: string }
): Promise<WorkspaceAuthSession | undefined> {
    const currentPanel = accountPanel;
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return undefined;
    }

    if (openingAccountPanel) {
        return undefined;
    }

    openingAccountPanel = true;

    const storedSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
    if (!storedSession?.authenticated) {
        vscode.window.showErrorMessage('You must be logged in to view account information.');
        openingAccountPanel = false;
        return undefined;
    }

    let session = storedSession;

    // Always try to refresh account identity from API, but fall back to the cached session
    // so the dashboard can still open when the backend is temporarily unreachable.
    try {
        const dbUser = await storageManager.findAuthUserByEmail(storedSession.email);
        if (dbUser) {
            session = {
                ...storedSession,
                authUserId: dbUser.authUserId,
                role: dbUser.role,
                displayName: dbUser.displayName || storedSession.displayName,
                trackingConsent: dbUser.trackingConsent // Added this mapping
            };
            await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
        } else {
            vscode.window.showWarningMessage('Unable to refresh account information from the database. Showing cached account details instead.');
        }
    } catch (error: any) {
        vscode.window.showWarningMessage(`Unable to refresh account information from API: ${String(error?.message || error)}. Showing cached details instead.`);
    }

    const reopenedPanel = accountPanel;
    if (reopenedPanel) {
        reopenedPanel.reveal(vscode.ViewColumn.One);
        openingAccountPanel = false;
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

        registerWebviewPanel(accountPanel);

        accountPanel.webview.html = getAccountHtml(accountPanel.webview, context, {
            displayName: session.displayName,
            role: session.role,
            provider: session.provider,
            email: session.email,
            ideUser: details.ideUser,
            workspaceName: details.workspaceName,
            canViewClasses: session.role === 'Student',
            themePreference: getThemePreference(context),
            trackingConsent: session.trackingConsent // Ensure getAccountHtml has this passed
        });

        accountPanel.onDidDispose(() => {
            accountPanel = undefined;
            openingAccountPanel = false;
            resolve(undefined);
        }, null, context.subscriptions);

        openingAccountPanel = false;

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
                        const selectedTheme = normalizeThemePreference(message.themePreference);
                        
                        // STRICT BOOLEAN CAST FOR CONSENT
                        const trackingConsent = Boolean(message.trackingConsent === true || message.trackingConsent === 'true');

                        if (!newDisplayName) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Display name cannot be empty.' });
                            return;
                        }

                        const titleCaseDisplayName = newDisplayName
                            .toLowerCase()
                            .replace(/\b([a-z])/g, (_match, letter: string) => letter.toUpperCase())
                            .replace(/\s+/g, ' ');

                        await setThemePreference(context, selectedTheme);

                        const existingDisplayName = String(currentSession.displayName || '').trim();
                        const existingTrackingConsent = Boolean(currentSession.trackingConsent === true);
                        const changes: { displayName?: string; trackingConsent?: boolean } = {};

                        if (titleCaseDisplayName && titleCaseDisplayName !== existingDisplayName) {
                            changes.displayName = titleCaseDisplayName;
                        }

                        if (trackingConsent !== existingTrackingConsent) {
                            changes.trackingConsent = trackingConsent;
                        }

                        if (Object.keys(changes).length > 0) {
                            await storageManager.updateAuthUserProfile(currentSession.email, changes);

                            // Verify persisted data from API before confirming success in UI.
                            const refreshedUser = await storageManager.findAuthUserByEmail(currentSession.email);
                            const persistedDisplayName = String(refreshedUser?.displayName || existingDisplayName).trim();
                            if (changes.displayName && (!persistedDisplayName || persistedDisplayName !== titleCaseDisplayName)) {
                                accountPanel?.webview.postMessage({
                                    command: 'accountError',
                                    message: 'Unable to confirm the update in the database. Please try again.'
                                });
                                return;
                            }

                            const updatedSession: WorkspaceAuthSession = {
                                ...currentSession,
                                displayName: changes.displayName ? persistedDisplayName : existingDisplayName,
                                trackingConsent: typeof refreshedUser?.trackingConsent === 'boolean' ? refreshedUser.trackingConsent : trackingConsent
                            };
                            await context.workspaceState.update(WORKSPACE_AUTH_KEY, updatedSession);

                            accountPanel?.webview.postMessage({ command: 'accountSaved' });
                            accountPanel?.webview.postMessage({ command: 'themePreferenceApplied', themePreference: selectedTheme });
                            resolve(updatedSession);
                            break;
                        }

                        const updatedSession: WorkspaceAuthSession = {
                            ...currentSession,
                            displayName: existingDisplayName,
                            trackingConsent: existingTrackingConsent
                        };
                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, updatedSession);

                        accountPanel?.webview.postMessage({ command: 'accountSaved' });
                        accountPanel?.webview.postMessage({ command: 'themePreferenceApplied', themePreference: selectedTheme });
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

                        const joinCode = String(message.joinCode || '');
                        const result = await joinStudentClassByCode(storageManager, currentSession.authUserId, joinCode);
                        accountPanel?.webview.postMessage({
                            command: 'studentClassJoinResult',
                            joined: result.joined,
                            message: result.message
                        });
                        if (result.joined) {
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
                        const target = assignments.find((a: any) => a.assignmentId === assignmentId);
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
                        const classes = await storageManager.listStudentClasses(currentSession.authUserId);
                        const selectedClass = classes.find((item: any) => Number(item.id) === classId);
                        const teacherAuthUserId = Number(
                            target.teacherAuthUserId ||
                            target.teacherId ||
                            selectedClass?.teacherAuthUserId ||
                            selectedClass?.teacherId ||
                            0
                        );
                        const linkedWorkspace = await storageManager.linkStudentWorkspaceToAssignment({
                            studentAuthUserId: currentSession.authUserId,
                            teacherAuthUserId,
                            teacherId: teacherAuthUserId,
                            classId,
                            classAssignmentId: assignmentId,
                            ClassAssignmentId: assignmentId,
                            assignmentId,
                            workspaceName,
                            workspaceId: folderUri.fsPath,
                            WorkspaceId: folderUri.fsPath,
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
                            data: {
                                classId,
                                assignments: refreshed,
                                linkedAssignment: linkedWorkspace,
                                assignmentId,
                                workspaceName,
                                workspaceRootPath: folderUri.fsPath
                            }
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