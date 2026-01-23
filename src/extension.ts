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

export async function activate(context: vscode.ExtensionContext) {
    console.log('TBD Logger: activate');

    try { printSessionInfo(); } catch (e) { /* no-op */ }

    // Initialize storage manager (creates/ensures encrypted file)
    await storageManager.init(context);

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
            // 1. Ask for Password
            const password = await vscode.window.showInputBox({
                prompt: 'Enter Administrator Password to view encrypted logs',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'TBD_CAPSTONE...'
            });

            if (!password) return; // User cancelled

            // 2. Retrieve & Decrypt
            const content = await storageManager.retrieveLogContent(password);
            
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

    // Create status bar and start UI timer
    const statusBarItem = createStatusBar(context, 'tbd-logger.openLogs');
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
}

export function deactivate() {
    // Record final focus duration
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