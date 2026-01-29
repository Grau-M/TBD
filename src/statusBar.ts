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
export function createStatusBar(context: vscode.ExtensionContext, commandId = 'tbd-logger.openLogs', hiddenCommandId?: string): vscode.StatusBarItem {
    // Create the primary StatusBarItem; command registration should be handled by the extension entrypoint
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    item.text = 'TBD Logger $(eye)';
    item.tooltip = 'Capstone TBD: Keystroke Logging Active';
    item.command = commandId;
    item.show();
    context.subscriptions.push(item);

    // Optional small secondary item to open hidden deletions (click instead of long-press)
    if (hiddenCommandId) {
        const hiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
        hiddenItem.text = '$(lock)';
        hiddenItem.tooltip = 'Show hidden deletion records (click)';
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
