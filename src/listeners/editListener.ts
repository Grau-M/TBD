import * as vscode from 'vscode';
import * as path from 'path';
import { state, CONSTANTS } from '../state';
import { formatTimestamp, formatDuration, isIgnoredPath } from '../utils';
import { StandardEvent } from '../types';
import { flushBuffer } from '../flush';

export function createEditListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.fileName.endsWith('.log') || event.document.fileName.endsWith('.json')) { return; }
        if (event.contentChanges.length === 0) { return; }

        const currentTime = Date.now();
        const timeDiff = currentTime - state.lastEventTime;
        state.lastEventTime = currentTime;
        const formattedTime = formatTimestamp(currentTime);

        const activeEditor = vscode.window.activeTextEditor;
        const isFocusMismatch = activeEditor
            ? activeEditor.document.uri.toString() !== event.document.uri.toString()
            : true;

        const fileViewRaw = activeEditor ? path.basename(activeEditor.document.fileName) : 'System/Sidebar';
        const fileView = isIgnoredPath(fileViewRaw) ? '' : fileViewRaw;

        event.contentChanges.forEach((change) => {
            const fileEditRaw = event.document ? vscode.workspace.asRelativePath(event.document.uri, false) : '';
            if (isIgnoredPath(fileEditRaw)) return;

            let eventType: StandardEvent['eventType'];
            const isReplace = change.rangeLength > 0 && change.text !== '';
            const isDelete = change.rangeLength > 0 && change.text === '';
            const isInsert = change.rangeLength === 0 && change.text.length > 0;

            if (isDelete) eventType = isFocusMismatch ? 'ai-delete' : 'delete';
            else if (isReplace) eventType = isFocusMismatch ? 'ai-replace' : 'replace';
            else if (isInsert) eventType = change.text.length > 1 ? (isFocusMismatch ? 'ai-paste' : 'paste') : (isFocusMismatch ? 'ai-paste' : 'input');
            else eventType = 'input';

            const logEntry: StandardEvent = {
                time: formattedTime,
                flightTime: String(timeDiff),
                eventType,
                fileEdit: fileEditRaw,
                fileView
            };

            if (state.currentFocusedFile) {
                const focusDurationMs = Date.now() - state.focusStartTime;
                logEntry.fileFocusCount = formatDuration(focusDurationMs);
            } else {
                logEntry.fileFocusCount = '0s';
            }

            if (isFocusMismatch || fileEditRaw !== fileView) {
                logEntry.possibleAiDetection = 'WARNING: The file cannot be edited when the cursor isn\'t being focused on that file. Potential AI usage detected.';
            }
            state.sessionBuffer.push(logEntry);
            if (state.sessionBuffer.length >= CONSTANTS.FLUSH_THRESHOLD) void flushBuffer();
        });
    });
}
