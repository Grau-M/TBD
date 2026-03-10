// Module: extension.ts
// Purpose: Extension activation and deactivation entrypoints.
// This file initializes the extension: it sets up the storage manager,
// session interruption tracker, status bar UI, listeners, commands,
// and periodic background flush. It also exposes a minimal API for
// tests and marks clean shutdown on deactivate.
import * as vscode from 'vscode';
import { printSessionInfo } from './sessionInfo';
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

import * as path from 'path';

// Function to update database status bar item
async function updateDbStatusBar(): Promise<void> {
    const statusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!statusItem) return;

    if (storageManager.isConnecting()) {
        statusItem.text = '$(loading~spin) Connecting...';
        statusItem.tooltip = 'Connecting to database...';
    } else if (storageManager.isOnline()) {
        statusItem.text = '$(database) Online';
        statusItem.tooltip = 'Database connection is active';
    } else {
        statusItem.text = '$(database) Offline';
        statusItem.tooltip = 'Database offline. Events queued for sync when connection restored.';
    }
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

    // NEW FEATURE: Detect Session Interruptions (inactivity / abnormal end / clean shutdown)
    await SessionInterruptionTracker.install(context, {
        inactivityThresholdMs: 5 * 60 * 1000, // 5 minutes (change if you want)
        checkEveryMs: 10_000
    });


    // NEW: Log Session Start (Persistent Marker)
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

    // UPDATED: Open Logs Command with Password Prompt
    const openLogs = async () => {
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
    const openTeacherCommand = vscode.commands.registerCommand('tbd-logger.openTeacherView', () => openTeacherView(context));
    context.subscriptions.push(openTeacherCommand);

    // Create status bar and start UI timer (also show small lock icon wired to open Teacher Dashboard)
    const statusBarItem = createStatusBar(context, 'tbd-logger.openLogs', 'tbd-logger.openTeacherView');
    const uiTimerDisposable = startUiTimer(statusBarItem);
    context.subscriptions.push(uiTimerDisposable);

    // Register listeners
    const editListener = createEditListener();
    context.subscriptions.push(editListener);

    const focusListener = createFocusListener();
    context.subscriptions.push(focusListener);

    const windowStateListener = createWindowStateListener();
    context.subscriptions.push(windowStateListener);

    const saveListener = createSaveListener();
    context.subscriptions.push(saveListener);

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

    //Return the internals so the Test Suite can see them
    return { state, storageManager };
}

export function deactivate() {
    // Function: deactivate
    // Purpose: VS Code extension deactivation entrypoint. Records final
    // focus duration, marks clean shutdown for the interruption
    // tracker, flushes the buffer and disposes the status bar item.
    // Record final focus duration

    // NEW FEATURE: Mark clean shutdown (lets us detect force-close/crash next time)
    SessionInterruptionTracker.markCleanShutdown();

    const now = Date.now();
    if (state.currentFocusedFile) {
        const durationMs = now - state.focusStartTime;
        state.sessionBuffer.push({
            time: formatTimestamp(now),
            flightTime: String(durationMs),
            eventType: 'focusDuration',
            fileEdit: '',
            fileView: state.currentFocusedFile
        });
    }

    void flushBuffer();

    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    if (globalSb) { globalSb.dispose(); }
    
    // Close database connection
    void storageManager.dispose();
    
    // Clear status bar items
    const dbStatusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (dbStatusItem) {
        dbStatusItem.dispose();
    }
}