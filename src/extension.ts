// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { StorageManager } from './storageManager';

// Define the shape of a single keystroke event
interface StandardEvent {
    time: string;            // formatted timestamp MM-DD-YYYY hh:mm:ss:SSS
    flightTime: string;      // ms since last event, as a string
    eventType: 'input' | 'paste' | 'delete' | 'undo' | 'focusChange';
    fileEdit: string;        // relative path of edited file (or empty string)
    fileView: string;        // relative path of the active editor file (or empty string)
    possibleAiDetection?: string; // optional note when fileEdit and fileView differ
}

// Create a buffer to hold data in memory before saving
let sessionBuffer: StandardEvent[] = [];
let lastEventTime: number = Date.now();

// Format timestamp as MM-DD-YYYY hh:mm:ss:SSS
function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const YYYY = String(d.getFullYear());
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const SSS = String(d.getMilliseconds()).padStart(3, '0');
    return `${MM}-${DD}-${YYYY} ${hh}:${mm}:${ss}:${SSS}`;
}

const storageManager = new StorageManager();
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;
let isFlushing = false;

// Activate — await storage initialization so logs are created in workspace .vscode
export async function activate(context: vscode.ExtensionContext) {

    console.log('Keystroke Tracker is active!');

    await storageManager.init(context);

    // Event listener: fires on user edits
    let listener = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) { return; }

        const currentTime = Date.now();
        const timeDiff = currentTime - lastEventTime;
        lastEventTime = currentTime;

        const formattedTime = formatTimestamp(currentTime);

        // Determine fileView once per change event (active editor at that moment)
        const active = vscode.window.activeTextEditor;
        const fileView = active && active.document ? vscode.workspace.asRelativePath(active.document.uri, false) : '';

        event.contentChanges.forEach((change) => {
            let eventType: StandardEvent['eventType'];
            if (change.text === '' && change.rangeLength > 0) {
                eventType = 'delete';
            } else if (change.text.length > 1) {
                eventType = 'paste';
            } else {
                eventType = 'input';
            }

            const fileEdit = event.document ? vscode.workspace.asRelativePath(event.document.uri, false) : '';

            const logEntry: StandardEvent = {
                time: formattedTime,
                flightTime: String(timeDiff),
                eventType,
                fileEdit,
                fileView
            };

            // If this is not a focusChange event and the edit/view files differ,
            // annotate the event for possible AI detection.
            if (eventType !== 'focusChange' && fileEdit !== fileView) {
                logEntry.possibleAiDetection = 'The fileView and the fileEdit are not the same, IDE cannot focus one file while editing another.';
            }

            // Push to in-memory buffer — no per-keystroke console output
            sessionBuffer.push(logEntry);

            // Trigger flush if threshold reached
            if (sessionBuffer.length >= FLUSH_THRESHOLD) {
                void flushBuffer();
            }
        });
    });

    context.subscriptions.push(listener);

    // Listen for focus/active-editor changes and record as focusChange events
    const focusListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        const currentTime = Date.now();
        const timeDiff = currentTime - lastEventTime;
        lastEventTime = currentTime;

        const formattedTime = formatTimestamp(currentTime);

        const fileView = editor && editor.document ? vscode.workspace.asRelativePath(editor.document.uri, false) : '';

        const focusEvent: StandardEvent = {
            time: formattedTime,
            flightTime: String(timeDiff),
            eventType: 'focusChange',
            fileEdit: '',
            fileView
        };

        sessionBuffer.push(focusEvent);
        if (sessionBuffer.length >= FLUSH_THRESHOLD) {
            void flushBuffer();
        }
    });
    context.subscriptions.push(focusListener);

    // Periodic flush timer
    const timer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// Flush in-memory buffer to storage (async-safe)
async function flushBuffer() {
    if (isFlushing) return;
    if (sessionBuffer.length === 0) return;
    isFlushing = true;
    const toSave = sessionBuffer.splice(0, sessionBuffer.length);
    try {
        const saved = await storageManager.flush(toSave);
        if (saved > 0) {
            console.log('[TBD Logger] Flushed', saved, 'events to disk');
        }
    } catch (err) {
        console.error('[TBD Logger] Flush error:', err);
        // Re-queue on failure (bounded)
        const prepend = toSave.concat(sessionBuffer).slice(-10000);
        sessionBuffer.length = 0;
        sessionBuffer.push(...prepend);
    } finally {
        isFlushing = false;
    }
}

// Deactivate: flush remaining events
export function deactivate() {
    void flushBuffer();
    console.log('Session ended. Total events captured (flushed on deactivate):', sessionBuffer.length);
}
