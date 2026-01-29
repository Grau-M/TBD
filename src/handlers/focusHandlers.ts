// Module: handlers/focusHandlers.ts
// Purpose: Handle focus loss and regain events at a per-window level.
// `handleFocusLost` marks the start of an away period and updates the
// shared status bar if present. `handleFocusRegained` calculates the
// time away, clears the away marker, and logs a sessionBuffer event when
// the away period is longer than the configured threshold.
import * as vscode from 'vscode';
import { state } from '../state';
import { formatTimestamp } from '../utils';
import { CONSTANTS } from '../state';

// Function: handleFocusLost
// Purpose: Mark the start of an away period and update the status bar
// to show the "AWAY" timer. This sets `state.focusAwayStartTime` so
// other parts of the extension can compute away duration on regain.
export function handleFocusLost() {
    if (!state.focusAwayStartTime) {
        state.focusAwayStartTime = Date.now();
        if ((global as any).statusBarItem) {
            const sb = (global as any).statusBarItem as vscode.StatusBarItem;
            sb.text = `$(warning) AWAY 00:00:00`;
            sb.color = new vscode.ThemeColor('charts.yellow');
            sb.tooltip = "Focus Lost! Come back to VS Code to stop this timer.";
        }
    }
}

export function handleFocusRegained() {
    if (state.focusAwayStartTime) {
        const currentTime = Date.now();
        const timeAway = currentTime - state.focusAwayStartTime;
        state.focusAwayStartTime = null;
        if (timeAway >= CONSTANTS.FOCUS_THRESHOLD_MS) {
            state.sessionBuffer.push({
                time: formatTimestamp(currentTime),
                flightTime: String(timeAway),
                eventType: 'focusChange',
                fileEdit: '',

// Function: handleFocusRegained
// Purpose: Called when focus returns to the editor. If an away period
// was previously recorded, compute the time away, clear the away marker,
// and log a "Focus Away (Major)" event when the away duration exceeds
// the configured threshold.
                fileView: 'Focus Away (Major)'
            });
        }
    }
}
