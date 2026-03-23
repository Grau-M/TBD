import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceAuthSession } from '../../auth';
import { getAccountHtml } from './getHtml';
import { getThemePreference, normalizeThemePreference, setThemePreference } from '../../themePreference';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let accountPanel: vscode.WebviewPanel | undefined;

async function promptStudentClassJoin(storageManager: any, authUserId: number): Promise<boolean> {
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

    //see if they were already in the class
    const isNewEnrollment = await storageManager.enrollStudentInClass(authUserId, linkedClass);
    
    if (isNewEnrollment) {
        vscode.window.showInformationMessage(`Successfully joined ${linkedClass.courseName} (${linkedClass.courseCode}).`);
    } else {
        // RAINY DAY: Double Enrollment Message
        vscode.window.showInformationMessage(`You are already enrolled in ${linkedClass.courseName}.`);
    }
    
    return true; // We return true because the end state (being in the class) is successful
}

export async function openAccountView(
    context: vscode.ExtensionContext,
    storageManager: any,
    details: { ideUser: string; workspaceName: string }
): Promise<WorkspaceAuthSession | undefined> {
    const storedSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
    if (!storedSession?.authenticated) {
        vscode.window.showErrorMessage('You must be logged in to view account information.');
        return undefined;
    }

    let session = storedSession;

    // Always refresh account identity from API so the account form reflects database truth.
    try {
        const dbUser = await storageManager.findAuthUserByEmail(storedSession.email);
        if (!dbUser) {
            vscode.window.showErrorMessage('Unable to load account information from the database.');
            return undefined;
        }

        session = {
            ...storedSession,
            authUserId: dbUser.authUserId,
            role: dbUser.role,
            displayName: dbUser.displayName || storedSession.displayName,
            trackingConsent: dbUser.trackingConsent // Added this mapping
        };
        await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Unable to load account information from API: ${String(error?.message || error)}`);
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
            canViewClasses: session.role === 'Student',
            themePreference: getThemePreference(context),
            trackingConsent: session.trackingConsent // Ensure getAccountHtml has this passed
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
                        const selectedTheme = normalizeThemePreference(message.themePreference);
                        
                        // STRICT BOOLEAN CAST FOR CONSENT
                        const trackingConsent = Boolean(message.trackingConsent === true || message.trackingConsent === 'true');

                        if (!newDisplayName) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Display name cannot be empty.' });
                            return;
                        }

                        await setThemePreference(context, selectedTheme);

                        const existingDisplayName = String(currentSession.displayName || '').trim();
                        const existingTrackingConsent = Boolean(currentSession.trackingConsent === true);
                        const changes: { displayName?: string; trackingConsent?: boolean } = {};

                        if (newDisplayName && newDisplayName !== existingDisplayName) {
                            changes.displayName = newDisplayName;
                        }

                        if (trackingConsent !== existingTrackingConsent) {
                            changes.trackingConsent = trackingConsent;
                        }

                        if (Object.keys(changes).length > 0) {
                            await storageManager.updateAuthUserProfile(currentSession.email, changes);

                            // Verify persisted data from API before confirming success in UI.
                            const refreshedUser = await storageManager.findAuthUserByEmail(currentSession.email);
                            const persistedDisplayName = String(refreshedUser?.displayName || existingDisplayName).trim();
                            if (changes.displayName && (!persistedDisplayName || persistedDisplayName !== newDisplayName)) {
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