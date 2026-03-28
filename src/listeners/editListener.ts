// Module: listeners/editListener.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { state, CONSTANTS } from '../state';
import { flushBuffer } from '../flush';
import { isIgnoredPath, formatTimestamp, formatDuration } from '../utils';
import { StandardEvent } from '../types';

export function createEditListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument((event) => {
        // The Student-Only Gate: Cut the microphone
        if (state.currentUserRole !== 'Student') {
            return; 
        }

        // 1. IGNORE CHECKS
        if (event.contentChanges.length === 0) { return; }
        if (!state.isConsentGiven) {return; }
        
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
            if (!state.externalCopiedText) {return false;}
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
            
            // MAGIC BULLET: If multiple characters arrive in a single millisecond tick, it's not human typing.
            const isMultiCharAtomic = change.text.length > 2;

            // DETERMINE EVENT TYPE
            if (isDelete) {
                eventType = isFocusMismatch ? 'ai-delete' : 'delete';
            } else if (isReplace) {
                if (isExternalCopy(change.text)) {
                    eventType = 'external-paste';
                } else if (isMultiCharAtomic) {
                    // Fast atomic replacement of multiple characters (Tab completion overwrite)
                    eventType = 'ai-replace';
                } else {
                    eventType = isFocusMismatch ? 'ai-replace' : 'replace';
                }
            } else if (isInsert) {
                if (isMultiCharAtomic) {
                    if (isExternalCopy(change.text)) {
                        eventType = 'external-paste';
                    } else {
                        // Fast atomic insertion of multiple characters (Inline AI / Tab completion)
                        eventType = 'ai-paste';
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
                flightTime: String(timeDiff > 15000 ? 0 : timeDiff), // Prevent massive AFK numbers
                eventType,
                fileEdit: fileEditRaw,
                fileView,
                charsAdded: change.text.length
            };

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