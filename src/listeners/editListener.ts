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
    // Make the handler async so we can instantly read the OS clipboard on massive inserts
    return vscode.workspace.onDidChangeTextDocument(async (event) => {
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

        // PROCESS CHANGES
        let totalAdded = 0;
        let totalDeleted = 0;
        let largestChangeText = '';

        // Extract the largest single block of text inserted (prevents multi-cursor paste bugs)
        event.contentChanges.forEach((change) => {
            totalAdded += change.text.length;
            totalDeleted += change.rangeLength;
            if (change.text.length > largestChangeText.length) {
                largestChangeText = change.text;
            }
        });

        const isReplace = totalDeleted > 0 && totalAdded > 0;
        const isDelete = totalDeleted > 0 && totalAdded === 0;
        const isInsert = totalDeleted === 0 && totalAdded > 0;
        
        // AI DETECTION: A human typing generates 1 char per event.
        // If > 1 char is inserted atomically, it was a Paste, Snippet, or AI.
        const isMultiCharAtomic = totalAdded > 1;

        // Instantly grab the REAL clipboard if an atomic block is dropped in
        let clipboardText = state.externalCopiedText || '';
        if (isMultiCharAtomic) {
            try {
                // Wrap in a timeout to prevent hanging in headless CI environments
                clipboardText = await Promise.race([
                    vscode.env.clipboard.readText(),
                    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Clipboard timeout')), 500))
                ]);
                state.externalCopiedText = clipboardText; // Keep state synced
            } catch (err) {
                // fallback to state if clipboard read fails or times out
            }
        }
        const normalize = (str: string) => str.replace(/\s+/g, '');
        const isExternalCopy = (text: string) => {
            if (!clipboardText) { return false; }
            const normClip = normalize(clipboardText);
            const normText = normalize(text);
            if (!normClip || !normText) { return false; }
            
            // STRICT MATCHING: The inserted text must exactly match the clipboard.
            // This prevents AI completions that happen to be substrings of an old clipboard 
            // from being falsely flagged as manual pastes.
            return normClip === normText;
        };

        let eventType: StandardEvent['eventType'];

        // CLASSIFICATION TREE
        if (isDelete) {
            eventType = isFocusMismatch ? 'ai-delete' : 'delete';
        } else if (isReplace) {
            if (isMultiCharAtomic) {
                if (isExternalCopy(largestChangeText)) {
                    eventType = 'replace'; // Manual replace via Ctrl+V
                } else {
                    eventType = 'ai-replace'; // AI Tab Completion over existing text
                }
            } else {
                eventType = isFocusMismatch ? 'ai-replace' : 'replace'; // Standard typing over selection
            }
        } else if (isInsert) {
            if (isMultiCharAtomic) {
                if (isExternalCopy(largestChangeText)) {
                    eventType = 'paste'; // Manual Ctrl+V
                } else {
                    eventType = 'ai-paste'; // AI Tab Completion / Snippet insertion
                }
            } else {
                eventType = isFocusMismatch ? 'ai-paste' : 'input'; // Standard human typing
            }
        } else {
            eventType = 'input';
        }

        // --- CHARS CHANGED LOGIC ---
        let charsChanged = 0;
        if (isDelete || eventType === 'ai-delete') {
            charsChanged = totalDeleted;
        } else if (eventType === 'ai-replace') {
            // VS Code Tab completions often replace the entire line prefix.
            // Subtracting totalDeleted gets us the *net new* characters the AI actually generated.
            charsChanged = totalAdded > totalDeleted ? (totalAdded - totalDeleted) : totalAdded;
        } else {
            // For human inputs, pastes, and regular replaces, record what was actually inserted
            charsChanged = totalAdded;
        }

        // BATCHING ENGINE: Group identical sequential events together
        if (pendingEditEvent) {
            const isSameFile = pendingEditEvent.fileEdit === fileEditRaw;
            const isSameType = pendingEditEvent.eventType === eventType;

            if (isSameFile && isSameType) {
                pendingEditEvent.charsAdded = (pendingEditEvent.charsAdded || 0) + charsChanged;
                
                if (['paste', 'ai-paste', 'replace', 'ai-replace'].includes(pendingEditEvent.eventType)) {
                    pendingEditEvent.pasteCharCount = pendingEditEvent.charsAdded;
                }

                if (editDebounceTimer) { clearTimeout(editDebounceTimer); }
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

        if (['paste', 'ai-paste', 'replace', 'ai-replace'].includes(eventType)) {
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
        if (editDebounceTimer) { clearTimeout(editDebounceTimer); }
        editDebounceTimer = setTimeout(pushPendingEvent, DEBOUNCE_MS);
    });
}