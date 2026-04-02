// Module: extension.ts
// Purpose: Extension activation and deactivation entrypoints.
// This file initializes the extension: it sets up the storage manager,
// session interruption tracker, status bar UI, listeners, commands,
// and periodic background flush. It also exposes a minimal API for
// tests and marks clean shutdown on deactivate.
import * as vscode from 'vscode';
import { getSessionInfo, printSessionInfo } from './sessionInfo';
import { createStatusBar } from './statusBar';
import { createEditListener } from './listeners/editListener';
import { createFocusListener } from './listeners/focusListener';
import { createWindowStateListener } from './listeners/windowStateListener';
import { createSaveListener } from './listeners/saveListener';
import { startUiTimer } from './uiTimer';
import { flushBuffer } from './flush';
import { storageManager, state, CONSTANTS } from './state';
import { isIgnoredPath, formatTimestamp, getUserFriendlyErrorMessage } from './utils';
import { SessionInterruptionTracker } from './sessionInterruptions';
import { openTeacherView } from './teacher';
import { clearWorkspaceAuthSession, getWorkspaceAuthSession, manageClassActivities, requireRoleAccess, WorkspaceAuthSession } from './auth';
import { openAuthView, openAccountView, openLogoutConfirmView } from './auth/index';
import { updateApiKeyStatus, updateSyncStatus } from './statusBar';
import { ApiHttpError, apiGet, apiPost } from './api';
import { updateTrackingUI } from './statusBar';
import * as path from 'path';
import { openStudentSyncView } from './auth/studentSyncView';
import { installNotificationToastTimeouts } from './notificationToasts';
import { closeAllWebviews } from './webviewRegistry';

// ========================= W A R N I N G   S U P P R E S S I O N   C O D E =========================
// Development-time workaround: suppress Node/Electron warnings leaking into extension host logs.
// Remove this section in production once the IDE dependency warnings are resolved upstream.
const originalEmitWarning = process.emitWarning.bind(process);
let runtimeWarningFilterInstalled = false;

function installRuntimeWarningFilter(): void {
    if (runtimeWarningFilterInstalled) {
        return;
    }

    runtimeWarningFilterInstalled = true;
    process.emitWarning = ((warning: any, ...args: any[]) => {
        const message = typeof warning === 'string'
            ? warning
            : String(warning?.message || warning || '');

        if (
            message.includes('The `punycode` module is deprecated') ||
            message.includes('SQLite is an experimental feature') ||
            message.includes('DEP0040') ||
            message.includes('ExperimentalWarning') ||
            message.includes('IAgentSessionsWorkspace')
        ) {
            return;
        }

        return originalEmitWarning(warning as any, ...args as any);
    }) as typeof process.emitWarning;
}

installRuntimeWarningFilter();
// ===============================================================================================

const SESSION_ID_KEY = 'sessionId';
const getSessionCounterKey = (userId: number, projectId: number) => `tbd.sessionNumber.counter.v1.${userId}.${projectId}`; // Scope the session counter so each user/project combo starts at 1
const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function getWorkspaceTypeHtml(webview: vscode.Webview, nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Workspace Type</title>
<style>
    body { margin: 0; font-family: var(--vscode-font-family, Segoe UI, Arial, sans-serif); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    .card { max-width: 480px; margin: 30px auto; padding: 24px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.3); }
    h1 { font-size: 1.4rem; margin: 0 0 12px; }
    p { margin: 0 0 20px; color: var(--vscode-descriptionForeground); }
    .buttons { display: flex; gap: 12px; }
    button { flex: 1; padding: 10px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { filter: brightness(1.05); }
    .personal { background: var(--vscode-inputValidation-infoBackground); }
    .school { background: var(--vscode-inputValidation-warningBackground); }
</style>
</head>
<body>
<div class="card">
  <h1>TBD Logger: Workspace Type</h1>
  <p>Is this a Personal Project or a School Assignment?</p>
  <div class="buttons">
    <button id="personal" class="personal">Personal Project</button>
    <button id="school" class="school">School Project</button>
  </div>
</div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  document.getElementById('personal').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'workspaceType', value: 'Personal Project' });
  });
  document.getElementById('school').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'workspaceType', value: 'School Project' });
  });
</script>
</body>
</html>`;
}

function isTrackingConsentGranted(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function updateStudentLoggingStatus(statusBarItem: vscode.StatusBarItem | undefined): void {
    if (!statusBarItem) {
        return;
    }

    if (state.currentUserRole !== 'Student' || state.isPersonalWorkspace || !state.isConsentGiven) {
        return;
    }

    const isOffline = state.isApiOnline === false;
    statusBarItem.text = isOffline ? '$(record-keys) Logging Offline Data' : '$(record-keys) Logging Data';
    statusBarItem.tooltip = isOffline
        ? 'Logging data locally while the API is offline.'
        : 'Logging data for the current student workspace.';
    statusBarItem.color = isOffline
        ? new vscode.ThemeColor('descriptionForeground')
        : new vscode.ThemeColor('testing.iconPassed');
    statusBarItem.backgroundColor = undefined;
    statusBarItem.command = undefined;
}

// Function to update database status bar item
async function updateDbStatusBar(context: vscode.ExtensionContext): Promise<void> {
    const statusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!statusItem) { return; }

    const session = getWorkspaceAuthSession(context);
    if (!session?.authenticated) {
        statusItem.hide();
        return;
    }

    if (session.role === 'Teacher' || session.role === 'Admin') {
        try {
            await apiGet('/health');
            state.isApiOnline = true;
        } catch {
            state.isApiOnline = false;
        }
        updateApiKeyStatus(false);
        statusItem.hide();
        return;
    }

    if (session.role === 'Student') {
        const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
        try {
            await apiGet('/health');
            state.isApiOnline = true;
        } catch {
            state.isApiOnline = false;
        }
        updateApiKeyStatus(true);
        updateStudentLoggingStatus(globalSb);
        statusItem.hide();
        return;
    }
    
    if (state.isPersonalWorkspace) {
        statusItem.hide();
        return;
    }

    statusItem.show();
    statusItem.command = 'tbd-logger.openStudentSyncView';

    const setTeacherApiIndicator = (isOnline: boolean, tooltip: string) => {
        statusItem.text = '$(cloud-upload)';
        statusItem.color = new vscode.ThemeColor(isOnline ? 'charts.green' : 'charts.orange');
        statusItem.tooltip = tooltip;
    };

    try {
        const health = await apiGet('/health');
        state.isApiOnline = true;
        updateApiKeyStatus(true);
        const apiStatus = String(health?.status ?? 'ok');
        const syncState = apiStatus.toLowerCase() === 'ok' ? 'online' : 'offline';
        const linkedTo = `${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;

        try {
            await apiGet('/api/sessions');
            statusItem.text = '$(refresh)';
            statusItem.color = undefined;
            statusItem.tooltip = `Sync: ${syncState} | Linked to: ${linkedTo}`;
            return;
        } catch (authErr) {
            if (authErr instanceof ApiHttpError && (authErr.status === 401 || authErr.status === 403)) {
                statusItem.text = '$(refresh)';
                statusItem.color = undefined;
                statusItem.tooltip = `Sync: offline | Linked to: ${linkedTo}`;
                return;
            }
            throw authErr;
        }
    } catch (err) {
        state.isApiOnline = false;
        updateApiKeyStatus(false);
        statusItem.text = '$(refresh)';
        statusItem.color = undefined;
        statusItem.tooltip = `Sync: offline | Linked to: ${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;
    }
}

async function syncConsentFromDatabase(
    context: vscode.ExtensionContext,
    session: WorkspaceAuthSession | undefined,
    storageManager: typeof import('./state').storageManager
): Promise<WorkspaceAuthSession | undefined> {
    if (!session?.authenticated) {
        state.isConsentGiven = false;
        return session;
    }

    if (session.role !== 'Student') {
        state.isConsentGiven = true;
        return session;
    }

    try {
        const dbUser = await storageManager.findAuthUserByEmail(session.email);
        const trackingConsent = isTrackingConsentGranted(dbUser?.trackingConsent);

        session.trackingConsent = trackingConsent;
        state.isConsentGiven = trackingConsent;
        await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
        return session;
    } catch (error) {
        console.warn('[TBD Logger] Unable to refresh consent from database. Falling back to session state.', error);
        state.isConsentGiven = isTrackingConsentGranted(session.trackingConsent);
        return session;
    }
}

function formatAssignmentDebugLines(items: Array<{ className: string; assignmentName: string; workspaceRootPath?: string }>): string {
    if (items.length === 0) {
        return 'None';
    }

    return items.map((item) => {
        const workspacePath = item.workspaceRootPath && item.workspaceRootPath.trim().length > 0
            ? item.workspaceRootPath
            : 'No workspace linked';
        return `- ${item.assignmentName} | ${item.className} | ${workspacePath}`;
    }).join('\n');
}

function logStartupIdentity(context: vscode.ExtensionContext): void {
    const session = getWorkspaceAuthSession(context);
    const sessionInfo = getSessionInfo();
    const displayName = session?.displayName || sessionInfo.user;
    const hasLinkedWorkspace = Boolean(
        state.activeCourse ||
        state.activeAssignment ||
        (Number(session?.workspaceLinkedClassId ?? 0) > 0 && Number(session?.workspaceLinkedAssignmentId ?? 0) > 0)
    );
    const assignmentSummary = hasLinkedWorkspace
        ? `[${state.activeCourse || 'Unknown Class'} | ${state.activeAssignment || 'Unknown Assignment'}]`
        : 'Not yet connected to a workspace.';

    console.log(`[TBD LOGGER] Display name: ${displayName} | ${assignmentSummary}`);
}

async function showStartupWorkspaceDebugPopup(
    session: WorkspaceAuthSession | undefined,
    workspaceRoot: string,
    assignmentInfo: { classId: number; courseName?: string; assignmentId: number; assignmentName: string; studentWorkspaceAssignmentId?: number } | null,
    debugAssignments: Array<{ className: string; assignmentName: string; workspaceRootPath?: string }>
): Promise<void> {
    if (process.env.CI === 'true') {
        return;
    }

    const workspaceName = vscode.workspace.name || 'Unknown Workspace';
    const linkedWorkspaceAssignments = debugAssignments.filter((item) => {
        return !!item.workspaceRootPath && item.workspaceRootPath.trim().length > 0;
    });

    const matchedAssignment = debugAssignments.find((item) => {
        if (!workspaceRoot || !item.workspaceRootPath) {
            return false;
        }

        try {
            return vscode.Uri.file(item.workspaceRootPath).fsPath === vscode.Uri.file(workspaceRoot).fsPath;
        } catch {
            return false;
        }
    });

    const resolvedCourse = assignmentInfo?.courseName || state.activeCourse || 'None';
    const resolvedAssignment = assignmentInfo?.assignmentName || state.activeAssignment || 'None';
    const currentWorkspacePath = workspaceRoot || 'No workspace folder open';
    const sessionRole = session?.role || 'Not signed in';
    const consentState = session?.authenticated ? (isTrackingConsentGranted(session.trackingConsent) ? 'Granted' : 'Missing') : 'Not signed in';
    const linkedClassId = session?.workspaceLinkedClassId ?? 'None';
    const linkedAssignmentId = session?.workspaceLinkedAssignmentId ?? 'None';
    const studentWorkspaceAssignmentId = session?.studentWorkspaceAssignmentId ?? 'None';

    const message = [
        `Workspace: ${workspaceName}`,
        `Current workspace local path: ${currentWorkspacePath}`,
        `Role: ${sessionRole}`,
        `Consent: ${consentState}`,
        `Personal workspace: ${state.isPersonalWorkspace ? 'Yes' : 'No'}`,
        `Session active: ${state.isSessionActive ? 'Yes' : 'No'}`,
        `Linked class ID: ${linkedClassId}`,
        `Linked assignment ID: ${linkedAssignmentId}`,
        `Student Workspace Assignment ID: ${studentWorkspaceAssignmentId}`,
        `Resolved course: ${resolvedCourse}`,
        `Resolved assignment: ${resolvedAssignment}`,
        '',
        'All assignments the user is linked to:',
        formatAssignmentDebugLines(debugAssignments),
        '',
        'Assignments with a workspace connected:',
        formatAssignmentDebugLines(linkedWorkspaceAssignments),
        '',
        matchedAssignment
            ? `This students current workspace is already linked to assignment: ${matchedAssignment.assignmentName} | ${matchedAssignment.className}`
            : 'This students current workspace is not matched to any linked assignment.'
    ].join('\n');

    // In debug mode, show this message for inspection. Keep non-verbose during CI and normal workflows.
    if (process.env.CI !== 'true' && process.env.TBD_SHOW_WORKSPACE_DEBUG === 'true') {
        void vscode.window.showInformationMessage(message, { modal: false });
    }

    if (matchedAssignment) {
        state.activeCourse = state.activeCourse || matchedAssignment.className;
        state.activeAssignment = state.activeAssignment || matchedAssignment.assignmentName;
        state.isSessionActive = true;
    }
}

async function hydrateLinkedStudentWorkspace(
    session: WorkspaceAuthSession,
    workspaceRoot: string
): Promise<{ classId: number; courseName: string; assignmentId: number; assignmentName: string; studentWorkspaceAssignmentId?: number } | null> {
    if (!session?.authenticated || session.role !== 'Student') {
        return null;
    }

    const linkedClassId = Number(session.workspaceLinkedClassId ?? 0);
    const linkedAssignmentId = Number(session.workspaceLinkedAssignmentId ?? 0);
    if (!linkedClassId || !linkedAssignmentId) {
        return null;
    }

    try {
        const classes = await (storageManager as any).listStudentClasses(session.authUserId);
        const linkedClass = (classes || []).find((currentClass: any) => Number(currentClass.id) === linkedClassId);
        const className = String(linkedClass?.courseName || linkedClass?.courseCode || linkedClass?.name || `Class ID: ${linkedClassId}`);
        const assignments = await (storageManager as any).listStudentAssignmentsForClass(session.authUserId, linkedClassId);
        const linkedAssignment = (assignments || []).find((assignment: any) => Number(assignment.assignmentId) === linkedAssignmentId);

        if (!linkedAssignment) {
            return {
                classId: linkedClassId,
                courseName: className,
                assignmentId: linkedAssignmentId,
                assignmentName: `Assignment ID: ${linkedAssignmentId}`
            };
        }

        const assignmentWorkspaceRoot = String(linkedAssignment.workspaceRootPath || '').trim();
        if (workspaceRoot && assignmentWorkspaceRoot && vscode.Uri.file(assignmentWorkspaceRoot).fsPath !== vscode.Uri.file(workspaceRoot).fsPath) {
            return {
                classId: linkedClassId,
                courseName: className,
                assignmentId: linkedAssignmentId,
                assignmentName: String(linkedAssignment.assignmentName || linkedAssignment.name || `Assignment ID: ${linkedAssignmentId}`)
            };
        }

        // Recover the workspace ID or regenerate it deterministically to satisfy the database constraint
        let swaId = Number(linkedAssignment.workspaceId || linkedAssignment.id || 0);
        if (!swaId || swaId <= 0) {
            const wName = vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || '';
            const source = `${linkedAssignmentId}|${workspaceRoot}|${wName}`;
            let hash = 2166136261;
            for (let i = 0; i < source.length; i++) {
                hash ^= source.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            swaId = (hash >>> 0) > 0 ? (hash >>> 0) : 1;
        }

        return {
            classId: linkedClassId,
            courseName: className,
            assignmentId: linkedAssignmentId,
            assignmentName: String(linkedAssignment.assignmentName || linkedAssignment.name || `Assignment ID: ${linkedAssignmentId}`),
            studentWorkspaceAssignmentId: swaId
        };
    } catch (error) {
        console.warn('[TBD Logger] Unable to hydrate linked workspace state from database.', error);
        return null;
    }
}

async function syncTeacherDashboardLock(context: vscode.ExtensionContext): Promise<void> {
    const session = getWorkspaceAuthSession(context);
    const shouldShowLock = !!(session?.authenticated && (session.role === 'Teacher' || session.role === 'Admin'));
    const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;

    await vscode.commands.executeCommand('setContext', 'tbd.hasTeacherDashboardAccess', shouldShowLock);

    if (shouldShowLock) {
        if (!hiddenItem) {
            const newHiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
            newHiddenItem.text = '$(layout)';
            newHiddenItem.tooltip = 'Open Teacher Dashboard';
            newHiddenItem.command = 'tbd-logger.openTeacherView';
            context.subscriptions.push(newHiddenItem);
            (global as any).hiddenStatusBarItem = newHiddenItem;
        } else {
            hiddenItem.text = '$(layout)';
            hiddenItem.tooltip = 'Open Teacher Dashboard';
            hiddenItem.command = 'tbd-logger.openTeacherView';
        }
        (global as any).hiddenStatusBarItem?.show();
        return;
    }

    if (hiddenItem) {
        hiddenItem.dispose();
        delete (global as any).hiddenStatusBarItem;
    }
}

async function updateAuthStatusBar(context: vscode.ExtensionContext): Promise<void> {
    const authItem = (global as any).authStatusBarItem as vscode.StatusBarItem | undefined;
    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    const dbItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    const session = getWorkspaceAuthSession(context);
    const hasConsent = isTrackingConsentGranted(session?.trackingConsent ?? state.isConsentGiven);
    
    state.currentUserRole = session?.role || 'None';
    state.isConsentGiven = hasConsent;
    
    if (!authItem || !globalSb) {
        return;
    }

    if (!session?.authenticated) {
        authItem.text = '$(sign-in) Login';
        authItem.tooltip = 'Click to log in to TBD Logger.';
        authItem.backgroundColor = undefined;
        authItem.color = undefined;
        authItem.command = 'tbd-logger.authSignIn';
        authItem.show();

        globalSb.hide();
        dbItem?.hide();
        const apiStatusItem = (global as any).apiStatusBarItem as vscode.StatusBarItem | undefined;
        apiStatusItem?.hide();
        const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;
        hiddenItem?.hide();
        await syncTeacherDashboardLock(context);
        return;
    }

    authItem.show();
    globalSb.show();
    dbItem?.show();
    
    if (session.role !== 'Student') {
        authItem.text = `$(account) ${session.role}`;
        authItem.tooltip = 'View Account Information';
        authItem.backgroundColor = undefined;
        authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
        
        globalSb.hide();
        dbItem?.hide();
        await updateDbStatusBar(context);
        await syncTeacherDashboardLock(context);
        return;
    }

    if (!hasConsent) {
        authItem.text = '$(account) Student';
        authItem.tooltip = 'Open Student Profile';
        authItem.backgroundColor = undefined;
        authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
        authItem.command = 'tbd-logger.authSignIn';
        
        const apiStatusItem = (global as any).apiStatusBarItem as vscode.StatusBarItem | undefined;
        apiStatusItem?.show();
        dbItem?.show();
        if (dbItem) {
            dbItem.command = 'tbd-logger.openStudentSyncView';
            dbItem.text = '$(sync)';
            dbItem.tooltip = `Sync: online | Linked to: ${state.activeAssignment || 'None'}`;
        }

        globalSb.text = `$(warning) Consent Required`;
        globalSb.tooltip = 'Click here to allow consent to start tracking my assignments!';
        globalSb.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        globalSb.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        globalSb.command = undefined;
        await updateDbStatusBar(context);
        updateTrackingUI(session?.role);
        await syncTeacherDashboardLock(context);
        return;
    }
    
    authItem.text = '$(account) Student';
    authItem.tooltip = 'Open Student Profile';
    authItem.backgroundColor = undefined;
    authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
    authItem.command = 'tbd-logger.authSignIn';

    const apiStatusItem = (global as any).apiStatusBarItem as vscode.StatusBarItem | undefined;
    apiStatusItem?.show();
    dbItem?.hide();
    
    await updateDbStatusBar(context);
    updateTrackingUI(session?.role);
    await syncTeacherDashboardLock(context);
    return;
}

let hasPromptedUnrecognizedWorkspace = false;
async function reconcileStudentWorkspaceState(
    context: vscode.ExtensionContext,
    session: WorkspaceAuthSession,
    workspaceRoot: string,
    silentCheck = false
): Promise<WorkspaceAuthSession> {
    if (session.role !== 'Student' || !workspaceRoot) {
        return session;
    }

    const schoolFlagKey = `tbd.schoolWorkspace.${workspaceRoot}`;
    const hasSchoolWorkspace = context.workspaceState.get<boolean>(schoolFlagKey) === true;

    // Keep personal selection session-only; school is persisted across restarts.
    if (hasSchoolWorkspace) {
        state.isPersonalWorkspace = false;

        if (!session?.authenticated) {
            const signedSession = await openAuthView(context, storageManager);
            if (!signedSession?.authenticated) {
                vscode.window.showWarningMessage('Please sign in to continue using School Project workspace.');
                return session;
            }
            session = signedSession;
        }

        state.currentUserRole = session.role || 'None';
        state.isConsentGiven = isTrackingConsentGranted(session.trackingConsent ?? state.isConsentGiven);
        await updateAuthStatusBar(context);
        updateTrackingUI(session.role);

        // don't automatically open sync view on login in subsequent sessions
        return session;
    }

    let assignmentInfo: { classId: number; courseName?: string; assignmentId: number; assignmentName: string; studentWorkspaceAssignmentId?: number } | null = null;

    try {
        const classes = await (storageManager as any).listStudentClasses(session.authUserId);
        if (classes && classes.length > 0) {
            for (const c of classes) {
                const assignments = await (storageManager as any).listStudentAssignmentsForClass(session.authUserId, c.id);
                if (assignments) {
                    const linked = assignments.find((a: any) =>
                        a.workspaceRootPath &&
                        vscode.Uri.file(a.workspaceRootPath).fsPath === vscode.Uri.file(workspaceRoot).fsPath
                    );

                    if (linked) {
                        // Recover the workspace ID or regenerate it deterministically to satisfy the database constraint
                        let swaId = Number(linked.workspaceId || linked.id || 0);
                        if (!swaId || swaId <= 0) {
                            const wName = vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || '';
                            const source = `${linked.assignmentId}|${workspaceRoot}|${wName}`;
                            let hash = 2166136261;
                            for (let i = 0; i < source.length; i++) {
                                hash ^= source.charCodeAt(i);
                                hash = Math.imul(hash, 16777619);
                            }
                            swaId = (hash >>> 0) > 0 ? (hash >>> 0) : 1;
                        }

                        assignmentInfo = {
                            classId: c.id,
                            courseName: c.courseName || c.courseCode,
                            assignmentId: linked.assignmentId,
                            assignmentName: linked.assignmentName || linked.name,
                            studentWorkspaceAssignmentId: swaId
                        };
                        break;
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[TBD Logger] DB workspace validation failed. Checking local storage fallback.', err);
        assignmentInfo = await (storageManager as any).validateAssignmentLink(session.authUserId, workspaceRoot);
    }

    if (assignmentInfo) {
        state.isPersonalWorkspace = false;
        state.activeCourse = assignmentInfo.courseName || `Class ID: ${assignmentInfo.classId}`;
        state.activeAssignment = assignmentInfo.assignmentName || `Assignment ID: ${assignmentInfo.assignmentId}`;
        state.isSessionActive = true;
        state.focusAwayStartTime = null;

        session.workspaceLinkedClassId = assignmentInfo.classId;
        session.workspaceLinkedAssignmentId = assignmentInfo.assignmentId;
        session.studentWorkspaceAssignmentId = assignmentInfo.studentWorkspaceAssignmentId; 
        await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
        await (storageManager as any).syncStudentWorkspaceLinkRecord({
            studentId: session.authUserId,
            studentWorkspaceFullPath: workspaceRoot,
            studentWorkspaceName: vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || undefined,
            classId: assignmentInfo.classId,
            classAssignmentId: assignmentInfo.assignmentId,
            showNotification: false
        });
        return session;
    }

    const hydrated = await hydrateLinkedStudentWorkspace(session, workspaceRoot);
    if (hydrated) {
        state.isPersonalWorkspace = false;
        state.activeCourse = hydrated.courseName;
        state.activeAssignment = hydrated.assignmentName;
        state.isSessionActive = true;
        state.focusAwayStartTime = null;

        session.workspaceLinkedClassId = hydrated.classId;
        session.workspaceLinkedAssignmentId = hydrated.assignmentId;
        session.studentWorkspaceAssignmentId = hydrated.studentWorkspaceAssignmentId; 
        await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
        await (storageManager as any).syncStudentWorkspaceLinkRecord({
            studentId: session.authUserId,
            studentWorkspaceFullPath: workspaceRoot,
            studentWorkspaceName: vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || undefined,
            classId: hydrated.classId,
            classAssignmentId: hydrated.assignmentId,
            showNotification: false
        });
        return session;
    }

    if (silentCheck || hasPromptedUnrecognizedWorkspace) {
        return session;
    }

    // Ensure login first for unrecognized workspace flow
    let currentSession = getWorkspaceAuthSession(context);
    if (!currentSession?.authenticated) {
        const signedSession = await openAuthView(context, storageManager);
        if (!signedSession?.authenticated) {
            // If still not authenticated, do not show workspace type selection.
            vscode.window.showWarningMessage('Please log in to TBD Logger first.');
            return session;
        }
        currentSession = signedSession;
    }

    const panel = vscode.window.createWebviewPanel(
        'workspaceTypeSelector',
        'TBD Logger: Workspace Type',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: false }
    );

    const nonce = getNonce();
    panel.webview.html = getWorkspaceTypeHtml(panel.webview, nonce);

    const selectedType = await new Promise<string | undefined>((resolve) => {
        const disposables: vscode.Disposable[] = [];

        disposables.push(panel.webview.onDidReceiveMessage((message) => {
            if (message?.type === 'workspaceType') {
                resolve(message.value);
                panel.dispose();
            }
        }));

        disposables.push(panel.onDidDispose(() => {
            resolve(undefined);
            disposables.forEach((d) => d.dispose());
        }));
    });

    if (selectedType === 'Personal Project') {
        // User chose no tracking for this session only.
        state.isPersonalWorkspace = true;
        await context.workspaceState.update(schoolFlagKey, false);
        hasPromptedUnrecognizedWorkspace = true;
        await updateAuthStatusBar(context);
        vscode.window.showInformationMessage('Personal Project mode selected: tracking is disabled for this session.');
    } else if (selectedType === 'School Project') {
        // Persist school choice across workspace reloads.
        await context.workspaceState.update(schoolFlagKey, true);

        // Should already be authenticated above; if not, open login first.
        let currentSession = getWorkspaceAuthSession(context);
        if (!currentSession?.authenticated) {
            const signedSession = await openAuthView(context, storageManager);
            if (!signedSession?.authenticated) {
                vscode.window.showWarningMessage('You need to log in before using a School Project workspace.');
                return session;
            }
            currentSession = signedSession;
        }

        // Ensure we don't mark personal workspace in school mode.
        state.isPersonalWorkspace = false;
        hasPromptedUnrecognizedWorkspace = true;

        if (currentSession) {
            state.currentUserRole = currentSession.role || 'None';
            state.isConsentGiven = isTrackingConsentGranted(currentSession.trackingConsent ?? state.isConsentGiven);
            await updateAuthStatusBar(context);
            updateTrackingUI(currentSession.role);
        }

        // Open the student sync UI for assignment linking.
        await openStudentSyncView(context);

        return currentSession || session;
    }

    return session;
}

export interface ExtensionApi {
    state: typeof state;
    storageManager: typeof storageManager;
}

export async function activate(context: vscode.ExtensionContext) {
    // NOTE: Do not suppress process warnings in production; show root cause.
    installNotificationToastTimeouts();
    console.log('TBD Logger: activate');

    // 👉 RULE 1 FIX: Every time VS Code boots up, wipe the old Session ID cache so a new one is forced!
    await context.workspaceState.update(SESSION_ID_KEY, undefined);

    // Ensure user is signed in on IDE open
    const initialSession = getWorkspaceAuthSession(context);
    if (!initialSession?.authenticated) {
        await openAuthView(context, storageManager);
    }

    const statusBarItem = createStatusBar(context);
    const uiTimerDisposable = startUiTimer(statusBarItem);
    context.subscriptions.push(uiTimerDisposable);

    const withApiTokenRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
        return operation();
    };

    const ensureProject = async (): Promise<number | undefined> => {
        const currentSession = getWorkspaceAuthSession(context); 
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const workspaceName = vscode.workspace.name || 'Unknown Workspace';
        const classId = Number(currentSession?.workspaceLinkedClassId ?? 0);
        const assignmentId = Number(currentSession?.workspaceLinkedAssignmentId ?? 0);
        const userId = Number(currentSession?.authUserId ?? 0);

        if (!userId || !classId || !assignmentId) { return undefined; }

        const payload = { userId, classId, assignmentId, workspaceName, workspacePath };

        try {
            let project;
            try {
                project = await withApiTokenRetry(() => apiPost('/api/projects', payload));
            } catch (apiError: any) {
                project = await withApiTokenRetry(() => 
                    apiGet(`/api/projects?workspacePath=${encodeURIComponent(workspacePath)}&userId=${userId}`)
                );
            }

            let projList = Array.isArray(project) ? project : (project?.projects || project?.data || [project]);
            let projObj = Array.isArray(projList) ? projList[0] : projList;

            const projectId = Number(projObj?.id ?? projObj?.Id ?? projObj?.projectId ?? projObj?.ProjectId);
            
            if (!Number.isFinite(projectId) || projectId <= 0) {
                throw new Error(`Project API did not return a valid id. Raw data: ${JSON.stringify(projObj)}`);
            }
            return projectId;
        } catch (error) {
            console.warn('[TBD Logger] Unable to ensure API project.', error);
            return undefined;
        }
    };

    const startSession = async (userId: number, projectId: number, sessionNumber: number): Promise<number | undefined> => {
        try {
            const currentSession = getWorkspaceAuthSession(context);
            // 💡 ONLY use the true Workspace Link ID
            const studentWorkspaceAssignmentId = Number(currentSession?.studentWorkspaceAssignmentId ?? 0);
            
            if (!Number.isFinite(studentWorkspaceAssignmentId) || studentWorkspaceAssignmentId <= 0) {
                throw new Error('Cannot start API session: Missing studentWorkspaceAssignmentId. Re-link required.');
            }

            const startedAtDate = new Date().toISOString();
            const payload: any = {
                userId,
                UserId: userId,
                projectId,
                ProjectId: projectId,
                sessionNumber,
                SessionNumber: sessionNumber,
                startedAt: startedAtDate,
                StartedAt: startedAtDate,
                studentWorkspaceAssignmentId,
                StudentWorkspaceAssignmentId: studentWorkspaceAssignmentId
            };

            let apiSession;
            try {
                apiSession = await withApiTokenRetry(() => apiPost('/api/sessions', payload));
            } catch (postErr: any) {
                // If we hit a duplicate key (23505), this sequential number is already taken. 
                // Fall back to a safe 6-digit random number to bypass the crash without overflowing the DB.
                const isDuplicate = postErr?.responseBody?.includes('23505') || postErr?.responseBody?.includes('UQ_');
                if (isDuplicate) {
                    console.log('[TBD Logger] Session number collision detected. Auto-resolving with safe random ID...');
                    const safeRand = Math.floor(Math.random() * 900000) + 100000; // Random number between 100000 and 999999
                    payload.sessionNumber = safeRand; 
                    payload.SessionNumber = safeRand; // <-- Fix: ensure both casing conventions are updated!
                    apiSession = await withApiTokenRetry(() => apiPost('/api/sessions', payload));
                } else {
                    throw postErr;
                }
            }

            const sessionId = Number(apiSession?.id ?? apiSession?.Id);
            if (!Number.isFinite(sessionId) || sessionId <= 0) {
                throw new Error('Session API did not return a valid id.');
            }

            await context.workspaceState.update(SESSION_ID_KEY, sessionId);
            return sessionId;
        } catch (error) {
            await context.workspaceState.update(SESSION_ID_KEY, undefined);
            const details = error instanceof ApiHttpError ? error.responseBody : String(error);
            console.warn('[TBD Logger] Unable to start API session.', details);
            return undefined;
        }
    };

const logEvent = async (eventType: string, data: any): Promise<void> => {
        if (state.isPersonalWorkspace) { return; }
        if (state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        
        const sessionId = context.workspaceState.get<number>(SESSION_ID_KEY);
        if (!sessionId) {
            return;
        }

        try {
            await withApiTokenRetry(() => apiPost('/api/events', {
                sessionId,
                eventType,
                occurredAt: new Date().toISOString(),
                
                // --- Flattened Native Columns ---
                flightTimeMs: data.flightTime ? Number(data.flightTime) : null,
               //fileEdit: data.fileEdit || data.file || null,
                fileView: data.fileView || null,
                fileFocusCount: data.fileFocusCount || null,
                charsAdded: data.charsAdded || null,
                pasteCharCount: data.pasteCharCount || null,
                windowFocused: data.focused !== undefined ? data.focused : null,
                workspaceName: data.workspaceName || vscode.workspace.name || null,
                studentWorkspaceAssignmentId: data.StudentWorkspaceAssignmentId || null,
                possibleAiDetection: data.possibleAiDetection || null
            }));
        } catch (error) {
            console.warn(`[TBD Logger] Failed to log event: ${eventType}`, error);
        }
    };

    try { printSessionInfo(); } catch (e) { /* no-op */ }

    await storageManager.init(context);

    let isBootingSession = false;
    let pendingBootStudentSession = false;
    let pendingBootStudentSilentCheck = true;
    const bootStudentSession = async (silentCheck = false) => {
        if (isBootingSession) {
            pendingBootStudentSession = true;
            pendingBootStudentSilentCheck = pendingBootStudentSilentCheck && silentCheck;
            return;
        }
        isBootingSession = true;
        try {
            let curSession = getWorkspaceAuthSession(context);
            if (!curSession?.authenticated || curSession.role !== 'Student') {
                return;
            }
            
            const wRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

            curSession = await reconcileStudentWorkspaceState(context, curSession, wRoot, silentCheck);
            curSession = await syncConsentFromDatabase(context, curSession, storageManager) || curSession;

            const hasLinkedWorkspace = Number(curSession.workspaceLinkedClassId ?? 0) > 0 
                && Number(curSession.workspaceLinkedAssignmentId ?? 0) > 0;

            const hasConsented = isTrackingConsentGranted(curSession.trackingConsent);
            state.isConsentGiven = hasConsented;

            if (hasLinkedWorkspace && hasConsented) {
                const currentSessionId = context.workspaceState.get<number>(SESSION_ID_KEY);
                if (!currentSessionId) {
                    const projectId = await ensureProject();
                    if (projectId) {
                        const counterKey = getSessionCounterKey(curSession.authUserId, projectId);
                        const nextSessionNumber = (context.workspaceState.get<number>(counterKey) || 0) + 1;
                        const startedSessionId = await startSession(curSession.authUserId, projectId, nextSessionNumber);
                        if (startedSessionId) {
                            await context.workspaceState.update(counterKey, nextSessionNumber);
                            void logEvent('session_start', {
                                workspaceName: vscode.workspace.name || 'Unknown Workspace',
                                workspacePath: wRoot
                            });
                        }
                    }
                }
            }

            state.isApiOnline = null;
            await updateDbStatusBar(context);
            await updateAuthStatusBar(context);
            updateTrackingUI(curSession.role);
        } catch (e) {
            console.error('[TBD Logger] Boot session error', e);
        } finally {
            isBootingSession = false;
            if (pendingBootStudentSession) {
                const rerunSilentCheck = pendingBootStudentSilentCheck;
                pendingBootStudentSession = false;
                pendingBootStudentSilentCheck = true;
                void bootStudentSession(rerunSilentCheck);
            }
        }
    };

    await bootStudentSession(false);

    const startupStudentSession = getWorkspaceAuthSession(context);
    if (startupStudentSession?.authenticated && startupStudentSession.role === 'Student') {
        const startupLinkTimer = setTimeout(() => {
            void (async () => {
                const currentSession = getWorkspaceAuthSession(context);
                if (!currentSession?.authenticated || currentSession.role !== 'Student') {
                    return;
                }

                const startupWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                if (!startupWorkspaceRoot) {
                    return;
                }

                const classId = Number(currentSession.workspaceLinkedClassId ?? 0);
                const assignmentId = Number(currentSession.workspaceLinkedAssignmentId ?? 0);
                if (!classId || !assignmentId) {
                    return;
                }

                await (storageManager as any).syncStudentWorkspaceLinkRecord({
                    studentId: currentSession.authUserId,
                    studentWorkspaceFullPath: startupWorkspaceRoot,
                    studentWorkspaceName: vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || undefined,
                    classId,
                    classAssignmentId: assignmentId,
                    className: state.activeCourse || undefined,
                    classAssignmentName: state.activeAssignment || undefined,
                    showNotification: true
                });
            })();
        }, 10_000);

        context.subscriptions.push({ dispose: () => clearTimeout(startupLinkTimer) });
    }

    const startupDebugSession = getWorkspaceAuthSession(context);
    const debugSession = startupDebugSession;
    const startupDebugAssignments = await (async () => {
        if (!startupDebugSession?.authenticated || startupDebugSession.role !== 'Student') {
            return [] as Array<{ className: string; assignmentName: string; workspaceRootPath?: string }>;
        }

        try {
            const classes = await (storageManager as any).listStudentClasses(startupDebugSession.authUserId);
            const items: Array<{ className: string; assignmentName: string; workspaceRootPath?: string }> = [];

            for (const c of classes || []) {
                const assignments = await (storageManager as any).listStudentAssignmentsForClass(startupDebugSession.authUserId, c.id);
                if (assignments) {
                    items.push(...assignments.map((assignment: any) => ({
                        className: String(c.courseName || c.courseCode || c.name || `Class ID: ${c.id}`),
                        assignmentName: String(assignment.assignmentName || assignment.name || `Assignment ID: ${assignment.assignmentId}`),
                        workspaceRootPath: assignment.workspaceRootPath
                    })));
                }
            }
            return items;
        } catch (error) {
            console.warn('[TBD Logger] Unable to gather startup assignment debug data.', error);
            return [] as Array<{ className: string; assignmentName: string; workspaceRootPath?: string }>;
        }
    })();

    const startupAssignmentInfo = startupDebugSession?.authenticated && state.activeAssignment
        ? {
            classId: Number(startupDebugSession.workspaceLinkedClassId ?? 0),
            courseName: state.activeCourse || undefined,
            assignmentId: Number(startupDebugSession.workspaceLinkedAssignmentId ?? 0),
            assignmentName: state.activeAssignment,
            studentWorkspaceAssignmentId: Number(startupDebugSession.studentWorkspaceAssignmentId ?? 0)
        }
        : null;

    const wRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    await showStartupWorkspaceDebugPopup(startupDebugSession, wRoot, startupAssignmentInfo, startupDebugAssignments);

    logStartupIdentity(context);

    updateApiKeyStatus(!!debugSession?.authenticated && debugSession.role === 'Student');
    await updateDbStatusBar(context);
    await updateAuthStatusBar(context);

    // 3. Update the tracking UI based on role and validation results
    updateTrackingUI(debugSession?.role);
    updateApiKeyStatus(!!debugSession?.authenticated && debugSession.role === 'Student');
    await updateAuthStatusBar(context);

    const CURRENT_POLICY_VERSION = 'v1.1'; 

    if (debugSession?.authenticated && debugSession.role === 'Student' && !state.isPersonalWorkspace) {
        const hasLinkedWorkspace = Number(debugSession.workspaceLinkedClassId ?? 0) > 0 
            && Number(debugSession.workspaceLinkedAssignmentId ?? 0) > 0;

       if (hasLinkedWorkspace) {
            const projectId = await ensureProject();
            if (projectId) {
                const counterKey = getSessionCounterKey(debugSession.authUserId, projectId);
                const nextSessionNumber = (context.workspaceState.get<number>(counterKey) || 0) + 1;
                const startedSessionId = await startSession(debugSession.authUserId, projectId, nextSessionNumber);
                if (startedSessionId) {
                    await context.workspaceState.update(counterKey, nextSessionNumber);
                    void logEvent('session_start', {
                        workspaceName: vscode.workspace.name || 'Unknown Workspace',
                        workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
                    });
                }
            }
        }
    }
    
    // Consent Check Gate
    if (debugSession?.authenticated) {
        if (debugSession.role === 'Student' && !state.isPersonalWorkspace) {
            const hasConsented = isTrackingConsentGranted(debugSession.trackingConsent);
            state.isConsentGiven = hasConsented;

            if (!hasConsented) {
                const choice = await vscode.window.showInformationMessage(
                    'Privacy Policy: Coding activity is being recorded for academic integrity purposes. By continuing, you acknowledge and agree to this tracking as a condition of using TBD Logger.',
                    { modal: true },
                    'I Acknowledge and Agree',
                    'Decline'
                );

                if (choice === 'I Acknowledge and Agree') {
                    await storageManager.recordUserConsent('v1.1');
                    state.isConsentGiven = true;
                    const refreshedSession = getWorkspaceAuthSession(context);
                    if (refreshedSession) {
                        refreshedSession.trackingConsent = true;
                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, refreshedSession);
                    }
                    updateAuthStatusBar(context);
                } else {
                    state.isConsentGiven = false;
                    updateAuthStatusBar(context);
                    vscode.window.showWarningMessage('Tracking disabled. Your work will NOT be recorded.');
                }
            }
        } else {
            state.isConsentGiven = false;
            updateAuthStatusBar(context); 
        }
    } else {
        state.isConsentGiven = false; 
    }

    if (process.env.CI === 'true') {
        state.isConsentGiven = true;
    }

    // 👉 RULE 2 FIX: Tell the interruption tracker to force a new session after 60 mins of inactivity
    await SessionInterruptionTracker.install(context, {
        inactivityThresholdMs: 5 * 60 * 1000,     // 5 minutes = standard pause
        checkEveryMs: 10_000,
        newSessionThresholdMs: 60 * 60 * 1000,    // 60 minutes = hard split into new session
        onRequireNewSession: async () => {
            await context.workspaceState.update(SESSION_ID_KEY, undefined);
            void bootStudentSession(true);
        }
    });

    if ((state.currentUserRole === 'Student' || state.currentUserRole === 'None') && !state.isPersonalWorkspace) {
        state.sessionBuffer.push({
            time: formatTimestamp(Date.now()),
            flightTime: '0',
            eventType: 'session-start',
            fileEdit: '',
            fileView: 'VS Code Session Started'
        });
    }

    const initialActive = vscode.window.activeTextEditor;
    const initialPath = initialActive && initialActive.document ? vscode.workspace.asRelativePath(initialActive.document.uri, false) : '';
    state.currentFocusedFile = isIgnoredPath(initialPath) ? '' : initialPath;
    state.focusStartTime = Date.now();

    const openLogs = async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Log access');
        if (!allowed) { return; }

        try {
            const active = vscode.window.activeTextEditor;
            let targetUri: vscode.Uri | null = null;

            if (active && active.document) {
                const fname = path.basename(active.document.uri.fsPath);
                if (/Session\d+-integrity\.log$/.test(fname)) {
                    targetUri = active.document.uri;
                }
            }

            if (!targetUri) {
                const files = await storageManager.listLogFiles();
                if (files.length === 0) {
                    vscode.window.showInformationMessage('No integrity logs found.');
                    return;
                }
                const pick = await vscode.window.showQuickPick(files.map(f => f.label), { placeHolder: 'Select integrity log to open' });
                if (!pick) {return;}
                const chosen = files.find(f => f.label === pick);
                if (!chosen) {return;}
                targetUri = chosen.uri;
            }

            const password = await vscode.window.showInputBox({
                prompt: `Enter Administrator Password to view ${path.basename(targetUri.fsPath)}`,
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'TBD_CAPSTONE...'
            });

            if (!password) {return;}

            const content = await storageManager.retrieveLogContentForUri(password, targetUri);
            const doc = await vscode.workspace.openTextDocument({
                content: content,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('Logs decrypted successfully.');

        } catch (err) {
            const message = getUserFriendlyErrorMessage(err, 'Access denied. Please sign in and try again.');
            vscode.window.showErrorMessage(`Access Denied: ${message}`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.openLogs', openLogs));

    const showHidden = async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Deletion activity log');
        if (!allowed) { return; }

        try {
            const password = await vscode.window.showInputBox({
                prompt: 'Enter Administrator Password to view deletion activity log',
                password: true,
                ignoreFocusOut: true
            });
            if (!password) {return;}
            const content = await storageManager.retrieveHiddenLogContent(password);
            const doc = await vscode.workspace.openTextDocument({ content: content, language: 'json' });
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
            const message = getUserFriendlyErrorMessage(err, 'Unable to access deletion activity log. Please try again.');
            vscode.window.showErrorMessage(`Unable to access deletion activity log: ${message}`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.showHiddenDeletions', showHidden));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.openTeacherView', async () => {
        const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Teacher Dashboard');
        if (!allowed) { return; }
        await openTeacherView(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.manageClassActivities', async () => {
        await manageClassActivities(context, storageManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.authSignIn', async () => {
        const curSession = getWorkspaceAuthSession(context);
        if (curSession?.authenticated) {
            const ideIdentity = getSessionInfo().user;
            const workspaceName = vscode.workspace.name || 'Unknown Workspace';

            const refreshedSession = await openAccountView(context, storageManager, { ideUser: ideIdentity, workspaceName });
            if (refreshedSession?.role === 'Student') {
                await bootStudentSession(false);
            }
            await updateAuthStatusBar(context);
            return;
        }

        const signedSession = await openAuthView(context, storageManager);
        if (signedSession?.role === 'Student') {
            await bootStudentSession(false);
        }
        await updateAuthStatusBar(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.signOut', async () => {
        const curSession = getWorkspaceAuthSession(context);
        if (!curSession?.authenticated) {
            vscode.window.showInformationMessage('You are not currently logged in.');
            return;
        }

        const answer = await openLogoutConfirmView(context, {
            displayName: curSession.displayName,
            role: curSession.role
        });

        if (answer) {
            await closeAllWebviews();
            await clearWorkspaceAuthSession(context);
            await updateAuthStatusBar(context);
            vscode.window.showInformationMessage('You have been logged out.');
        }
    }));

    updateAuthStatusBar(context);

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.refreshStatusBar', async () => {
        await updateDbStatusBar(context);
        await updateAuthStatusBar(context);
        updateTrackingUI(getWorkspaceAuthSession(context)?.role || 'None');
    }));

    context.subscriptions.push(createEditListener());
    context.subscriptions.push(createFocusListener());
    context.subscriptions.push(createWindowStateListener());
    context.subscriptions.push(createSaveListener());

    // 1. Track when a new terminal is opened (often happens when "Run Code" is clicked)
    context.subscriptions.push(vscode.window.onDidOpenTerminal((terminal) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        void logEvent('terminal_run', { fileView: terminal.name || 'Terminal Opened' });
    }));

    // 2. Track when a user clicks into the terminal (to manually type "python main.py")
    context.subscriptions.push(vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal || state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        void logEvent('terminal_run', { fileView: terminal.name || 'Terminal Focused' });
    }));

    // 3. Track when a Debugger/Run session is started (e.g., hitting F5)
    context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        void logEvent('debug_start', { fileView: session.name || 'Debug Session' });
    }));

    // 4. Track when a VS Code Task is run
    context.subscriptions.push(vscode.tasks.onDidStartTask((e) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        void logEvent('run-script', { fileView: e.execution.task.name || 'Task Execution' });
    }));

    let _authPromptShown = false;
    let _unmonitoredAlertCaptured = false;

    const promptIfUnauthenticated = async () => {
        if (process.env.CI === 'true') { return; }
        if (_authPromptShown) { return; }
        if (state.isPersonalWorkspace) { return; }

        const curSession = getWorkspaceAuthSession(context);
        if (curSession?.authenticated) { return; }

        if (!_unmonitoredAlertCaptured) {
            _unmonitoredAlertCaptured = true;
            const info = getSessionInfo();
            const wPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            await storageManager.recordUnmonitoredWorkAlert({
                ideUser: info.user,
                workspaceName: info.project,
                workspacePath: wPath,
                reason: 'Student activity detected while not signed in to TBD Logger monitoring.'
            });
        }

        _authPromptShown = true;

        const choice = await vscode.window.showWarningMessage(
            'You are not signed in to TBD Logger. Your activity is not being tracked.',
            'Login',
            'Keep Working Without',
            "I'm Not Working on School"
        );

        if (choice === 'Login') {
            _authPromptShown = false;
            await openAuthView(context, storageManager);
            updateAuthStatusBar(context);
        } else if (choice === "I'm Not Working on School") {
            state.isPersonalWorkspace = true;
            const wPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            if (wPath) {
                await context.workspaceState.update(`tbd.personalWorkspace.${wPath}`, true);
            }
            updateAuthStatusBar(context);
        }
    };

    // context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    //     if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
    //     if (e.contentChanges.length === 0) { return; }
    //     const docPath = vscode.workspace.asRelativePath(e.document.uri, false);
    //     if (isIgnoredPath(docPath)) { return; }
    //     void promptIfUnauthenticated();

    //     const charsAdded = e.contentChanges.reduce((sum, change) => sum + change.text.length, 0);
    //     const isPaste = e.contentChanges.some((change) => change.text.length > 1);
    //     void logEvent(isPaste ? 'paste' : 'file_edit', {
    //         file: docPath,
    //         changeCount: e.contentChanges.length,
    //         charsAdded
    //     });
    // }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_save', { file: docPath });
    }));

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_open', { file: docPath });
    }));

    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        const docPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('file_close', { file: docPath });
    }));

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        if (!editor) {
            void logEvent('active_editor_change', { file: '' });
            return;
        }
        const docPath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void logEvent('active_editor_change', { file: docPath });
    }));

    context.subscriptions.push(vscode.window.onDidChangeWindowState((windowState) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        void logEvent('window_state_change', {
            focused: windowState.focused
        });
    }));

    context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => void promptIfUnauthenticated()));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => void promptIfUnauthenticated()));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => void promptIfUnauthenticated()));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.checkDbStatus', () => {
        void updateDbStatusBar(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.testDbConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`API ONLINE\nStatus: ${result?.status ?? 'unknown'}`);
        } catch (err: any) {
            const message = getUserFriendlyErrorMessage(err, 'API health check failed. Please try again later.');
            vscode.window.showErrorMessage(`API health check failed. ${message}`);
        }
        void updateDbStatusBar(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd.testConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`API status: ${result.status}`);
        } catch (error: any) {
            const message = getUserFriendlyErrorMessage(error, 'API test failed. Please try again later.');
            vscode.window.showErrorMessage(`API test failed. ${message}`);
        }
    }));

    const flushTimer = setInterval(() => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') {
            state.sessionBuffer = []; 
            return;
        }
        void flushBuffer();
    }, CONSTANTS.FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });

    let lastStatusSnapshot = '';
    const statusUpdateTimer = setInterval(() => {
        const curSession = getWorkspaceAuthSession(context);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const statusSnapshot = [
            curSession?.authenticated ? '1' : '0',
            curSession?.role || 'None',
            String(curSession?.authUserId || 0),
            workspaceRoot,
            state.isPersonalWorkspace ? '1' : '0',
            state.activeCourse || '',
            state.activeAssignment || '',
            String(context.workspaceState.get<number>(SESSION_ID_KEY) || 0)
        ].join('|');

        if (statusSnapshot !== lastStatusSnapshot) {
            lastStatusSnapshot = statusSnapshot;
            if (curSession?.authenticated && curSession.role === 'Student') {
                void bootStudentSession(true);
            } else {
                void updateAuthStatusBar(context);
            }
        }

        void updateDbStatusBar(context);
    }, 2000); 
    context.subscriptions.push({ dispose: () => clearInterval(statusUpdateTimer) });

    void updateDbStatusBar(context);
    
    let isSyncing = false;
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.forceSync', async () => {
        const curSession = getWorkspaceAuthSession(context);
        const forceWRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!curSession?.authenticated || !curSession?.authUserId) {
            vscode.window.showErrorMessage("Sync Denied: Please log in first.");
            return;
        }

        const assignmentLink = await (storageManager as any).validateAssignmentLink(
            curSession.authUserId, 
            forceWRoot || ''
        );

        if (!assignmentLink) {
            vscode.window.showErrorMessage(
                "Sync Blocked: This workspace is not attached to an active assignment. Please join a class and link this folder first."
            );
            return;
        }

        if (isSyncing || state.isFlushing) {
            vscode.window.showInformationMessage("Sync already in progress...");
            return;
        }

        isSyncing = true;
        updateSyncStatus(true);
        
        try {
            await flushBuffer();
            const syncStatus = (storageManager as any).getBackgroundSyncStatus();
            if (syncStatus?.state === 'offline' || syncStatus?.lastError) {
                vscode.window.showWarningMessage("Sync queued locally. The database rejected the events or is offline.");
                throw new Error("OfflineSync"); 
            } else {
                vscode.window.showInformationMessage(`Successfully synced to: ${assignmentLink.assignmentName}`);
            }
        } catch (error) {
            if (!(error instanceof Error) || error.message !== "OfflineSync") {
                vscode.window.showErrorMessage("Sync failed. Check your network connection.");
            }
            throw error; // Let the UI catch this to display the queued state
        } finally {
            isSyncing = false;
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.openStudentSyncView', async () => {
        await openStudentSyncView(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd.admin.runPurge', async () => {
        vscode.window.showInformationMessage('TBD Logger: Initiating data purge. Check console for details.');
        await storageManager.runAutomatedDataPurge(365); 
    }));
    context.subscriptions.push(vscode.commands.registerCommand('tbd-logger.repairWorkspaceLink', async () => {
        const session = context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        if (!session?.authenticated || session.role !== 'Student' || !workspaceRoot) {
            vscode.window.showErrorMessage("Repair Failed: Not logged in as a student or no workspace open.");
            return;
        }

        try {
            vscode.window.showInformationMessage("Querying backend for real database IDs...");
            
            const classes = await (storageManager as any).listStudentClasses(session.authUserId);
            console.log("[TBD Repair] Classes found:", classes);
            
            let foundRealId = null;
            let targetClassId = null;
            let targetAssignId = null;

            for (const c of classes) {
                const assignments = await (storageManager as any).listStudentAssignmentsForClass(session.authUserId, c.id);
                
                for (const a of assignments) {
                    // Check if this assignment matches your current folder
                    if (a.workspaceRootPath && vscode.Uri.file(a.workspaceRootPath).fsPath === vscode.Uri.file(workspaceRoot).fsPath) {
                        foundRealId = a.workspaceId || a.id || a.studentWorkspaceAssignmentId || a.assignmentId;
                        targetClassId = c.id;
                        targetAssignId = a.assignmentId;
                        console.log("[TBD Repair] MATCH FOUND!", a);
                        break;
                    }
                }
                if (foundRealId) { break; }
            }

            if (foundRealId) {
                // Force overwrite the generated hash with the REAL database ID
                session.workspaceLinkedClassId = targetClassId;
                session.workspaceLinkedAssignmentId = targetAssignId;
                session.studentWorkspaceAssignmentId = foundRealId;
                await context.workspaceState.update('tbd.auth.workspaceSession.v1', session);
                
                // Clear the corrupted session ID so it generates a fresh, clean one
                await context.workspaceState.update(SESSION_ID_KEY, undefined);
                
                vscode.window.showInformationMessage(`Fixed! Real Workspace ID (${foundRealId}) restored. Click "Manual Sync" in the dashboard.`);
                console.log("[TBD Repair] Session repaired successfully.", session);
            } else {
                vscode.window.showWarningMessage("Could not find a matching workspace on the server. Please click 'Connect Workspace to Assignment' again.");
            }

        } catch (e) {
            console.error("[TBD Repair] Error", e);
            vscode.window.showErrorMessage("Repair script failed. See debug console.");
        }
    }));

    return { state, storageManager };
}

export function deactivate() {
    SessionInterruptionTracker.markCleanShutdown();

    if (state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin' || state.isPersonalWorkspace) {
        state.sessionBuffer = []; 
    } else {
        const now = Date.now();
        if (state.currentFocusedFile) {
            state.sessionBuffer.push({
                time: formatTimestamp(now),
                flightTime: String(now - state.focusStartTime),
                eventType: 'focusDuration',
                fileEdit: '',
                fileView: state.currentFocusedFile
            });
        }

        void flushBuffer();
    }

    const globalSb = (global as any).statusBarItem as vscode.StatusBarItem | undefined;
    if (globalSb) { globalSb.dispose(); }

    const dbStatusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (dbStatusItem) { dbStatusItem.dispose(); }

    const authStatusItem = (global as any).authStatusBarItem as vscode.StatusBarItem | undefined;
    if (authStatusItem) { authStatusItem.dispose(); }

    const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;
    if (hiddenItem) { hiddenItem.dispose(); }

    void storageManager.dispose();
}