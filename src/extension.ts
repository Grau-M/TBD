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

import * as path from 'path';
// define api for testing purposes
export interface ExtensionApi {
    state: typeof state;
    storageManager: typeof storageManager;
}

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
                if (!pick) return;
                const chosen = files.find(f => f.label === pick);
                if (!chosen) return;
                targetUri = chosen.uri;
            }

            // 1. Ask for Password
            const password = await vscode.window.showInputBox({
                prompt: `Enter Administrator Password to view ${path.basename(targetUri.fsPath)}`,
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'TBD_CAPSTONE...'
            });

            if (!password) return; // User cancelled

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
            if (!password) return;
            const content = await storageManager.retrieveHiddenLogContent(password);
            const doc = await vscode.workspace.openTextDocument({ content: content, language: 'json' });
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
            vscode.window.showErrorMessage(`Unable to access deletion activity log: ${err}`);
        }
    };
    const showHiddenCommand = vscode.commands.registerCommand('tbd-logger.showHiddenDeletions', showHidden);
    context.subscriptions.push(showHiddenCommand);

    // Create status bar and start UI timer (also show small lock icon wired to hidden deletions)
    const statusBarItem = createStatusBar(context, 'tbd-logger.openLogs', 'tbd-logger.showHiddenDeletions');
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

    // Periodic flush timer
    const flushTimer = setInterval(() => void flushBuffer(), CONSTANTS.FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });
    //Return the internals so the Test Suite can see them
    return { state, storageManager };
}

export function deactivate() {
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
}