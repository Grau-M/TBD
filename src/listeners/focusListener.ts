// Module: listeners/focusListener.ts
// Purpose: Listen for active editor changes and update the shared state.
// When the active editor changes it updates `state.currentFocusedFile`,
// logs focusChange events when the visible file changes, and delegates
// focus-lost/regained handling to the focus handlers.
import * as vscode from 'vscode';
import * as path from 'path';
import { state } from '../state';
import { formatTimestamp, isIgnoredPath } from '../utils';
import { handleFocusLost, handleFocusRegained } from '../handlers/focusHandlers';

// Function: createFocusListener
// Purpose: Return a Disposable that listens for active editor changes.
// Updates `state.currentFocusedFile`, handles focus lost/regained via
// handlers, and emits focusChange events into the session buffer when
// the visible file changes.
export function createFocusListener(): vscode.Disposable {
    return vscode.window.onDidChangeActiveTextEditor((editor) => {
        state.lastEventTime = Date.now();

        if (!editor) {
            handleFocusLost();
        } else {
            handleFocusRegained();

            const newPath = editor.document ? vscode.workspace.asRelativePath(editor.document.uri, false) : '';
            if (!isIgnoredPath(newPath)) {
                state.currentFocusedFile = newPath;
                state.focusStartTime = Date.now();
            } else {
                state.currentFocusedFile = '';
            }

            const currentFileView = path.basename(editor.document.fileName);
            if (currentFileView !== state.lastLoggedFileView) {
                state.sessionBuffer.push({
                    time: formatTimestamp(Date.now()),
                    flightTime: '0',
                    eventType: 'focusChange',
                    fileEdit: '',
                    fileView: currentFileView
                });
                state.lastLoggedFileView = currentFileView;
            }
        }
    });
}
