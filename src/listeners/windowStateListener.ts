import * as vscode from 'vscode';
import { handleFocusLost, handleFocusRegained } from '../handlers/focusHandlers';

export function createWindowStateListener(): vscode.Disposable {
    return vscode.window.onDidChangeWindowState((windowState) => {
        if (windowState.focused) {
            if (vscode.window.activeTextEditor) handleFocusRegained();
        } else {
            handleFocusLost();
        }
    });
}
