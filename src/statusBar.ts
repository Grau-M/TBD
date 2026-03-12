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
// - hiddenCommandId (optional): command id for the secondary, small
//   lock-style status item. This command is expected to open the
//   Teacher Dashboard (the educator/administrator webview). When provided,
//   a lock icon is shown which invokes `hiddenCommandId` when clicked.
let forceSyncButton: vscode.StatusBarItem;
export function createStatusBar(context: vscode.ExtensionContext, hiddenCommandId?: string): vscode.StatusBarItem {
    // Create the Force Sync button with a sync icon, positioned to the left of the primary status item.
    forceSyncButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10002);
    forceSyncButton.command = 'tbd-logger.forceSync';
    forceSyncButton.text = `$(sync) Force Sync`;
    forceSyncButton.tooltip = 'Click to immediately upload local logs to the cloud.';
    forceSyncButton.show();
    context.subscriptions.push(forceSyncButton);

    // Create the primary StatusBarItem; command registration should be handled by the extension entrypoint
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    item.text = 'TBD Logger $(eye)';
    item.tooltip = 'Capstone TBD: Keystroke Logging Active (display only)';
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

    // Authentication indicator: always clickable so users can reopen login/register flow.
    // The string ID 'tbd-logger.authStatus' enables right-click context menus via package.json menus contribution.
    const authItem = vscode.window.createStatusBarItem('tbd-logger.authStatus', vscode.StatusBarAlignment.Left, 9998);
    authItem.text = '$(account) Not Logged In';
    authItem.tooltip = 'Click to Login/Register';
    authItem.command = 'tbd-logger.authSignIn';
    authItem.show();
    context.subscriptions.push(authItem);
    (global as any).authStatusBarItem = authItem;

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

/**
 * Updates the refresh button icon and text during the Sync process.
 * Handles the Sunny Day (Syncing) and Rainy Day (Ready) UI states.
 */
export function updateSyncStatus(isSyncing: boolean) {
    if (!forceSyncButton) return;

    if (isSyncing) {
        forceSyncButton.text = `$(sync~spin) Syncing...`;
        forceSyncButton.tooltip = 'Synchronization is currently in progress.';
    } else {
        forceSyncButton.text = `$(sync) Force Sync`;
        forceSyncButton.tooltip = 'Click to immediately upload local logs to the cloud.';
    }
}