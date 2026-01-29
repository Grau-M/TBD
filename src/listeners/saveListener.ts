// Module: listeners/saveListener.ts
// Purpose: Listen for document save events and translate them into
// `StandardEvent` records pushed into the session buffer. Adds timing
// metadata, detects mismatches between the saved file and the currently
// active editor (possible AI indicator), and triggers flush when needed.
import * as vscode from 'vscode';
import { state, CONSTANTS } from '../state';
import { formatTimestamp, formatDuration } from '../utils';
import { StandardEvent } from '../types';
import { flushBuffer } from '../flush';

// Function: createSaveListener
// Purpose: Return a Disposable that listens for document save events and
// transforms them into `StandardEvent` records which are appended to the
// session buffer. Adds metadata such as focus duration and performs a
// simple AI-suspicion check when the saved file differs from the active
// file view.
export function createSaveListener(): vscode.Disposable {
    return vscode.workspace.onDidSaveTextDocument((doc) => {
        const currentTime = Date.now();
        const timeDiff = currentTime - state.lastEventTime;
        state.lastEventTime = currentTime;

        const formattedTime = formatTimestamp(currentTime);
        const fileEdit = doc ? vscode.workspace.asRelativePath(doc.uri, false) : '';
        const active = vscode.window.activeTextEditor;
        const fileView = active && active.document ? vscode.workspace.asRelativePath(active.document.uri, false) : '';

        const saveEvent: StandardEvent = {
            time: formattedTime,
            flightTime: String(timeDiff),
            eventType: 'save',
            fileEdit,
            fileView,
            fileFocusCount: state.currentFocusedFile ? formatDuration(Date.now() - state.focusStartTime) : '0s'
        };

        if (fileEdit !== fileView) {
            saveEvent.possibleAiDetection = 'The fileView and the fileEdit are not the same, IDE cannot focus one file while editing another.';
        }

        state.sessionBuffer.push(saveEvent);
        if (state.sessionBuffer.length >= CONSTANTS.FLUSH_THRESHOLD) void flushBuffer();
    });
}
