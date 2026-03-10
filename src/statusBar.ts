// Module: statusBar.ts
// Purpose: Create and configure the extension's UI status bar items.
// Exposes `createStatusBar` which registers a primary status item and an
// optional secondary (locked) item, registers them for disposal, and
// exposes the primary item via the global object for other modules.
import * as vscode from 'vscode';

// Function: createStatusBar
// Purpose: Construct and register a primary status bar item (and an
// optional secondary locked item). The returned primary item is shown
// immediately and pushed onto `context.subscriptions` for disposal.
//
// Parameters:
// - context: VS Code extension context used to register disposables.
// - commandId: command to invoke when the primary status item is clicked.
// - hiddenCommandId (optional): command id for the secondary, small
//   lock-style status item. This command is expected to open the
//   Teacher Dashboard (the educator/administrator webview). When provided,
//   a lock icon is shown which invokes `hiddenCommandId` when clicked.
export function createStatusBar(context: vscode.ExtensionContext, commandId = 'tbd-logger.openLogs', hiddenCommandId?: string): vscode.StatusBarItem {
    // Create the primary StatusBarItem; command registration should be handled by the extension entrypoint
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    item.text = 'TBD Logger $(eye)';
    item.tooltip = 'Capstone TBD: Keystroke Logging Active';
    item.command = commandId;
    item.show();
    context.subscriptions.push(item);

    // Create connection status indicator (database online/offline)
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
    statusItem.text = '$(database) Offline';
    statusItem.tooltip = 'Database connection status. Click to refresh';
    statusItem.command = 'tbd-logger.checkDbStatus';
    statusItem.show();
    context.subscriptions.push(statusItem);
    (global as any).dbStatusBarItem = statusItem;

    // Optional small secondary item to open the Teacher Dashboard (click the lock to open teacher dashboard)
    // The `hiddenCommandId` should point to the command that opens the Teacher view/webview.
    if (hiddenCommandId) {
        const hiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
        hiddenItem.text = '$(lock)';
        hiddenItem.tooltip = 'Show Teacher Dashboard!';
        hiddenItem.command = hiddenCommandId;
        hiddenItem.show();
        context.subscriptions.push(hiddenItem);
        // expose both via global for other modules to update icon/text if needed
        (global as any).hiddenStatusBarItem = hiddenItem;
    }

    // expose primary globally so small handler modules can update UI without circular imports
    (global as any).statusBarItem = item;
    return item;
}
