import * as vscode from 'vscode';
import { state, CONSTANTS } from './state';
import { formatDuration } from './utils';

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
