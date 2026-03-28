// Module: listeners/editListener.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { state, CONSTANTS } from '../state';
import { flushBuffer } from '../flush';
import { isIgnoredPath, formatTimestamp, formatDuration } from '../utils';
import { StandardEvent } from '../types';

let pendingEditEvent: StandardEvent | null = null;
let editDebounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 2000; // Wait 2 seconds of inactivity before pushing the batch

function pushPendingEvent() {
    if (pendingEditEvent) {
        state.sessionBuffer.push(pendingEditEvent);
        pendingEditEvent = null;
        
        if (state.sessionBuffer.length >= CONSTANTS.FLUSH_THRESHOLD) {
            void flushBuffer();
        }
    }
}

export function createEditListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument((event) => {
        // The Student-Only Gate: Cut the microphone
        if (state.currentUserRole !== 'Student') {
            return; 
        }

        if (event.contentChanges.length === 0) { return; }
        if (!state.isConsentGiven) { return; }
        
        const docPath = vscode.workspace.asRelativePath(event.document.uri, false);
        if (isIgnoredPath(docPath)) { return; }

        const currentTime = Date.now();
        const timeDiff = currentTime - state.lastEventTime;
        state.lastEventTime = currentTime;
        const formattedTime = formatTimestamp(currentTime);

        const activeEditor = vscode.window.activeTextEditor;
        const isFocusMismatch = activeEditor 
            ? activeEditor.document.uri.toString() !== event.document.uri.toString() 
            : true; 

        const fileViewRaw = activeEditor ? path.basename(activeEditor.document.fileName) : 'System/Sidebar';
        const fileEditRaw = event.document ? vscode.workspace.asRelativePath(event.document.uri, false) : '';
        const fileView = isIgnoredPath(fileViewRaw) ? '' : fileViewRaw;

        if (isIgnoredPath(fileEditRaw)) { return; }

        const normalize = (str: string) => str.replace(/\s+/g, '');
        const isExternalCopy = (text: string) => {
            if (!state.externalCopiedText) {return false;}
            return normalize(state.externalCopiedText).includes(normalize(text));
        };

        // PROCESS CHANGES
        let totalAdded = 0;
        let totalDeleted = 0;
        let lastChangeText = '';

        event.contentChanges.forEach((change) => {
            totalAdded += change.text.length;
            totalDeleted += change.rangeLength;
            if (change.text.length > 0) {
                lastChangeText = change.text;
            }
        });

        let eventType: StandardEvent['eventType'];
        const isReplace = totalDeleted > 0 && totalAdded > 0;
        const isDelete = totalDeleted > 0 && totalAdded === 0;
        const isInsert = totalDeleted === 0 && totalAdded > 0;
        
        // AI DETECTION: A human typing generates 1 char per event.
        // If a single event contains > 2 chars, it was inserted atomically (Paste, Snippet, AI).
        const isMultiCharAtomic = totalAdded > 2;

        if (isDelete) {
            eventType = isFocusMismatch ? 'ai-delete' : 'delete';
        } else if (isReplace) {
            if (isExternalCopy(lastChangeText)) {
                eventType = 'external-paste';
            } else if (isMultiCharAtomic) {
                eventType = 'ai-replace';
            } else {
                eventType = isFocusMismatch ? 'ai-replace' : 'replace';
            }
        } else if (isInsert) {
            if (isMultiCharAtomic) {
                if (isExternalCopy(lastChangeText)) {
                    eventType = 'external-paste';
                } else {
                    eventType = 'ai-paste'; // Tab completions / Inline AI
                }
            } else {
                eventType = isFocusMismatch ? 'ai-paste' : 'input';
            }
        } else {
            eventType = 'input';
        }

        // --- NEW CHARS CHANGED LOGIC ---
        let charsChanged = 0;
        if (isDelete || eventType === 'ai-delete') {
            charsChanged = totalDeleted;
        } else if (eventType === 'ai-replace') {
            // VS Code Tab completions often replace the entire line prefix.
            // Subtracting totalDeleted gets us the *net new* characters the AI actually generated.
            charsChanged = totalAdded > totalDeleted ? (totalAdded - totalDeleted) : totalAdded;
        } else {
            // For human inputs, pastes, and replaces, we care about what they actually put in.
            charsChanged = totalAdded;
        }

        // BATCHING ENGINE: Group identical sequential events together
        if (pendingEditEvent) {
            const isSameFile = pendingEditEvent.fileEdit === fileEditRaw;
            const isSameType = pendingEditEvent.eventType === eventType;

            if (isSameFile && isSameType) {
                pendingEditEvent.charsAdded = (pendingEditEvent.charsAdded || 0) + charsChanged;
                
                if (['paste', 'external-paste', 'ai-paste', 'replace', 'ai-replace'].includes(pendingEditEvent.eventType)) {
                    pendingEditEvent.pasteCharCount = pendingEditEvent.charsAdded;
                }

                if (editDebounceTimer) clearTimeout(editDebounceTimer);
                editDebounceTimer = setTimeout(pushPendingEvent, DEBOUNCE_MS);
                return;
            } else {
                pushPendingEvent();
            }
        }

        // CREATE NEW BATCH
        pendingEditEvent = {
            time: formattedTime,
            flightTime: String(timeDiff > 15000 ? 0 : timeDiff),
            eventType,
            fileEdit: fileEditRaw,
            fileView,
            charsAdded: charsChanged
        };

        if (['paste', 'external-paste', 'ai-paste', 'replace', 'ai-replace'].includes(eventType)) {
            pendingEditEvent.pasteCharCount = charsChanged;
        }

        if (state.currentFocusedFile) {
            const focusDurationMs = Date.now() - state.focusStartTime;
            pendingEditEvent.fileFocusCount = formatDuration(focusDurationMs);
        } else {
            pendingEditEvent.fileFocusCount = '0s';
        }

        if (isFocusMismatch || fileEditRaw !== fileView) {
            pendingEditEvent.possibleAiDetection = 'WARNING: The file cannot be edited when the cursor isn\'t being focused on that file. Potential AI usage detected.';
        }

        // Start quiet timer
        if (editDebounceTimer) clearTimeout(editDebounceTimer);
        editDebounceTimer = setTimeout(pushPendingEvent, DEBOUNCE_MS);
    });
}