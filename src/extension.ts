import * as vscode from 'vscode';
import { StorageManager } from './storageManager';
import * as path from 'path';

// 1. Define the event types
interface StandardEvent {
    time: string;
    flightTime: string;
    eventType: 'input' | 'paste' | 'delete' | 'replace' | 'undo' | 'focusChange' | 'ai-paste' | 'ai-delete' | 'ai-replace';
    fileEdit: string;
    fileView: string;
    possibleAiDetection?: string;
}

let sessionBuffer: StandardEvent[] = [];
let lastEventTime: number = Date.now();

// TRACKING VARIABLES
let focusAwayStartTime: number | null = null;
let lastLoggedFileView: string = '';
let sessionStartTime: number = Date.now();

// UI VARIABLES
let statusBarItem: vscode.StatusBarItem;

// 15 Second Threshold
const FOCUS_THRESHOLD_MS = 15000; 

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

const storageManager = new StorageManager();
const FLUSH_INTERVAL_MS = 10000; 
const FLUSH_THRESHOLD = 50;
let isFlushing = false;

// --- HELPER FUNCTIONS FOR FOCUS LOGIC ---
// We use these because two different events can trigger "Focus Lost"
function handleFocusLost() {
    // Only start the timer if we aren't ALREADY away
    if (!focusAwayStartTime) {
        focusAwayStartTime = Date.now();
        
        // Immediate UI Update
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
// ----------------------------------------

export async function activate(context: vscode.ExtensionContext) {
    console.log('Keystroke Tracker is active!');
    await storageManager.init(context);

    // STATUS BAR SETUP
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // TIMER LOOP
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
            statusBarItem.tooltip = "TBD Extension: Session Recording in Progress";
        }
    }, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(uiTimer) });

    // 1. MAIN LISTENER (EDITS)
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

        const fileView = activeEditor ? path.basename(activeEditor.document.fileName) : 'System/Sidebar';
        const fileEdit = path.basename(event.document.fileName);

        event.contentChanges.forEach((change) => {
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
                fileEdit,
                fileView
            };

            if (isFocusMismatch) {
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

    // 3. WINDOW FOCUS LISTENER (Alt-Tab / OS Switching) --- THIS FIXES YOUR ISSUE
    const windowStateListener = vscode.window.onDidChangeWindowState((windowState) => {
        if (windowState.focused) {
            // User Alt-Tabbed BACK to VS Code
            // We verify if they actually landed on an editor or the sidebar
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

    const timer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

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
    void flushBuffer();
    if (statusBarItem) { statusBarItem.dispose(); }
}