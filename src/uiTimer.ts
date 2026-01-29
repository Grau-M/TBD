// Module: uiTimer.ts
// Purpose: Maintain a UI timer that updates the status bar every second.
// Shows either an "AWAY" timer when focus is lost or a session recording
// duration while the extension is active. Returns a Disposable to stop
// the timer when the extension is deactivated.
import * as vscode from 'vscode';
import { state, CONSTANTS } from './state';
import { formatDuration } from './utils';

// Function: startUiTimer
// Purpose: Start a timer that updates the provided status bar item every
// second to show either an AWAY duration (if focusAwayStartTime is set)
// or the current session recording duration. Returns a Disposable to
// cancel the timer.
export function startUiTimer(statusBarItem: vscode.StatusBarItem): vscode.Disposable {
    const uiTimer = setInterval(() => {
        const now = Date.now();

        if (state.focusAwayStartTime) {
            const awayDuration = now - state.focusAwayStartTime;
            statusBarItem.text = `$(warning) AWAY ${formatDuration(awayDuration)}`;
            statusBarItem.color = new vscode.ThemeColor('charts.yellow');
        } else {
            const sessionDuration = now - state.sessionStartTime;
            statusBarItem.text = `$(circle-filled) REC ${formatDuration(sessionDuration)}`;
            statusBarItem.color = new vscode.ThemeColor('errorForeground');
            statusBarItem.tooltip = "TBD Extension: Session Recording in Progress (Click for info)";
        }
    }, 1000);

    return { dispose: () => clearInterval(uiTimer) } as vscode.Disposable;
}
