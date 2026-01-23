import * as vscode from 'vscode';
import { state, CONSTANTS } from '../state';
import { formatTimestamp, formatDuration } from '../utils';
import { StandardEvent } from '../types';
import { flushBuffer } from '../flush';

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
