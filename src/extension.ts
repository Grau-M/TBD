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

import * as path from 'path';
import { openStudentSyncView } from './auth/studentSyncView';

// Function to update database status bar item
async function updateDbStatusBar(): Promise<void> {
    const statusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!statusItem) { return; }

    const sync = storageManager.getBackgroundSyncStatus();
    const pendingSuffix = sync.pendingQueueCount > 0 ? ` (${sync.pendingQueueCount} queued)` : '';

    if (storageManager.isConnecting()) {
        statusItem.text = '$(loading~spin) Connecting...';
        statusItem.tooltip = 'Connecting to database...';
    } else if (sync.state === 'syncing') {
        statusItem.text = `$(sync~spin) Syncing${pendingSuffix}`;
        statusItem.tooltip = 'Uploading queued session data in the background.';
    } else if (sync.state === 'queue-warning') {
        statusItem.text = `$(warning) Queue High${pendingSuffix}`;
        statusItem.tooltip = sync.lastError || 'Offline queue is near limit. Reconnect to continue syncing safely.';
    } else if (sync.state === 'conflict') {
        statusItem.text = `$(alert) Synced (Conflict Flagged)`;
        statusItem.tooltip = sync.lastError || 'A sync conflict was detected and flagged for instructor review using Latest Wins resolution.';
    } else if (storageManager.isOnline()) {
        statusItem.text = '$(cloud-upload) Synced';
        statusItem.tooltip = sync.lastSyncedAt
            ? `Session data is synchronized. Last sync: ${sync.lastSyncedAt}`
            : 'Session data is synchronized.';
    } else {
        statusItem.text = `$(database) Offline${pendingSuffix}`;
        statusItem.tooltip = sync.lastError
            ? `Database offline. Events queued for sync when connection is restored. Last error: ${sync.lastError}`
            : 'Database offline. Events queued for sync when connection is restored.';
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
    if (!authItem) {
        return;
    }

    const session = getWorkspaceAuthSession(context);
    if (session?.authenticated) {
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
            await openAuthView(context, storageManager);
        }
    }
// 👉 UPDATED CONSENT GATE
    const CURRENT_POLICY_VERSION = 'v1.0'; 
    const currentAuth = getWorkspaceAuthSession(context);
    
    if (currentAuth?.authenticated) {
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
    } else {
        state.isConsentGiven = false; 
    }
    if (process.env.CI === 'true') {
        console.log('[TBD Logger] CI environment detected: Auto-granting consent for automated tests.');
        state.isConsentGiven = true;
    }
    // 👉 END OF CONSENT GATE
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
    });
    context.subscriptions.push(authEditGuard);

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

    // Command: Test Database Connection — shows a detailed popup with connection status
    const testDbCommand = vscode.commands.registerCommand('tbd-logger.testDbConnection', async () => {
        const { getPool, isConnected } = await import('./db.js');
        const server = process.env.AZURE_SQL_SERVER || '(not set)';
        const database = process.env.AZURE_SQL_DATABASE || '(not set)';
        const user = process.env.AZURE_SQL_USER || '(not set)';

        if (isConnected()) {
            // Already connected — run a live query to confirm
            try {
                const { executeQuery } = await import('./db.js');
                const result = await executeQuery('SELECT COUNT(*) as cnt FROM Users');
                vscode.window.showInformationMessage(
                    `✅ Database ONLINE\nServer: ${server}\nDB: ${database}\nUser: ${user}\nUsers in DB: ${result.recordset[0].cnt}`
                );
            } catch (err: any) {
                vscode.window.showWarningMessage(`Pool says connected but query failed: ${err.message}`);
            }
            return;
        }

        if (storageManager.isConnecting()) {
            vscode.window.showInformationMessage(
                `⏳ Still connecting to database...\nServer: ${server}\nDB: ${database}\nUser: ${user}\nPlease wait and try again in a moment.`
            );
            return;
        }

        // Not connected — try a fresh connection now
        vscode.window.showInformationMessage(`🔄 Attempting connection to ${server}...`);
        try {
            await getPool();
            vscode.window.showInformationMessage(`✅ Connection succeeded!\nServer: ${server}\nDB: ${database}\nUser: ${user}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(
                `❌ Connection failed!\nServer: ${server}\nDB: ${database}\nUser: ${user}\nError: ${err.message}`
            );
        }
        void updateDbStatusBar();
    });
    context.subscriptions.push(testDbCommand);

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