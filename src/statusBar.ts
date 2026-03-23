// Module: statusBar.ts
// Purpose: Create and configure the extension's UI status bar items.
import * as vscode from 'vscode';
import { state, storageManager } from './state'; 

let forceSyncButton: vscode.StatusBarItem;

export function createStatusBar(context: vscode.ExtensionContext, hiddenCommandId?: string): vscode.StatusBarItem {
    // 1. Create the primary StatusBarItem
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    context.subscriptions.push(item);
    
    // Expose primary globally so small handler modules can update UI without circular imports
    (global as any).statusBarItem = item;

    // 2. IMMEDIATELY force the UI to match the current state (No hardcoded strings!)
    updateTrackingUI();

    // Create connection status indicator (database online/offline)
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
    statusItem.text = '$(database) Offline';
    statusItem.tooltip = 'Database connection status. Click to refresh';
    statusItem.command = 'tbd-logger.openStudentSyncView';
    statusItem.show();
    context.subscriptions.push(statusItem);
    (global as any).dbStatusBarItem = statusItem;

    // Authentication indicator: always clickable so users can reopen login/register flow.
    const authItem = vscode.window.createStatusBarItem('tbd-logger.authStatus', vscode.StatusBarAlignment.Left, 9998);
    authItem.text = '$(account) Not Logged In';
    authItem.tooltip = 'Click to Login/Register';
    authItem.command = 'tbd-logger.authSignIn';
    authItem.show();
    context.subscriptions.push(authItem);
    (global as any).authStatusBarItem = authItem;

    // Optional small secondary item to open the Teacher Dashboard
    if (hiddenCommandId) {
        const hiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
        hiddenItem.text = '$(lock)';
        hiddenItem.tooltip = 'Show Teacher Dashboard!';
        hiddenItem.command = hiddenCommandId;
        hiddenItem.show();
        context.subscriptions.push(hiddenItem);
        (global as any).hiddenStatusBarItem = hiddenItem;
    }

    return item;
}

/**
 * Updates the refresh button icon and text during the Sync process.
 */
export function updateSyncStatus(isSyncing: boolean) {
    const dbItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!dbItem) {return;}

    if (isSyncing) {
        dbItem.text = `$(sync~spin) Syncing Data...`;
        dbItem.tooltip = 'Uploading session logs to the cloud database.';
    } else {
        const isOnline = storageManager.isOnline(); 
        dbItem.text = isOnline ? '$(database) Online' : '$(database) Offline';
        dbItem.tooltip = isOnline ? 'Database connection is active' : 'Database offline';
    }
}

export function updateApiKeyStatus(isValidOrPresent: boolean) {
    return;
}

/**
 * 👉 THE STUDENT-ONLY GATE UI LOGIC
 * Updates the primary tracking icon based on role and away status.
 */
export function updateTrackingUI() {
    const trackingItem = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    if (!trackingItem) { return; }

    const role = state.currentUserRole;

    // 1. Not Logged In
    if (role === 'None') {
        trackingItem.text = "$(person) TBD: Not Logged In";
        trackingItem.tooltip = "Please log in to use TBD Logger.";
        trackingItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); 
        trackingItem.show();
        return; // Exit early!
    }

    // 2. Teacher or Admin Mode
    if (role === 'Teacher' || role === 'Admin') {
        trackingItem.text = "$(mortar-board) TBD: Teacher Mode";
        trackingItem.tooltip = `Logs are not recorded for ${role} accounts.`;
        trackingItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); 
        trackingItem.show();
        return; // Exit early!
    }

    // 3. Student Logic 
    trackingItem.backgroundColor = undefined; 
    
    if (state.focusAwayStartTime !== null) {
        trackingItem.text = "$(watch) TBD: Away";
        trackingItem.tooltip = "You are currently marked as away.";
    } else {
        trackingItem.text = "$(record-keys) TBD: Recording";
        trackingItem.tooltip = "Capstone TBD: Keystroke Logging Active";
    }
    trackingItem.show();
}