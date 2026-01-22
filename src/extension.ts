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
import { isIgnoredPath } from './utils';

export async function activate(context: vscode.ExtensionContext) {
    console.log('TBD Logger: activate');

    try { printSessionInfo(); } catch (e) { /* no-op */ }

    // Initialize storage manager (creates/ensures log file)
    await storageManager.init(context);

    // Initialize focused file state
    const initialActive = vscode.window.activeTextEditor;
    const initialPath = initialActive && initialActive.document ? vscode.workspace.asRelativePath(initialActive.document.uri, false) : '';
    state.currentFocusedFile = isIgnoredPath(initialPath) ? '' : initialPath;
    state.focusStartTime = Date.now();

    // Register the Open Logs command once
    const openLogs = async () => {
        try {
            await vscode.window.showInformationMessage('TBD Logger is currently logging this programming session.');
        } catch (err) {
            console.error('[TBD Logger] openLogs error:', err);
        }
    };
    const openLogsCommand = vscode.commands.registerCommand('tbd-logger.openLogs', openLogs);
    context.subscriptions.push(openLogsCommand);

    // Create status bar and start UI timer (status bar uses the commandId but doesn't register it)
    const statusBarItem = createStatusBar(context, 'tbd-logger.openLogs');
    const uiTimerDisposable = startUiTimer(statusBarItem);
    context.subscriptions.push(uiTimerDisposable);

    // Register listeners (each returns a Disposable)
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
    // Record final focus duration for the currently focused file
    const now = Date.now();
    if (state.currentFocusedFile) {
        const durationMs = now - state.focusStartTime;
        state.sessionBuffer.push({
            time: new Date(now).toISOString().replace('T', ' ').replace('Z', ''),
            flightTime: String(durationMs),
            eventType: 'focusDuration',
            fileEdit: '',
            fileView: state.currentFocusedFile
        } as any);
    }

    void flushBuffer();

    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    if (globalSb) { globalSb.dispose(); }
}
