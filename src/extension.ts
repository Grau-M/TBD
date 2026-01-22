import * as vscode from 'vscode';
import { StorageManager } from './storageManager';
import { printSessionInfo } from './sessionInfo';
import * as path from 'path';

// --- 1. DEFINITIONS ---

// Combined Interface (Superset of both)
interface StandardEvent {
    time: string;
    flightTime: string;
    eventType: 'input' | 'paste' | 'delete' | 'replace' | 'undo' | 'focusChange' | 'focusDuration' | 'save' | 'ai-paste' | 'ai-delete' | 'ai-replace';
    fileEdit: string;
    fileView: string;
    possibleAiDetection?: string;
    fileFocusCount?: string; // Kept from File 1
}

let sessionBuffer: StandardEvent[] = [];
let lastEventTime: number = Date.now();

// TRACKING VARIABLES
let focusAwayStartTime: number | null = null;
let lastLoggedFileView: string = '';
let sessionStartTime: number = Date.now();
let currentFocusedFile: string = ''; // Kept from File 1
let focusStartTime: number = Date.now(); // Kept from File 1

// UI VARIABLES
let statusBarItem: vscode.StatusBarItem;

// CONSTANTS
const FOCUS_THRESHOLD_MS = 15000; 
const FLUSH_INTERVAL_MS = 10000; 
const FLUSH_THRESHOLD = 50;

const storageManager = new StorageManager();
let isFlushing = false;

// --- 2. HELPER FUNCTIONS ---

function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').replace('Z', '');
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Kept from File 1: Essential for filtering noise
function isIgnoredPath(relPath: string): boolean {
    if (!relPath) return true;
    const p = relPath.replace(/\\/g, '/');
    if (p.startsWith('.vscode/')) return true;
    if (p.includes('tbd-session-')) return true;
    if (p.endsWith('.log') || p.endsWith('.json')) return true;
    return false;
}

// --- 3. FOCUS LOGIC ---

function handleFocusLost() {
    // Only start the timer if we aren't ALREADY away
    if (!focusAwayStartTime) {
        focusAwayStartTime = Date.now();
        
        // Immediate UI Update (The Loop will take over shortly)
        if (statusBarItem) {
            statusBarItem.text = `$(warning) AWAY 00:00:00`;
            statusBarItem.color = new vscode.ThemeColor('charts.yellow');
            statusBarItem.tooltip = "Focus Lost! Come back to VS Code to stop this timer.";
        }
    }
}

function handleFocusRegained() {
    // Stop the "Away" timer
    if (focusAwayStartTime) {
        const currentTime = Date.now();
        const timeAway = currentTime - focusAwayStartTime;
        focusAwayStartTime = null; // Reset

        // LOGGING LOGIC (Only log if > 15s)
        if (timeAway >= FOCUS_THRESHOLD_MS) {
            sessionBuffer.push({
                time: formatTimestamp(currentTime),
                flightTime: String(timeAway), 
                eventType: 'focusChange',
                fileEdit: '',
                fileView: 'Focus Away (Major)' 
            });
        }
    }
}

// --- 4. ACTIVATION ---

export async function activate(context: vscode.ExtensionContext) {
    console.log('Keystroke Tracker is active!');

    // Initialize Storage & Session Info
    try { printSessionInfo(); } catch (e) { /* no-op */ }
    await storageManager.init(context);

    // Initialize State
    const initialActive = vscode.window.activeTextEditor;
    const initialPath = initialActive && initialActive.document ? vscode.workspace.asRelativePath(initialActive.document.uri, false) : '';
    currentFocusedFile = isIgnoredPath(initialPath) ? '' : initialPath;
    focusStartTime = Date.now();

    // REGISTER COMMAND: Open Logs (From File 1)
    const openLogs = async () => {
        try {
            await vscode.window.showInformationMessage('TBD Logger is currently logging this programming session.');
        } catch (err) {
            console.error('[TBD Logger] openLogs error:', err);
        }
    };
    const openLogsCommand = vscode.commands.registerCommand('tbd-logger.openLogs', openLogs);
    context.subscriptions.push(openLogsCommand);

    // STATUS BAR SETUP
    // Combined: Used File 2's Right alignment for timer, but added File 1's command to make it clickable
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'tbd-logger.openLogs'; 
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // TIMER LOOP (From File 2) - Updates the UI dynamically
    const uiTimer = setInterval(() => {
        const now = Date.now();

        if (focusAwayStartTime) {
            // AWAY MODE
            const awayDuration = now - focusAwayStartTime;
            statusBarItem.text = `$(warning) AWAY ${formatDuration(awayDuration)}`;
            statusBarItem.color = new vscode.ThemeColor('charts.yellow'); 
        } else {
            // RECORDING MODE
            const sessionDuration = now - sessionStartTime;
            statusBarItem.text = `$(circle-filled) REC ${formatDuration(sessionDuration)}`;
            statusBarItem.color = new vscode.ThemeColor('errorForeground'); 
            statusBarItem.tooltip = "TBD Extension: Session Recording in Progress (Click for info)";
        }
    }, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(uiTimer) });

    // --- LISTENERS ---

    // 1. MAIN LISTENER (EDITS)
    // Using File 1's logic (with isIgnoredPath) + File 2's AI detection logic
    let listener = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.fileName.endsWith('.log') || event.document.fileName.endsWith('.json')) { return; }
        if (event.contentChanges.length === 0) { return; }

        const currentTime = Date.now();
        const timeDiff = currentTime - lastEventTime;
        lastEventTime = currentTime;
        const formattedTime = formatTimestamp(currentTime);

        const activeEditor = vscode.window.activeTextEditor;
        const isFocusMismatch = activeEditor 
            ? activeEditor.document.uri.toString() !== event.document.uri.toString() 
            : true; 

        const fileViewRaw = activeEditor ? path.basename(activeEditor.document.fileName) : 'System/Sidebar';
        const fileEdit = path.basename(event.document.fileName);
        const fileView = isIgnoredPath(fileViewRaw) ? '' : fileViewRaw;

        event.contentChanges.forEach((change) => {
            const fileEditRaw = event.document ? vscode.workspace.asRelativePath(event.document.uri, false) : '';
            // Filter internal edits (File 1 feature)
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

            // Calculate Focus Count (File 1 feature)
            if (currentFocusedFile) {
                const focusDurationMs = Date.now() - focusStartTime;
                logEntry.fileFocusCount = formatDuration(focusDurationMs);
            } else {
                logEntry.fileFocusCount = '0s';
            }

            if (isFocusMismatch || fileEditRaw !== fileView) {
                logEntry.possibleAiDetection = 'WARNING: The file cannot be edited when the cursor isn\'t being focused on that file. Potential AI usage detected.';
            }
            sessionBuffer.push(logEntry);
            if (sessionBuffer.length >= FLUSH_THRESHOLD) void flushBuffer();
        });
    });
    context.subscriptions.push(listener);

    // 2. EDITOR FOCUS LISTENER (Tabs/Sidebar)
    const focusListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        lastEventTime = Date.now();
        
        if (!editor) {
            // User clicked Terminal or Sidebar
            handleFocusLost();
        } else {
            // User clicked an Editor Tab
            handleFocusRegained();

            // Track detailed focus stats (File 1 feature)
            const newPath = editor.document ? vscode.workspace.asRelativePath(editor.document.uri, false) : '';
            if (!isIgnoredPath(newPath)) {
                currentFocusedFile = newPath;
                focusStartTime = Date.now();
            } else {
                currentFocusedFile = '';
            }

            // Log Context Switch if file changed
            const currentFileView = path.basename(editor.document.fileName);
            if (currentFileView !== lastLoggedFileView) {
                sessionBuffer.push({
                    time: formatTimestamp(Date.now()),
                    flightTime: '0',
                    eventType: 'focusChange',
                    fileEdit: '',
                    fileView: currentFileView
                });
                lastLoggedFileView = currentFileView;
            }
        }
    });
    context.subscriptions.push(focusListener);

    // 3. WINDOW FOCUS LISTENER (Alt-Tab / OS Switching)
    // CRITICAL ADDITION FROM FILE 2
    const windowStateListener = vscode.window.onDidChangeWindowState((windowState) => {
        if (windowState.focused) {
            // User Alt-Tabbed BACK to VS Code
            if (vscode.window.activeTextEditor) {
                handleFocusRegained();
            }
            // If they landed on sidebar, we leave the timer running (handled by focusListener)
        } else {
            // User Alt-Tabbed AWAY from VS Code (Spotify, Chrome, etc.)
            handleFocusLost();
        }
    });
    context.subscriptions.push(windowStateListener);

    // 4. SAVE LISTENER (From File 1)
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

    // Buffer Flush Timer
    const flushTimer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });
}

// --- 5. TEARDOWN ---

async function flushBuffer() {
    if (isFlushing || sessionBuffer.length === 0) return;
    isFlushing = true;
    const toSave = sessionBuffer.splice(0, sessionBuffer.length);
    
    try {
        await storageManager.flush(toSave);
    } catch (err) {
        console.error('Flush error:', err);
        sessionBuffer.unshift(...toSave);
    } finally {
        isFlushing = false;
    }
}

export function deactivate() {
    // Record final focus duration for the currently focused file (File 1 feature)
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
    if (statusBarItem) { statusBarItem.dispose(); }
}