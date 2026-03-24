// Module: extension.ts
// Purpose: Extension activation and deactivation entrypoints.
// This file initializes the extension: it sets up the storage manager,
// session interruption tracker, status bar UI, listeners, commands,
// and periodic background flush. It also exposes a minimal API for
// tests and marks clean shutdown on deactivate.
import * as vscode from 'vscode';
import { getSessionInfo, printSessionInfo } from './sessionInfo';
import { createStatusBar } from './statusBar';
import { createEditListener } from './listeners/editListener';
import { createFocusListener } from './listeners/focusListener';
import { createWindowStateListener } from './listeners/windowStateListener';
import { createSaveListener } from './listeners/saveListener';
import { startUiTimer } from './uiTimer';
import { flushBuffer } from './flush';
import { storageManager, state, CONSTANTS } from './state';
import { isIgnoredPath, formatTimestamp } from './utils';
import { SessionInterruptionTracker } from './sessionInterruptions';
import { openTeacherView } from './teacher';
import { clearWorkspaceAuthSession, getWorkspaceAuthSession, manageClassActivities, requireRoleAccess, WorkspaceAuthSession } from './auth';
import { openAuthView, openAccountView } from './auth/index';
import { updateSyncStatus } from './statusBar';
import { ApiHttpError, apiGet, apiPost } from './api';
import { updateTrackingUI } from './statusBar';
import * as path from 'path';
import { openStudentSyncView } from './auth/studentSyncView';

const originalEmitWarning = process.emitWarning.bind(process);
let runtimeWarningFilterInstalled = false;

function installRuntimeWarningFilter(): void {
    if (runtimeWarningFilterInstalled) {
        return;
    }

    runtimeWarningFilterInstalled = true;
    process.emitWarning = ((warning: any, ...args: any[]) => {
        const message = typeof warning === 'string'
            ? warning
            : String(warning?.message || warning || '');

        if (
            message.includes('The `punycode` module is deprecated') ||
            message.includes('SQLite is an experimental feature')
        ) {
            return;
        }

        return originalEmitWarning(warning as any, ...args as any);
    }) as typeof process.emitWarning;
}

const SESSION_ID_KEY = 'sessionId';
const SESSION_COUNTER_KEY = 'tbd.sessionNumber.counter.v1';
const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

// Function to update database status bar item
async function updateDbStatusBar(): Promise<void> {
    const statusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!statusItem) { return; }
    
    if (state.isPersonalWorkspace) {
        statusItem.hide();
        return;
    }

    try {
        const health = await apiGet('/health');

        try {
            await apiGet('/api/sessions');
            statusItem.text = '$(cloud-upload) API Connected';
            statusItem.tooltip = `API reachable and authenticated. Health status: ${health?.status ?? 'ok'}`;
            return;
        } catch (authErr) {
            if (authErr instanceof ApiHttpError && (authErr.status === 401 || authErr.status === 403)) {
                statusItem.text = '$(cloud-offline) API Auth Error';
                statusItem.tooltip = 'API reachable, but authentication failed. Check the backend configuration.';
                return;
            }
            throw authErr;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        statusItem.text = '$(database) API Offline';
        statusItem.tooltip = `API is not reachable. Last error: ${msg}`;
    }
}


function syncTeacherDashboardLock(context: vscode.ExtensionContext): void {
    const session = getWorkspaceAuthSession(context);
    const shouldShowLock = !!(session?.authenticated && (session.role === 'Teacher' || session.role === 'Admin')) && !state.isPersonalWorkspace;
    const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;

    void vscode.commands.executeCommand('setContext', 'tbd.hasTeacherDashboardAccess', shouldShowLock);

    if (shouldShowLock) {
        if (!hiddenItem) {
            const newHiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
            newHiddenItem.text = '$(lock)';
            newHiddenItem.tooltip = 'Show Teacher Dashboard';
            newHiddenItem.command = 'tbd-logger.openTeacherView';
            newHiddenItem.show();
            context.subscriptions.push(newHiddenItem);
            (global as any).hiddenStatusBarItem = newHiddenItem;
        }
        return;
    }

    if (hiddenItem) {
        hiddenItem.dispose();
        delete (global as any).hiddenStatusBarItem;
    }
}

function updateAuthStatusBar(context: vscode.ExtensionContext): void {
    const authItem = (global as any).authStatusBarItem as vscode.StatusBarItem | undefined;
    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    const dbItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    const session = getWorkspaceAuthSession(context);
    
    // 1. Sync the global role state automatically whenever auth changes
    state.currentUserRole = session?.role || 'None';
    
    // A. Personal Workspace Override (Hides all UI elements)
    if (state.isPersonalWorkspace) {
        authItem?.hide();
        globalSb?.hide();
        dbItem?.hide();
        syncTeacherDashboardLock(context);
        return;
    } else {
        authItem?.show();
        globalSb?.show();
        dbItem?.show();
    }

    updateTrackingUI(session?.role);
    if (!authItem || !globalSb) {
        return;
    }
    
    if (session?.authenticated) {
        // 2. Override UI for teachers so they bypass tracking cleanly
        if (session.role !== 'Student') {
            authItem.text = `$(account) ${session.role}`;
            authItem.tooltip = `Logged in as ${session.role}. Activity logging is permanently disabled for educators.`;
            authItem.backgroundColor = undefined;
            authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
            
            globalSb.text = `$(stop-circle) Tracking Disabled (Educator)`;
            globalSb.tooltip = `Logging is strictly disabled for Teachers/Admins.`;
            globalSb.color = new vscode.ThemeColor('descriptionForeground');
            globalSb.command = undefined;
            syncTeacherDashboardLock(context);
            return;
        }

        if (!state.isConsentGiven) {
            authItem.text = `$(prohibit) Tracking Disabled`;
            authItem.tooltip = `Consent declined. Work is NOT being recorded for academic integrity.`;
            authItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            authItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
            
            globalSb.text = `$(stop-circle) Tracking Disabled (No Consent)`;
            globalSb.color = new vscode.ThemeColor('statusBarItem.errorForeground');
            syncTeacherDashboardLock(context);
            return;
        }
        
        authItem.text = `$(account) ${session.role}`;
        authItem.tooltip = `Logged in as ${session.role}. Click to view account details.`;
        authItem.backgroundColor = undefined;
        authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
        
        // 3. WORKSPACE LINKED STATUS
        if (state.activeAssignment) {
            globalSb.text = `$(record) Recording: ${state.activeAssignment}`;
            globalSb.tooltip = `Logging data to ${state.activeCourse || 'Linked Assignment'}`;
            globalSb.color = new vscode.ThemeColor('testing.iconPassed'); // Green text
            globalSb.command = 'tbd-logger.openStudentSyncView';
        } else {
            globalSb.text = `$(warning) Finish Linking Workspace`;
            globalSb.tooltip = `Click to connect this workspace to an assignment.`;
            globalSb.color = new vscode.ThemeColor('list.warningForeground'); // Yellow/Orange text
            globalSb.command = 'tbd-logger.openStudentSyncView';
        }

        syncTeacherDashboardLock(context);
        return;
    }

    authItem.text = '$(account) Not Logged In';
    authItem.tooltip = 'Click to open Login/Register';
    authItem.backgroundColor = undefined;
    authItem.color = undefined;
    
    globalSb.text = `$(stop-circle) Tracking Inactive`;
    globalSb.color = new vscode.ThemeColor('descriptionForeground');
    globalSb.command = undefined;
    syncTeacherDashboardLock(context);
}

// define api for testing purposes
export interface ExtensionApi {
    state: typeof state;
    storageManager: typeof storageManager;
}

// Function: activate
export async function activate(context: vscode.ExtensionContext) {
    installRuntimeWarningFilter();
    console.log('TBD Logger: activate');

    const statusBarItem = createStatusBar(context);
    const uiTimerDisposable = startUiTimer(statusBarItem);
    context.subscriptions.push(uiTimerDisposable);

    // 1. Get the current session
    let session = getWorkspaceAuthSession(context) as any;

    // 2. AUTOMATED LOGGING & WORKSPACE VALIDATION ON STARTUP
    const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = currentWorkspaceFolder?.uri.fsPath || '';

    if (session?.authenticated && session.role === 'Student' && workspaceRoot) {
        const personalFlagKey = `tbd.personalWorkspace.${workspaceRoot}`;
        const isAlreadyPersonal = context.workspaceState.get<boolean>(personalFlagKey);

        if (isAlreadyPersonal) {
            state.isPersonalWorkspace = true;
        } else {
            let assignmentInfo: any = null;

            // Perform API call to verify if WorkspaceRootPath matches existing DB entries
            try {
                const classes = await (storageManager as any).listStudentClasses(session.authUserId);
                if (classes && classes.length > 0) {
                    for (const c of classes) {
                        const assignments = await (storageManager as any).listStudentAssignmentsForClass(session.authUserId, c.id);
                        if (assignments) {
                            const linked = assignments.find((a: any) => 
                                a.workspaceRootPath && 
                                vscode.Uri.file(a.workspaceRootPath).fsPath === vscode.Uri.file(workspaceRoot).fsPath
                            );
                            
                            if (linked) {
                                assignmentInfo = {
                                    classId: c.id,
                                    courseName: c.courseName || c.courseCode,
                                    assignmentId: linked.assignmentId,
                                    assignmentName: linked.assignmentName || linked.name
                                };
                                break;
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('[TBD Logger] DB workspace validation failed. Checking local storage fallback.', err);
                assignmentInfo = await (storageManager as any).validateAssignmentLink(session.authUserId, workspaceRoot);
            }

            if (assignmentInfo) {
                // MATCHED PATH: Initialize logging and route data
                state.activeCourse = assignmentInfo.courseName || `Class ID: ${assignmentInfo.classId}`;
                state.activeAssignment = assignmentInfo.assignmentName || `Assignment ID: ${assignmentInfo.assignmentId}`;
                
                session.workspaceLinkedClassId = assignmentInfo.classId;
                session.workspaceLinkedAssignmentId = assignmentInfo.assignmentId;
                await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
            } else {
                // UNMATCHED PATH: Trigger modal categorization
                const choice = await vscode.window.showInformationMessage(
                    'TBD Logger: Unrecognized Workspace. Is this a Personal Project or a School Assignment?',
                    { modal: true },
                    'School Project',
                    'Personal Project'
                );

                if (choice === 'Personal Project') {
                    state.isPersonalWorkspace = true;
                    await context.workspaceState.update(personalFlagKey, true);
                    vscode.window.showInformationMessage('TBD Logger UI and Tracking hidden for this personal workspace.');
                } else if (choice === 'School Project') {
                    vscode.commands.executeCommand('tbd-logger.openStudentSyncView');
                }
            }
        }
    }

    // 3. Update the tracking UI based on role and validation results
    updateTrackingUI(session?.role);    
    const withApiTokenRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
        return operation();
    };

    const ensureProject = async (): Promise<number | undefined> => {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const workspaceName = vscode.workspace.name || 'Unknown Workspace';
        
        const classId = Number(session?.workspaceLinkedClassId ?? 0);
        const assignmentId = Number(session?.workspaceLinkedAssignmentId ?? 0);
        const userId = Number(session?.authUserId ?? 0);

        if (!userId || !classId || !assignmentId) { return undefined; }

        const payload = { userId, classId, assignmentId, workspaceName, workspacePath };

        try {
            let project;
            try {
                project = await withApiTokenRetry(() => apiPost('/api/projects', payload));
            } catch (apiError: any) {
                project = await withApiTokenRetry(() => 
                    apiGet(`/api/projects?workspacePath=${encodeURIComponent(workspacePath)}&userId=${userId}`)
                );
            }

            let projList = Array.isArray(project) ? project : (project?.projects || project?.data || [project]);
            let projObj = Array.isArray(projList) ? projList[0] : projList;

            const projectId = Number(projObj?.id ?? projObj?.Id ?? projObj?.projectId ?? projObj?.ProjectId);
            
            if (!Number.isFinite(projectId) || projectId <= 0) {
                throw new Error(`Project API did not return a valid id. Raw data: ${JSON.stringify(projObj)}`);
            }
            return projectId;
        } catch (error) {
            console.warn('[TBD Logger] Unable to ensure API project.', error);
            return undefined;
        }
    };

    const startSession = async (userId: number, projectId: number, sessionNumber: number): Promise<number | undefined> => {
        try {
            const apiSession = await withApiTokenRetry(() => apiPost('/api/sessions', {
                userId,
                projectId,
                sessionNumber,
                startedAt: new Date().toISOString()
            }));

            const sessionId = Number(apiSession?.id ?? apiSession?.Id);
            if (!Number.isFinite(sessionId) || sessionId <= 0) {
                throw new Error('Session API did not return a valid id.');
            }

            await context.workspaceState.update(SESSION_ID_KEY, sessionId);
            return sessionId;
        } catch (error) {
            await context.workspaceState.update(SESSION_ID_KEY, undefined);
            const details = error instanceof ApiHttpError ? error.responseBody : String(error);
            console.warn('[TBD Logger] Unable to start API session.', details);
            return undefined;
        }
    };

    const logEvent = async (eventType: string, data: any): Promise<void> => {
        // ROLE-BASED RESTRICTIONS
        if (state.isPersonalWorkspace) { return; }
        if (state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        
        const sessionId = context.workspaceState.get<number>(SESSION_ID_KEY);
        if (!sessionId) {
            return;
        }

        try {
            await withApiTokenRetry(() => apiPost('/api/events', {
                sessionId,
                eventType,
                occurredAt: new Date().toISOString(),
                eventData: data
            }));
        } catch (error) {
            console.warn(`[TBD Logger] Failed to log event: ${eventType}`, error);
        }
    };

    try { printSessionInfo(); } catch (e) { /* no-op */ }

    await storageManager.init(context);

    if (!session?.authenticated) {
        if (process.env.CI === 'true') {
            console.log('[TBD Logger] CI environment detected: Skipping authentication webview block.');
        } else {
            try {
                await openAuthView(context, storageManager);
                session = getWorkspaceAuthSession(context) as any;
            } catch (err) {
                console.warn('[TBD Logger] Authentication view failed during startup. Continuing in offline mode.', err);
                vscode.window.showWarningMessage('TBD Logger could not reach the service for sign-in. Monitoring will continue offline.');
            }
        }
    }

    const CURRENT_POLICY_VERSION = 'v1.1'; 

    if (session?.authenticated && session.role === 'Student' && !state.isPersonalWorkspace) {
        const hasLinkedWorkspace = Number(session.workspaceLinkedClassId ?? 0) > 0 
            && Number(session.workspaceLinkedAssignmentId ?? 0) > 0;

        if (hasLinkedWorkspace) {
            const projectId = await ensureProject();
            if (projectId) {
                const nextSessionNumber = (context.workspaceState.get<number>(SESSION_COUNTER_KEY) || 0) + 1;
                const startedSessionId = await startSession(session.authUserId, projectId, nextSessionNumber);
                if (startedSessionId) {
                    await context.workspaceState.update(SESSION_COUNTER_KEY, nextSessionNumber);
                    void logEvent('session_start', {
                        workspaceName: vscode.workspace.name || 'Unknown Workspace',
                        workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
                    });
                }
            }
        }
    }
    
    // Consent Check Gate
    if (session?.authenticated) {
        if (session.role === 'Student' && !state.isPersonalWorkspace) {
            try {
                const hasConsented = await storageManager.checkUserConsent(CURRENT_POLICY_VERSION);

                if (!hasConsented) {
                    const choice = await vscode.window.showInformationMessage(
                        'Privacy Policy: Coding activity is being recorded for academic integrity purposes. By continuing, you acknowledge and agree to this tracking as a condition of using TBD Logger.',
                        { modal: true },
                        'I Acknowledge and Agree',
                        'Decline'
                    );

                    if (choice === 'I Acknowledge and Agree') {
                        await storageManager.recordUserConsent(CURRENT_POLICY_VERSION);
                        state.isConsentGiven = true;
                        updateAuthStatusBar(context);
                    } else {
                        state.isConsentGiven = false;
                        updateAuthStatusBar(context);
                        vscode.window.showWarningMessage('Tracking disabled. Your work will NOT be recorded.');
                    }
                } else {
                    state.isConsentGiven = true;
                }
            } catch (err) {
                console.warn('[TBD Logger] Consent check failed. Continuing with local offline mode.', err);
                state.isConsentGiven = false;
                updateAuthStatusBar(context);
                vscode.window.showWarningMessage('TBD Logger could not verify consent with the database. Please retry sign-in/consent once connectivity is restored.');
            }
        } else {
            state.isConsentGiven = false;
            updateAuthStatusBar(context); 
        }
    } else {
        state.isConsentGiven = false; 
    }

    if (process.env.CI === 'true') {
        state.isConsentGiven = true;
    }

    await SessionInterruptionTracker.install(context, {
        inactivityThresholdMs: 5 * 60 * 1000,
        checkEveryMs: 10_000
    });

    if ((state.currentUserRole === 'Student' || state.currentUserRole === 'None') && !state.isPersonalWorkspace) {
        state.sessionBuffer.push({
            time: formatTimestamp(Date.now()),
            flightTime: '0',
            eventType: 'session-start',
            fileEdit: '',
            fileView: 'VS Code Session Started'
        });
    }

    const initialActive = vscode.window.activeTextEditor;
    const initialPath = initialActive && initialActive.document ? vscode.workspace.asRelativePath(initialActive.document.uri, false) : '';
    state.currentFocusedFile = isIgnoredPath(initialPath) ? '' : initialPath;
    state.focusStartTime = Date.now();

    const openLogs = async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Log access');
        if (!allowed) { return; }

        try {
            const active = vscode.window.activeTextEditor;
            let targetUri: vscode.Uri | null = null;

            if (active && active.document) {
                const fname = path.basename(active.document.uri.fsPath);
                if (/Session\d+-integrity\.log$/.test(fname)) {
                    targetUri = active.document.uri;
                }
            }

            if (!targetUri) {
                const files = await storageManager.listLogFiles();
                if (files.length === 0) {
                    vscode.window.showInformationMessage('No integrity logs found.');
                    return;
                }
                const pick = await vscode.window.showQuickPick(files.map(f => f.label), { placeHolder: 'Select integrity log to open' });
                if (!pick) {return;}
                const chosen = files.find(f => f.label === pick);
                if (!chosen) {return;}
                targetUri = chosen.uri;
            }

            const password = await vscode.window.showInputBox({
                prompt: `Enter Administrator Password to view ${path.basename(targetUri.fsPath)}`,
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'TBD_CAPSTONE...'
            });

            if (!password) {return;}

            const content = await storageManager.retrieveLogContentForUri(password, targetUri);
            const doc = await vscode.workspace.openTextDocument({
                content: content,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('Logs decrypted successfully.');

        } catch (err) {
            vscode.window.showErrorMessage(`Access Denied: ${err}`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.openLogs', openLogs));

    const showHidden = async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Deletion activity log');
        if (!allowed) { return; }

        try {
            const password = await vscode.window.showInputBox({
                prompt: 'Enter Administrator Password to view deletion activity log',
                password: true,
                ignoreFocusOut: true
            });
            if (!password) {return;}
            const content = await storageManager.retrieveHiddenLogContent(password);
            const doc = await vscode.workspace.openTextDocument({ content: content, language: 'json' });
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
            vscode.window.showErrorMessage(`Unable to access deletion activity log: ${err}`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.showHiddenDeletions', showHidden));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.openTeacherView', async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Teacher Dashboard');
        if (!allowed) { return; }
        await openTeacherView(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.manageClassActivities', async () => {
        await manageClassActivities(context, storageManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.authSignIn', async () => {
        const curSession = getWorkspaceAuthSession(context);
        if (curSession?.authenticated) {
            const ideIdentity = getSessionInfo().user;
            const workspaceName = vscode.workspace.name || 'Unknown Workspace';

            await openAccountView(context, storageManager, { ideUser: ideIdentity, workspaceName });
            updateAuthStatusBar(context);
            return;
        }

        await openAuthView(context, storageManager);
        updateAuthStatusBar(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.signOut', async () => {
        const curSession = getWorkspaceAuthSession(context);
        if (!curSession?.authenticated) {
            vscode.window.showInformationMessage('You are not currently logged in.');
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to log out? (${curSession.displayName} — ${curSession.role})`,
            { modal: true },
            'Log Out'
        );

        if (answer === 'Log Out') {
            await clearWorkspaceAuthSession(context);
            updateAuthStatusBar(context);
            vscode.window.showInformationMessage('You have been logged out.');
        }
    }));

    updateAuthStatusBar(context);

    // Register listeners
    context.subscriptions.push(createEditListener());
    context.subscriptions.push(createFocusListener());
    context.subscriptions.push(createWindowStateListener());
    context.subscriptions.push(createSaveListener());

    let _authPromptShown = false;
    let _unmonitoredAlertCaptured = false;

    const promptIfUnauthenticated = async () => {
        if (process.env.CI === 'true') { return; }
        if (_authPromptShown) { return; }
        if (state.isPersonalWorkspace) { return; }

        const curSession = getWorkspaceAuthSession(context);
        if (curSession?.authenticated) { return; }

        if (!_unmonitoredAlertCaptured) {
            _unmonitoredAlertCaptured = true;
            const info = getSessionInfo();
            const wPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            await storageManager.recordUnmonitoredWorkAlert({
                ideUser: info.user,
                workspaceName: info.project,
                workspacePath: wPath,
                reason: 'Student activity detected while not signed in to TBD Logger monitoring.'
            });
        }

        _authPromptShown = true;

        const choice = await vscode.window.showWarningMessage(
            'You are not signed in to TBD Logger. Your activity is not being tracked.',
            'Login',
            'Keep Working Without',
            "I'm Not Working on School"
        );

        if (choice === 'Login') {
            _authPromptShown = false;
            await openAuthView(context, storageManager);
            updateAuthStatusBar(context);
        } else if (choice === "I'm Not Working on School") {
            state.isPersonalWorkspace = true;
            const wPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            if (wPath) {
                await context.workspaceState.update(`tbd.personalWorkspace.${wPath}`, true);
            }
            updateAuthStatusBar(context);
        }
    };

    // Text edits
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        if (e.contentChanges.length === 0) { return; }
        const docPath = vscode.workspace.asRelativePath(e.document.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void promptIfUnauthenticated();

        const charsAdded = e.contentChanges.reduce((sum, change) => sum + change.text.length, 0);
        const isPaste = e.contentChanges.some((change) => change.text.length > 1);
        void logEvent(isPaste ? 'paste' : 'file_edit', {
            file: docPath,
            changeCount: e.contentChanges.length,
            charsAdded
        });
    }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_save', { file: docPath });
    }));

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_open', { file: docPath });
    }));

    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_close', { file: docPath });
    }));

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        if (!editor) {
            void logEvent('active_editor_change', { file: '' });
            return;
        }
        const docPath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('active_editor_change', { file: docPath });
    }));

    context.subscriptions.push(vscode.window.onDidChangeWindowState((windowState) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        void logEvent('window_state_change', {
            focused: windowState.focused
        });
    }));

    context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => void promptIfUnauthenticated()));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => void promptIfUnauthenticated()));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => void promptIfUnauthenticated()));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.checkDbStatus', () => {
        void updateDbStatusBar();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.testDbConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`✅ API ONLINE\nStatus: ${result?.status ?? 'unknown'}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(
                `❌ API health check failed!\nError: ${err?.message || String(err)}`
            );
        }
        void updateDbStatusBar();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd.testConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`API status: ${result.status}`);
        } catch (error: any) {
            const message = error?.message || String(error);
            vscode.window.showErrorMessage(`API test failed: ${message}`);
        }
    }));

    const flushTimer = setInterval(() => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') {
            state.sessionBuffer = []; // Hard-wipe any errant local logs so they never hit disk
            return;
        }
        void flushBuffer();
    }, CONSTANTS.FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });

    const statusUpdateTimer = setInterval(() => {
        void updateDbStatusBar();
    }, 10000);
    context.subscriptions.push({ dispose: () => clearInterval(statusUpdateTimer) });

    void updateDbStatusBar();
    
    let isSyncing = false;
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.forceSync', async () => {
        const curSession = getWorkspaceAuthSession(context);
        const wRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!curSession?.authenticated || !curSession?.authUserId) {
            vscode.window.showErrorMessage("Sync Denied: Please log in first.");
            return;
        }

        const assignmentLink = await (storageManager as any).validateAssignmentLink(
            curSession.authUserId, 
            wRoot || ''
        );

        if (!assignmentLink) {
            vscode.window.showErrorMessage(
                "Sync Blocked: This workspace is not attached to an active assignment. Please join a class and link this folder first."
            );
            return;
        }

        if (isSyncing || state.isFlushing) {
            vscode.window.showInformationMessage("Sync already in progress...");
            return;
        }

        isSyncing = true;
        updateSyncStatus(true);
        
        try {
            await flushBuffer();
            vscode.window.showInformationMessage(`✅ Successfully synced to: ${assignmentLink.assignmentName}`);
        } catch (error) {
            vscode.window.showErrorMessage("Sync failed. Check your network connection.");
        } finally {
            isSyncing = false;
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.openStudentSyncView', async () => {
        await openStudentSyncView(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd.admin.runPurge', async () => {
        vscode.window.showInformationMessage('TBD Logger: Initiating data purge. Check console for details.');
        await storageManager.runAutomatedDataPurge(365); 
    }));

    return { state, storageManager };
}

export function deactivate() {
    SessionInterruptionTracker.markCleanShutdown();

    if (state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin' || state.isPersonalWorkspace) {
        state.sessionBuffer = []; // Wipe completely
    } else {
        const now = Date.now();
        if (state.currentFocusedFile) {
            state.sessionBuffer.push({
                time: formatTimestamp(now),
                flightTime: String(now - state.focusStartTime),
                eventType: 'focusDuration',
                fileEdit: '',
                fileView: state.currentFocusedFile
            });
        }

        void flushBuffer();
    }

    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    if (globalSb) { globalSb.dispose(); }

    const dbStatusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (dbStatusItem) { dbStatusItem.dispose(); }

    const authStatusItem = (global as any).authStatusBarItem as vscode.StatusBarItem | undefined;
    if (authStatusItem) { authStatusItem.dispose(); }

    const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;
    if (hiddenItem) { hiddenItem.dispose(); }

    void storageManager.dispose();
}