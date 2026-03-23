// Module: uiTimer.ts
// Purpose: Maintain a UI timer that updates the status bar every second.
// Shows either an "AWAY" timer when focus is lost or a session recording
// duration while the extension is active. Returns a Disposable to stop
// the timer when the extension is deactivated.
import * as vscode from 'vscode';
import { state } from './state';
import { formatDuration } from './utils';

// Function: startUiTimer
export function startUiTimer(statusBarItem: vscode.StatusBarItem): vscode.Disposable {
    const uiTimer = setInterval(() => {
        // 👉 Gate 1: Protect the Teacher and Logged-Out UI
        if (state.currentUserRole !== 'Student') {
            return; // Go back to sleep! Let updateTrackingUI() handle the display.
        }

        // 👉 Gate 2: Protect the Pre-Sync State
        if (!state.isSessionActive) {
            return; // Go back to sleep! Wait until the API verifies the assignment.
        }

        const now = Date.now();

        if (state.focusAwayStartTime) {
            const awayDuration = now - state.focusAwayStartTime;
            statusBarItem.text = `$(warning) AWAY ${formatDuration(awayDuration)}`;
            statusBarItem.color = new vscode.ThemeColor('charts.yellow');
        } else {
            const sessionDuration = now - state.sessionStartTime;
            statusBarItem.text = `$(circle-filled) REC ${formatDuration(sessionDuration)}`;
            statusBarItem.color = new vscode.ThemeColor('errorForeground');
            statusBarItem.tooltip = "TBD Extension: Session Recording in Progress.";
        }
    }, 1000);

    return { dispose: () => clearInterval(uiTimer) } as vscode.Disposable;
}