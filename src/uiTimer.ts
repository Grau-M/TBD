// Module: uiTimer.ts
// Purpose: Maintain a UI timer that keeps the tracking status alive.
// The visible tracking item now shows a static green logging label for
// linked student workspaces instead of an away/record counter.
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

        // 👉 Gate 2: Wait for explicit consent before showing the live timer.
        if (!state.isConsentGiven) {
            return;
        }

        // 👉 Gate 3: Protect the Pre-Sync State
        if (!state.isSessionActive) {
            return; // Go back to sleep! Wait until the API verifies the assignment.
        }

        statusBarItem.text = `$(record-keys) Logging Active | ${state.activeAssignment || 'Linked Assignment'}`;
        statusBarItem.tooltip = `Logging data to ${state.activeCourse || 'Linked Assignment'} | ${state.activeAssignment || 'Linked Assignment'}`;
        statusBarItem.color = new vscode.ThemeColor('testing.iconPassed');
    }, 1000);

    return { dispose: () => clearInterval(uiTimer) } as vscode.Disposable;
}