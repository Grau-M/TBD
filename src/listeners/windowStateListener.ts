// Module: listeners/windowStateListener.ts
// Purpose: Monitor the VS Code window focus state (e.g., when the user
// Alt-Tabs away or returns) and delegate to focus handlers to mark
// focus lost or regained accordingly.
import * as vscode from 'vscode';
import { handleFocusLost, handleFocusRegained } from '../handlers/focusHandlers';
import { state } from '../state';

// Function: createWindowStateListener
// Purpose: Return a Disposable that listens for global window focus
// changes and delegates to focus handlers to mark focus lost or
// regained when the entire VS Code window is blurred or focused.
export function createWindowStateListener(): vscode.Disposable {
    return vscode.window.onDidChangeWindowState(async (windowState) => {
        if (!state.isConsentGiven) {return; }
        if (windowState.focused) {
            if (vscode.window.activeTextEditor) {handleFocusRegained();}
            
            // Check if clipboard changed while user was outside VS Code
            try {
                const currentClipboard = await vscode.env.clipboard.readText();
                if (currentClipboard !== state.clipboardOnBlur) {
                    state.externalCopiedText = currentClipboard;
                }
            } catch (e) {
                console.error("Failed to read clipboard on focus", e);
            }
        } else {
            handleFocusLost();
            
            // Record clipboard state right as user leaves VS Code
            try {
                state.clipboardOnBlur = await vscode.env.clipboard.readText();
            } catch (e) {
                console.error("Failed to read clipboard on blur", e);
            }
        }
    });
}
