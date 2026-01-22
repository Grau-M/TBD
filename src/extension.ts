// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { StorageManager } from './storageManager';
import { printSessionInfo } from './sessionInfo';

// Define the shape of a single keystroke event
interface StandardEvent {
    time: string;            // formatted timestamp MM-DD-YYYY hh:mm:ss:SSS
    flightTime: string;      // ms since last event, as a string
    eventType: 'input' | 'paste' | 'delete' | 'undo' | 'focusChange' | 'focusDuration' | 'save';
    fileEdit: string;        // relative path of edited file (or empty string)
    fileView: string;        // relative path of the active editor file (or empty string)
    possibleAiDetection?: string; // optional note when fileEdit and fileView differ
    fileFocusCount?: string; // optional human-friendly duration on focused file
}

// Create a buffer to hold data in memory before saving
let sessionBuffer: StandardEvent[] = [];
let lastEventTime: number = Date.now();
let currentFocusedFile: string = '';
let focusStartTime: number = Date.now();

// Ignore tracking for files inside .vscode or session log files
function isIgnoredPath(relPath: string): boolean {
    if (!relPath) return true;
    const p = relPath.replace(/\\/g, '/');
    if (p.startsWith('.vscode/')) return true;
    if (p.includes('tbd-session-')) return true;
    if (p.endsWith('.log')) return true;
    return false;
}

// Format duration in ms into human-friendly string
function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    const totalSec = Math.floor(ms / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

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

    // Print session info (user and project) on activation
    try { printSessionInfo(); } catch (e) { /* no-op */ }

    await storageManager.init(context);

    // Initialize current focused file/time based on active editor
    const initialActive = vscode.window.activeTextEditor;
    const initialPath = initialActive && initialActive.document ? vscode.workspace.asRelativePath(initialActive.document.uri, false) : '';
    currentFocusedFile = isIgnoredPath(initialPath) ? '' : initialPath;
    focusStartTime = Date.now();

    // Register command to open/reveal logs (shows informational message with View Logs button)
    const openLogs = async () => {
        try {
            // Informational message only (no action buttons)
            await vscode.window.showInformationMessage('TBD Logger is currently logging this programming session.');
        } catch (err) {
            console.error('[TBD Logger] openLogs error:', err);
        }
    };

    const openLogsCommand = vscode.commands.registerCommand('tbd-logger.openLogs', openLogs);
    context.subscriptions.push(openLogsCommand);

    // Create a branded Status Bar item on the far left with very high priority
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    // Use an octicon eye to the right of the label so we avoid custom image issues
    statusBarItem.text = 'TBD Logger $(eye)';
    statusBarItem.tooltip = 'Capstone TBD: Keystroke Logging Active';
    statusBarItem.command = 'tbd-logger.openLogs';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Event listener: fires on user edits
    let listener = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) { return; }

        const currentTime = Date.now();
        const timeDiff = currentTime - lastEventTime;
        lastEventTime = currentTime;

        const formattedTime = formatTimestamp(currentTime);

        // Determine fileView once per change event (active editor at that moment)
        const active = vscode.window.activeTextEditor;
        const fileViewRaw = active && active.document ? vscode.workspace.asRelativePath(active.document.uri, false) : '';
        const fileView = isIgnoredPath(fileViewRaw) ? '' : fileViewRaw;

        event.contentChanges.forEach((change) => {
            const fileEditRaw = event.document ? vscode.workspace.asRelativePath(event.document.uri, false) : '';
            // If the edit is in our session file or .vscode, ignore it (we wrote it)
            if (isIgnoredPath(fileEditRaw)) return;
            const fileEdit = fileEditRaw;

            let eventType: StandardEvent['eventType'];
            if (change.text === '' && change.rangeLength > 0) {
                eventType = 'delete';
            } else if (change.text.length > 1) {
                eventType = 'paste';
            } else {
                eventType = 'input';
            }

            const logEntry: StandardEvent = {
                time: formattedTime,
                flightTime: String(timeDiff),
                eventType,
                fileEdit,
                fileView
            };
            // Always include fileFocusCount: how long the current focused file has been focused
            if (currentFocusedFile) {
                const focusDurationMs = Date.now() - focusStartTime;
                logEntry.fileFocusCount = formatDuration(focusDurationMs);
            } else {
                logEntry.fileFocusCount = '0s';
            }

            // If the edit/view files differ, annotate the event for possible AI detection.
            if (fileEdit !== fileView) {
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

        // Compute and record duration for the file that was previously focused
        if (currentFocusedFile) {
            const durationMs = currentTime - focusStartTime;
            const durationEvent: StandardEvent = {
                time: formatTimestamp(currentTime),
                flightTime: String(durationMs),
                eventType: 'focusDuration',
                fileEdit: '',
                fileView: currentFocusedFile,
                fileFocusCount: formatDuration(durationMs)
            };
            sessionBuffer.push(durationEvent);
        }

        const timeDiff = currentTime - lastEventTime;
        lastEventTime = currentTime;

        const formattedTime = formatTimestamp(currentTime);

        const rawFileView = editor && editor.document ? vscode.workspace.asRelativePath(editor.document.uri, false) : '';
        const fileView = isIgnoredPath(rawFileView) ? '' : rawFileView;

        const focusEvent: StandardEvent = {
            time: formattedTime,
            flightTime: String(timeDiff),
            eventType: 'focusChange',
            fileEdit: '',
            fileView,
            fileFocusCount: '0s'
        };

        // update current focus tracking (ignore .vscode/session files)
        currentFocusedFile = fileView;
        focusStartTime = currentTime;

        sessionBuffer.push(focusEvent);
        if (sessionBuffer.length >= FLUSH_THRESHOLD) {
            void flushBuffer();
        }
    });
    context.subscriptions.push(focusListener);

    // Listen for saves (user-triggered or programmatic) and record save events
    const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
        const currentTime = Date.now();
        const timeDiff = currentTime - lastEventTime;
        lastEventTime = currentTime;

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
            fileFocusCount: currentFocusedFile ? formatDuration(Date.now() - focusStartTime) : '0s'
        };

        if (fileEdit !== fileView) {
            saveEvent.possibleAiDetection = 'The fileView and the fileEdit are not the same, IDE cannot focus one file while editing another.';
        }

        sessionBuffer.push(saveEvent);
        if (sessionBuffer.length >= FLUSH_THRESHOLD) {
            void flushBuffer();
        }
    });
    context.subscriptions.push(saveListener);

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
    // Record final focus duration for the currently focused file
    const now = Date.now();
    if (currentFocusedFile) {
        const durationMs = now - focusStartTime;
        const durationEvent: StandardEvent = {
            time: formatTimestamp(now),
            flightTime: String(durationMs),
            eventType: 'focusDuration',
            fileEdit: '',
            fileView: currentFocusedFile
        };
        sessionBuffer.push(durationEvent);
    }

    void flushBuffer();
    console.log('Session ended. Total events captured (flushed on deactivate):', sessionBuffer.length);
}
