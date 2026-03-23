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
import { clearWorkspaceAuthSession, getWorkspaceAuthSession, manageClassActivities, requireRoleAccess } from './auth';
import { openAuthView, openAccountView } from './auth/index';
import { updateSyncStatus } from './statusBar';
import { ApiHttpError, apiGet, apiPost, configureApiTokenProvider } from './api';
import { updateApiKeyStatus } from './statusBar';
import { updateTrackingUI } from './statusBar';
import * as path from 'path';
import { openStudentSyncView } from './auth/studentSyncView';

const SESSION_ID_KEY = 'sessionId';
const SESSION_COUNTER_KEY = 'tbd.sessionNumber.counter.v1';
const API_TOKEN_SECRET_KEY = 'tbd.api.sessionToken.v1';

// Function to update database status bar item
async function updateDbStatusBar(): Promise<void> {
    const statusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!statusItem) { return; }

    try {
        const health = await apiGet('/health');

        try {
            await apiGet('/api/sessions');
            statusItem.text = '$(cloud-upload) API Connected';
            statusItem.tooltip = `API reachable and authenticated. Health status: ${health?.status ?? 'ok'}`;
            return;
        } catch (authErr) {
            if (authErr instanceof ApiHttpError && (authErr.status === 401 || authErr.status === 403)) {
                statusItem.text = '$(key) API Token Needed';
                statusItem.tooltip = 'API is reachable, but token is missing or invalid. Use sign in or re-enter token.';
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
    const shouldShowLock = !!(session?.authenticated && (session.role === 'Teacher' || session.role === 'Admin'));
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
    const session = getWorkspaceAuthSession(context);
    
    // 1. Sync the global role state automatically whenever auth changes
    state.currentUserRole = session?.role || 'None';
    
    updateTrackingUI(session?.role);
    if (!authItem) {
        return;
    }
    if (session?.authenticated) {
        // 2. NEW: Override UI for teachers so they bypass tracking cleanly
        if (session.role !== 'Student') {
            authItem.text = `$(account) ${session.role}`;
            authItem.tooltip = `Logged in as ${session.role}. Activity logging is permanently disabled for educators.`;
            authItem.backgroundColor = undefined;
            authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
            syncTeacherDashboardLock(context);
            return;
        }

        if (!state.isConsentGiven) {
            authItem.text = `$(prohibit) Tracking Disabled`;
            authItem.tooltip = `Consent declined. Work is NOT being recorded for academic integrity.`;
            authItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            authItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
            syncTeacherDashboardLock(context);
            return;
        }
        authItem.text = `$(account) ${session.role}`;
        authItem.tooltip = `Logged in as ${session.role}. Click to view account details.`;
        authItem.backgroundColor = undefined;
        authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
        syncTeacherDashboardLock(context);
        return;
    }

    authItem.text = '$(account) Not Logged In';
    authItem.tooltip = 'Click to open Login/Register';
    authItem.backgroundColor = undefined;
    authItem.color = undefined;
    syncTeacherDashboardLock(context);
}

// define api for testing purposes
export interface ExtensionApi {
    state: typeof state;
    storageManager: typeof storageManager;
}

// Function: activate
// Purpose: VS Code extension activation entrypoint. Initializes
// storage, session interruption tracking, UI, commands, listeners,
// and background timers. Returns an object useful for tests.
export async function activate(context: vscode.ExtensionContext) {
    console.log('TBD Logger: activate');
    // 1. Get the current session (if one exists on startup)
    const session = getWorkspaceAuthSession(context);

    // 2. Update the tracking UI based on their role
    updateTrackingUI(session?.role);    
    configureApiTokenProvider(async () => context.secrets.get(API_TOKEN_SECRET_KEY));

    const isApiTokenValid = async (): Promise<boolean> => {
        try {
            await apiGet('/api/sessions');
            return true;
        } catch (error) {
            if (error instanceof ApiHttpError && (error.status === 401 || error.status === 403)) {
                return false;
            }
            // If API is unavailable, do not treat token as invalid.
            return true;
        }
    };

    const promptAndStoreApiToken = async (): Promise<boolean> => {
        if (process.env.CI === 'true') {
            return false;
        }

        const existingToken = await context.secrets.get(API_TOKEN_SECRET_KEY);
        if (existingToken?.trim()) {
            const isValid = await isApiTokenValid();
            if (isValid) {
                return true;
            }
            await context.secrets.delete(API_TOKEN_SECRET_KEY);
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            const tokenInput = await vscode.window.showInputBox({
                title: 'TBD Logger API Access',
                prompt: 'Enter your API access token. This is stored securely and reused automatically.',
                password: true,
                ignoreFocusOut: true
            });

            if (!tokenInput?.trim()) {
                return false;
            }

            await context.secrets.store(API_TOKEN_SECRET_KEY, tokenInput.trim());
            const isValid = await isApiTokenValid();
            if (isValid) {
                vscode.window.showInformationMessage('API token saved and validated.');
                return true;
            }

            await context.secrets.delete(API_TOKEN_SECRET_KEY);
            vscode.window.showErrorMessage('API token was rejected (401/403). Please try again.');
        }

        return false;
    };
    async function checkInitialApiKeyStatus() {
    // Check your database/storage to see if a valid key already exists
    // const existingKey = await apiStorageManager.getApiKey();
    const hasValidKey = false; // Replace with your actual check

    // This will either hide it (if true) or show the "Set API Key" prompt (if false)
    updateApiKeyStatus(hasValidKey);
}

checkInitialApiKeyStatus();
let enterApiKeyCommand = vscode.commands.registerCommand('tbd-logger.enterApiKey', async () => {
    const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your API Key",
        placeHolder: "Paste your API key here...",
        password: true,
        ignoreFocusOut: true
    });

    if (apiKey) {
        // 1. Save to your storage/database
        // await apiStorageManager.storeApiKey(apiKey);
        
        // 2. Validate the key (Optional: make a test API call here to ensure it works)
        const isKeyValid = true; // Replace with actual validation logic

        if (isKeyValid) {
            vscode.window.showInformationMessage("API Key successfully set!");
            // 3. Hide the status bar item since we now have a valid key
            updateApiKeyStatus(true);
        } else {
            vscode.window.showErrorMessage("Invalid API Key provided.");
            updateApiKeyStatus(false);
        }
    }
});

context.subscriptions.push(enterApiKeyCommand);
    const withApiTokenRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
            return await operation();
        } catch (error) {
            const status = (error instanceof ApiHttpError) ? error.status : undefined;
            if (status !== 401 && status !== 403) {
                throw error;
            }

            await context.secrets.delete(API_TOKEN_SECRET_KEY);
            const stored = await promptAndStoreApiToken();
            if (!stored) {
                throw error;
            }

            return operation();
        }
    };

    const ensureProject = async (): Promise<number | undefined> => {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const workspaceName = vscode.workspace.name || 'Unknown Workspace';

        try {
            const project = await withApiTokenRetry(() => apiPost('/api/projects', {
                name: workspaceName,
                workspacePath
            }));

            const projectId = Number(project?.id ?? project?.Id);
            if (!Number.isFinite(projectId) || projectId <= 0) {
                throw new Error('Project API did not return a valid id.');
            }

            return projectId;
        } catch (error) {
            console.warn('[TBD Logger] Unable to ensure API project.', error);
            return undefined;
        }
    };

    const startSession = async (userId: number, projectId: number, sessionNumber: number): Promise<number | undefined> => {
        try {
            const session = await withApiTokenRetry(() => apiPost('/api/sessions', {
                userId,
                projectId,
                sessionNumber,
                startedAt: new Date().toISOString()
            }));

            const sessionId = Number(session?.id ?? session?.Id);
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

    void promptAndStoreApiToken();

    try { printSessionInfo(); } catch (e) { /* no-op */ }

    // Initialize storage manager (creates/ensures encrypted file)
    await storageManager.init(context);

    // Unified workspace authentication + role assignment + student activity mapping.
    // Open the auth GUI webview if the workspace is not yet authenticated.
    const existingSession = getWorkspaceAuthSession(context);
    if (!existingSession?.authenticated) {
        // prevents the extension from hanging in CI
        if (process.env.CI === 'true') {
            console.log('[TBD Logger] CI environment detected: Skipping authentication webview block.');
        } else {
            try {
                await openAuthView(context, storageManager);
            } catch (err) {
                console.warn('[TBD Logger] Authentication view failed during startup. Continuing in offline mode.', err);
                vscode.window.showWarningMessage('TBD Logger could not reach the database for sign-in. Monitoring will continue offline.');
            }
        }
    }
//  UPDATED CONSENT GATE
    const CURRENT_POLICY_VERSION = 'v1.1'; 
    const currentAuth = getWorkspaceAuthSession(context);

    if (currentAuth?.authenticated) {
        const projectId = await ensureProject();
        if (projectId) {
            const nextSessionNumber = (context.workspaceState.get<number>(SESSION_COUNTER_KEY) || 0) + 1;
            const startedSessionId = await startSession(currentAuth.authUserId, projectId, nextSessionNumber);
            if (startedSessionId) {
                await context.workspaceState.update(SESSION_COUNTER_KEY, nextSessionNumber);
                void logEvent('session_start', {
                    workspaceName: vscode.workspace.name || 'Unknown Workspace',
                    workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
                });
            }
        }
    }
    
    if (currentAuth?.authenticated) {
        try {
            // We now just check consent using the policy version
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
    }
    if (process.env.CI === 'true') {
        console.log('[TBD Logger] CI environment detected: Auto-granting consent for automated tests.');
        state.isConsentGiven = true;
    }
    //  END OF CONSENT GATE
    // Detect Session Interruptions (inactivity / abnormal end / clean shutdown)
    await SessionInterruptionTracker.install(context, {
        inactivityThresholdMs: 5 * 60 * 1000, // 5 minutes (change if you want)
        checkEveryMs: 10_000
    });


    // Log Session Start 
    state.sessionBuffer.push({
        time: formatTimestamp(Date.now()),
        flightTime: '0',
        eventType: 'session-start',
        fileEdit: '',
        fileView: 'VS Code Session Started'
    });

    // Initialize focused file state
    const initialActive = vscode.window.activeTextEditor;
    const initialPath = initialActive && initialActive.document ? vscode.workspace.asRelativePath(initialActive.document.uri, false) : '';
    state.currentFocusedFile = isIgnoredPath(initialPath) ? '' : initialPath;
    state.focusStartTime = Date.now();

    //Open Logs Command with Password Prompt
    const openLogs = async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Log access');
        if (!allowed) {
            return;
        }

        try {
            // Determine if the active editor is focused on an integrity log
            const active = vscode.window.activeTextEditor;
            let targetUri: vscode.Uri | null = null;

            if (active && active.document) {
                const fname = path.basename(active.document.uri.fsPath);
                if (/Session\d+-integrity\.log$/.test(fname)) {
                    targetUri = active.document.uri;
                }
            }

            // If no focused log file, present a QuickPick of available session logs
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

            // 1. Ask for Password
            const password = await vscode.window.showInputBox({
                prompt: `Enter Administrator Password to view ${path.basename(targetUri.fsPath)}`,
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'TBD_CAPSTONE...'
            });

            if (!password) {return;} // User cancelled

            // 2. Retrieve & Decrypt selected file
            const content = await storageManager.retrieveLogContentForUri(password, targetUri);

            // 3. Display
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
    const openLogsCommand = vscode.commands.registerCommand('tbd-logger.openLogs', openLogs);
    context.subscriptions.push(openLogsCommand);

    // Command: Show Hidden Deletions — open the single deletion activity file after password
    const showHidden = async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Deletion activity log');
        if (!allowed) {
            return;
        }

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
    const showHiddenCommand = vscode.commands.registerCommand('tbd-logger.showHiddenDeletions', showHidden);
    context.subscriptions.push(showHiddenCommand);

    // Command: Open Teacher Dashboard (Webview)
    const openTeacherCommand = vscode.commands.registerCommand('tbd-logger.openTeacherView', async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Teacher Dashboard');
        if (!allowed) {
            return;
        }
        await openTeacherView(context);
    });
    context.subscriptions.push(openTeacherCommand);

    // Command: Teacher/Admin class-activity management for student workspace mapping.
    const manageActivitiesCommand = vscode.commands.registerCommand('tbd-logger.manageClassActivities', async () => {
        await manageClassActivities(context, storageManager);
    });
    context.subscriptions.push(manageActivitiesCommand);

    // Command: Re-open login/register flow from status bar.
    const authSignInCommand = vscode.commands.registerCommand('tbd-logger.authSignIn', async () => {
        const session = getWorkspaceAuthSession(context);
        if (session?.authenticated) {
            const ideIdentity = getSessionInfo().user;
            const workspaceName = vscode.workspace.name || 'Unknown Workspace';

            await openAccountView(context, storageManager, {
                ideUser: ideIdentity,
                workspaceName
            });
            updateAuthStatusBar(context);
            return;
        }

        await openAuthView(context, storageManager);
        updateAuthStatusBar(context);
    });
    context.subscriptions.push(authSignInCommand);

    // Command: Sign out (triggered via right-click context menu on the auth status bar item).
    const signOutCommand = vscode.commands.registerCommand('tbd-logger.signOut', async () => {
        const session = getWorkspaceAuthSession(context);
        if (!session?.authenticated) {
            vscode.window.showInformationMessage('You are not currently logged in.');
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to log out? (${session.displayName} — ${session.role})`,
            { modal: true },
            'Log Out'
        );

        if (answer === 'Log Out') {
            await clearWorkspaceAuthSession(context);
            await context.secrets.delete(API_TOKEN_SECRET_KEY);
            updateAuthStatusBar(context);
            vscode.window.showInformationMessage('You have been logged out.');
        }
    });
    context.subscriptions.push(signOutCommand);

    // Create status bar and start UI timer (REC/AWAY timer is display-only).
    // Teacher dashboard lock is role-gated and managed dynamically after auth state is known.
    const statusBarItem = createStatusBar(context);
    const uiTimerDisposable = startUiTimer(statusBarItem);
    context.subscriptions.push(uiTimerDisposable);
    updateAuthStatusBar(context);

    // Register listeners
    const editListener = createEditListener();
    context.subscriptions.push(editListener);

    const focusListener = createFocusListener();
    context.subscriptions.push(focusListener);

    const windowStateListener = createWindowStateListener();
    context.subscriptions.push(windowStateListener);

    const saveListener = createSaveListener();
    context.subscriptions.push(saveListener);

    // Auth guard: prompt unauthenticated users when they make any workspace changes.
    // Shown at most once per session; resets only if the user picks "Login" and then
    // closes the auth panel without completing sign-in.
    let _authPromptShown = false;
    let _unmonitoredAlertCaptured = false;

    const promptIfUnauthenticated = async () => {
        if (process.env.CI === 'true') { return; }
        if (_authPromptShown) { return; }
        const session = getWorkspaceAuthSession(context);
        if (session?.authenticated) { return; }

        if (!_unmonitoredAlertCaptured) {
            _unmonitoredAlertCaptured = true;
            const info = getSessionInfo();
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            await storageManager.recordUnmonitoredWorkAlert({
                ideUser: info.user,
                workspaceName: info.project,
                workspacePath,
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
            _authPromptShown = false; // allow re-prompt if they cancel the login panel
            await openAuthView(context, storageManager);
            updateAuthStatusBar(context);
        }
        // "Keep Working Without", "I'm Not Working on School", or dismiss (undefined)
        // all leave _authPromptShown = true so the prompt won't appear again this session.
    };

    // Text edits
    const authEditGuard = vscode.workspace.onDidChangeTextDocument((e) => {
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
    });
    context.subscriptions.push(authEditGuard);

    const apiSaveEventListener = vscode.workspace.onDidSaveTextDocument((doc) => {
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_save', { file: docPath });
    });
    context.subscriptions.push(apiSaveEventListener);

    const apiOpenEventListener = vscode.workspace.onDidOpenTextDocument((doc) => {
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_open', { file: docPath });
    });
    context.subscriptions.push(apiOpenEventListener);

    const apiCloseEventListener = vscode.workspace.onDidCloseTextDocument((doc) => {
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_close', { file: docPath });
    });
    context.subscriptions.push(apiCloseEventListener);

    const apiActiveEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
            void logEvent('active_editor_change', { file: '' });
            return;
        }
        const docPath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('active_editor_change', { file: docPath });
    });
    context.subscriptions.push(apiActiveEditorListener);

    const apiWindowStateListener = vscode.window.onDidChangeWindowState((windowState) => {
        void logEvent('window_state_change', {
            focused: windowState.focused
        });
    });
    context.subscriptions.push(apiWindowStateListener);

    // File creates, deletes, renames
    const authCreateGuard = vscode.workspace.onDidCreateFiles(() => void promptIfUnauthenticated());
    const authDeleteGuard = vscode.workspace.onDidDeleteFiles(() => void promptIfUnauthenticated());
    const authRenameGuard = vscode.workspace.onDidRenameFiles(() => void promptIfUnauthenticated());
    context.subscriptions.push(authCreateGuard, authDeleteGuard, authRenameGuard);

    // Command to manually refresh database status
    const checkDbStatusCommand = vscode.commands.registerCommand('tbd-logger.checkDbStatus', () => {
        void updateDbStatusBar();
    });
    context.subscriptions.push(checkDbStatusCommand);

    // Command: Test Database Connection (migrated) — now checks API health endpoint.
    const testDbCommand = vscode.commands.registerCommand('tbd-logger.testDbConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`✅ API ONLINE\nStatus: ${result?.status ?? 'unknown'}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(
                `❌ API health check failed!\nError: ${err?.message || String(err)}`
            );
        }
        void updateDbStatusBar();
    });
    context.subscriptions.push(testDbCommand);

    const testConnectionCommand = vscode.commands.registerCommand('tbd.testConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`API status: ${result.status}`);
        } catch (error: any) {
            const message = error?.message || String(error);
            vscode.window.showErrorMessage(`API test failed: ${message}`);
        }
    });
    context.subscriptions.push(testConnectionCommand);

    // Periodic flush timer
    const flushTimer = setInterval(() => void flushBuffer(), CONSTANTS.FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });

    // Periodic database status update (every 10 seconds)
    const statusUpdateTimer = setInterval(() => {
        void updateDbStatusBar();
    }, 10000);
    context.subscriptions.push({ dispose: () => clearInterval(statusUpdateTimer) });

    // Initial status update
    void updateDbStatusBar();
    updateAuthStatusBar(context);
    
let isSyncing = false;
const forceSyncCommand = vscode.commands.registerCommand('tbd-logger.forceSync', async () => {
    const session = getWorkspaceAuthSession(context);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // 1. Auth Check
    if (!session?.authenticated || !session?.authUserId) {
        vscode.window.showErrorMessage("Sync Denied: Please log in first.");
        return;
    }

    // 2. Assignment Guard: Check if the current workspace is linked to a valid assignment
    const assignmentLink = await (storageManager as any).validateAssignmentLink(
        session.authUserId, 
        workspaceRoot || ''
    );

    if (!assignmentLink) {
        vscode.window.showErrorMessage(
            "Sync Blocked: This workspace is not attached to an active assignment. Please join a class and link this folder first."
        );
        return;
    }

    // 3. Concurrency Check
    if (isSyncing || state.isFlushing) {
        vscode.window.showInformationMessage("Sync already in progress...");
        return;
    }

    // 4. SUNNY DAY: Valid assignment confirmed, proceed with sync
    isSyncing = true;
    updateSyncStatus(true);
    
    try {
        await flushBuffer();
        vscode.window.showInformationMessage(`✅ Successfully synced to: ${assignmentLink.assignmentName}`);
    } catch (error) {
        vscode.window.showErrorMessage("Sync failed. Check your network connection.");
    } finally {
        isSyncing = false;
        updateSyncStatus(false);
    }
});
    // Register the force sync command and add to subscriptions
    context.subscriptions.push(forceSyncCommand);

    const openSyncViewCommand = vscode.commands.registerCommand('tbd-logger.openStudentSyncView', async () => {
        await openStudentSyncView(context);
    });

    context.subscriptions.push(openSyncViewCommand); //

    // Admin Command to manually trigger the Data Purge (For Capstone Demo)
    context.subscriptions.push(vscode.commands.registerCommand('tbd.admin.runPurge', async () => {
        vscode.window.showInformationMessage('TBD Logger: Initiating data purge. Check console for details.');
        // You can change '365' to '0' during your demo if you want it to delete EVERYTHING for a live demonstration!
        await storageManager.runAutomatedDataPurge(365); 
    }));

    //Return the internals so the Test Suite can see them
    return { state, storageManager };
    
    
}

export function deactivate() {
    // 1. Mark clean shutdown for the tracker
    SessionInterruptionTracker.markCleanShutdown();

    // 2. Log final focus duration
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

    // 3. Final data flush
    void flushBuffer();

    // 4. Dispose global status bar references
    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    if (globalSb) { globalSb.dispose(); }

    const dbStatusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (dbStatusItem) { dbStatusItem.dispose(); }

    const authStatusItem = (global as any).authStatusBarItem as vscode.StatusBarItem | undefined;
    if (authStatusItem) { authStatusItem.dispose(); }

    const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;
    if (hiddenItem) { hiddenItem.dispose(); }

    // 5. Close database connection
    void storageManager.dispose();
}