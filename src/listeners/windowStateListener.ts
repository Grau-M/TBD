// Module: listeners/windowStateListener.ts
// Purpose: Monitor the VS Code window focus state (e.g., when the user
// Alt-Tabs away or returns) and delegate to focus handlers to mark
// focus lost or regained accordingly.
import * as vscode from 'vscode';
import { handleFocusLost, handleFocusRegained } from '../handlers/focusHandlers';

// Function: createWindowStateListener
// Purpose: Return a Disposable that listens for global window focus
// changes and delegates to focus handlers to mark focus lost or
// regained when the entire VS Code window is blurred or focused.
export function createWindowStateListener(): vscode.Disposable {
    return vscode.window.onDidChangeWindowState((windowState) => {
        if (windowState.focused) {
            if (vscode.window.activeTextEditor) handleFocusRegained();
        } else {
            handleFocusLost();
        }
    });
}
