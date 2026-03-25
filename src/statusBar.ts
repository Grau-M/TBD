// Module: statusBar.ts
import * as vscode from 'vscode';
import { state, storageManager } from './state'; 

export function createStatusBar(context: vscode.ExtensionContext, hiddenCommandId?: string): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    context.subscriptions.push(item);
    
    (global as any).statusBarItem = item;
    updateTrackingUI();

    const apiStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 950);
    apiStatusItem.text = '$(cloud-upload)';
    apiStatusItem.tooltip = 'Sync: offline | Linked To: None';
    apiStatusItem.command = 'tbd-logger.openStudentSyncView';
    apiStatusItem.show();
    context.subscriptions.push(apiStatusItem);
    (global as any).apiStatusBarItem = apiStatusItem;

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 900);
    statusItem.text = '$(sync)';
    statusItem.tooltip = 'Sync status. Click to open the sync dashboard.';
    statusItem.command = 'tbd-logger.openStudentSyncView';
    statusItem.show();
    context.subscriptions.push(statusItem);
    (global as any).dbStatusBarItem = statusItem;

    const authItem = vscode.window.createStatusBarItem('tbd-logger.authStatus', vscode.StatusBarAlignment.Left, 800);
    authItem.text = '$(account) Not Logged In';
    authItem.tooltip = 'Click to Login/Register';
    authItem.command = 'tbd-logger.authSignIn';
    authItem.show();
    context.subscriptions.push(authItem);
    (global as any).authStatusBarItem = authItem;

    if (hiddenCommandId) {
        const hiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
        hiddenItem.text = '$(layout)';
        hiddenItem.tooltip = 'Show Teacher Dashboard!';
        hiddenItem.command = hiddenCommandId;
        hiddenItem.show();
        context.subscriptions.push(hiddenItem);
        (global as any).hiddenStatusBarItem = hiddenItem;
    }

    return item;
}

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

export function updateApiKeyStatus(_isValidOrPresent: boolean) {
    const apiStatusItem = (global as any).apiStatusBarItem as vscode.StatusBarItem | undefined;
    if (!apiStatusItem) { return; }

    apiStatusItem.text = '$(cloud-upload)';
    const isOnline = state.isApiOnline === true;
    const isOffline = state.isApiOnline === false;
    const isTeacherContext = state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin';
    const isRoutingActive = isTeacherContext && !state.isPersonalWorkspace;
    const hasWorkspaceLink = Boolean(state.activeCourse || state.activeAssignment || state.isSessionActive);

    if (isTeacherContext) {
        apiStatusItem.color = isOnline
            ? new vscode.ThemeColor('charts.green')
            : new vscode.ThemeColor('charts.orange');
        apiStatusItem.tooltip = `API: ${isOnline ? 'Online' : isOffline ? 'Offline' : 'Unknown'} | Routing: ${isRoutingActive ? 'Active' : 'Inactive'}`;
    } else if (isOnline) {
        apiStatusItem.color = hasWorkspaceLink
            ? new vscode.ThemeColor('charts.green')
            : new vscode.ThemeColor('charts.purple');
        apiStatusItem.tooltip = `Sync: ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'} | Linked to: ${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;
    } else if (isOffline && hasWorkspaceLink) {
        apiStatusItem.color = undefined;
        apiStatusItem.tooltip = `Sync: ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'} | Linked to: ${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;
    } else if (isOffline) {
        apiStatusItem.color = new vscode.ThemeColor('charts.orange');
        apiStatusItem.tooltip = `Sync: ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'} | Linked to: ${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;
    } else {
        apiStatusItem.color = undefined;
        apiStatusItem.tooltip = `Sync: ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'} | Linked to: ${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;
    }
    apiStatusItem.command = 'tbd-logger.openStudentSyncView';
    apiStatusItem.show();
}

export function updateTrackingUI(role?: string) {
    const trackingItem = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    const dbItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!trackingItem) { return; }

    const currentRole = role || state.currentUserRole;

    if (currentRole === 'None' || !currentRole) {
        trackingItem.hide();
        dbItem?.hide();
        return; 
    }

    if (currentRole === 'Teacher' || currentRole === 'Admin') {
        trackingItem.text = "$(mortar-board) TBD: Teacher Mode";
        trackingItem.tooltip = `Logs are not recorded for ${currentRole} accounts.`;
        trackingItem.backgroundColor = undefined;
        trackingItem.color = new vscode.ThemeColor('descriptionForeground');
        trackingItem.show();
        return; 
    }

    // 3. Student Logic 
    trackingItem.backgroundColor = undefined; 
    trackingItem.color = undefined;

    if (dbItem) {
        dbItem.hide();
    }
    
    // 👉 NEW: If they haven't finished selecting an assignment, hold the UI
    if (!state.isSessionActive && !state.activeAssignment) {
        trackingItem.text = "$(gear) TBD: Setup Pending";
        trackingItem.tooltip = "Please finish linking your workspace.";
        trackingItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        trackingItem.show();
        return; 
    }

    trackingItem.text = `$(record-keys) Logging Data`;
    trackingItem.tooltip = 'Logging data for the current student workspace.';
    trackingItem.color = new vscode.ThemeColor('testing.iconPassed');
    trackingItem.backgroundColor = undefined;
    trackingItem.show();
}