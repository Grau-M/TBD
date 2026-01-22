import * as vscode from 'vscode';

export function createStatusBar(context: vscode.ExtensionContext, commandId = 'tbd-logger.openLogs'): vscode.StatusBarItem {
    // Create the StatusBarItem; command registration should be handled by the extension entrypoint
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    item.text = 'TBD Logger $(eye)';
    item.tooltip = 'Capstone TBD: Keystroke Logging Active';
    item.command = commandId;
    item.show();
    context.subscriptions.push(item);
    // expose globally so small handler modules can update UI without circular imports
    (global as any).statusBarItem = item;
    return item;
}
