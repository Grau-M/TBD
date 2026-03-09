// Module: listeners/editListener.ts
// Purpose: Create a listener for text document changes. The listener
// classifies edits (insert, delete, replace, paste) and heuristically
// detects potential AI-assisted edits when the active editor does not
// match the document being edited. It then constructs `StandardEvent`
// objects and pushes them into the shared session buffer, triggering
// flushes when thresholds are reached.
import * as vscode from 'vscode';
import * as path from 'path';
import { state, CONSTANTS } from '../state';
import { flushBuffer } from '../flush';
import { isIgnoredPath, formatTimestamp, formatDuration } from '../utils';
import { StandardEvent } from '../types';

// Function: createEditListener
// Purpose: Return a Disposable that listens for text document changes and
// converts them into `StandardEvent` entries stored in `state.sessionBuffer`.
// The listener classifies edits (input, paste, delete, replace) and adds
// heuristics for detecting potential AI-assisted edits.
export function createEditListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument((event) => {
        // 1. IGNORE CHECKS
        if (event.contentChanges.length === 0) { return; }
        
        // Use relative path to check for ignored files (logs, enc, etc.)
        const docPath = vscode.workspace.asRelativePath(event.document.uri, false);
        if (isIgnoredPath(docPath)) {return;}

        // TIMING
        const currentTime = Date.now();
        const timeDiff = currentTime - state.lastEventTime;
        state.lastEventTime = currentTime;
        const formattedTime = formatTimestamp(currentTime);

        // 2. AI & CONTEXT DETECTION
        const activeEditor = vscode.window.activeTextEditor;
        
        // Check if the user is focusing on the file they are editing
        const isFocusMismatch = activeEditor 
            ? activeEditor.document.uri.toString() !== event.document.uri.toString() 
            : true; 

        // Get clean filenames
        const fileViewRaw = activeEditor ? path.basename(activeEditor.document.fileName) : 'System/Sidebar';
        const fileEdit = path.basename(event.document.fileName);
        const fileView = isIgnoredPath(fileViewRaw) ? '' : fileViewRaw;

        // helper to normalize line endings for clipboard comparison
        const normalize = (str: string) => str.replace(/\s+/g, '');
        const isExternalCopy = (text: string) => {
            if (!state.externalCopiedText) return false;
            // Now compares the raw characters without spaces/tabs breaking it
            return normalize(state.externalCopiedText).includes(normalize(text));
        };

        // 3. PROCESS CHANGES
        event.contentChanges.forEach((change) => {
            // Skip if the edit itself is in an ignored path (redundant safety)
            const fileEditRaw = event.document ? vscode.workspace.asRelativePath(event.document.uri, false) : '';
            if (isIgnoredPath(fileEditRaw)) {return;}

            let eventType: StandardEvent['eventType'];
            const isReplace = change.rangeLength > 0 && change.text !== '';
            const isDelete = change.rangeLength > 0 && change.text === '';
            const isInsert = change.rangeLength === 0 && change.text.length > 0;

            // DETERMINE EVENT TYPE
           if (isDelete) {
                eventType = isFocusMismatch ? 'ai-delete' : 'delete';
            } else if (isReplace) {
                if (isExternalCopy(change.text)) {
                    eventType = 'external-paste';
                } else {
                    eventType = isFocusMismatch ? 'ai-replace' : 'replace';
                }
            } else if (isInsert) {
                if (change.text.length > 1) {
                    if (isExternalCopy(change.text)) {
                        eventType = 'external-paste';
                    } else {
                        eventType = isFocusMismatch ? 'ai-paste' : 'paste';
                    }
                } else {
                    eventType = isFocusMismatch ? 'ai-paste' : 'input';
                }
            } else {
                eventType = 'input';
            }

            // CONSTRUCT LOG ENTRY
            const logEntry: StandardEvent = {
                time: formattedTime,
                flightTime: String(timeDiff),
                eventType,
                fileEdit: fileEditRaw,
                fileView
            };

            // We check if the event involves adding text (paste, replace, or ai-paste) and log the character count for potential AI detection heuristics and understanding paste sizes. 
            // This helps identify unusually large pastes that may indicate AI usage, especially when combined with focus mismatch.
            if (['paste', 'external-paste', 'ai-paste', 'replace', 'ai-replace'].includes(eventType)) {
                logEntry.pasteCharCount = change.text.length;
            }

            // ADD METADATA
            if (state.currentFocusedFile) {
                const focusDurationMs = Date.now() - state.focusStartTime;
                logEntry.fileFocusCount = formatDuration(focusDurationMs);
            } else {
                logEntry.fileFocusCount = '0s';
            }

            if (isFocusMismatch || fileEditRaw !== fileView) {
                logEntry.possibleAiDetection = 'WARNING: The file cannot be edited when the cursor isn\'t being focused on that file. Potential AI usage detected.';
            }

            // BUFFER & FLUSH
            state.sessionBuffer.push(logEntry);
            if (state.sessionBuffer.length >= CONSTANTS.FLUSH_THRESHOLD) {
                void flushBuffer();
            }
        });
    });
}