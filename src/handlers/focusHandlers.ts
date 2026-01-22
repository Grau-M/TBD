import * as vscode from 'vscode';
import { state } from '../state';
import { formatTimestamp } from '../utils';
import { CONSTANTS } from '../state';

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
                fileView: 'Focus Away (Major)'
            });
        }
    }
}
