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
import { isIgnoredPath, formatTimestamp } from './utils';
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
            message.includes('SQLite is an experimental feature')
        ) {
            return;
        }

        return originalEmitWarning(warning as any, ...args as any);
    }) as typeof process.emitWarning;
}

const SESSION_ID_KEY = 'sessionId';
const SESSION_COUNTER_KEY = 'tbd.sessionNumber.counter.v1';
const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

function isTrackingConsentGranted(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}

async function updateDbStatusBar(context: vscode.ExtensionContext): Promise<void> {
    const statusItem = (global as any).dbStatusBarItem as vscode.StatusBarItem | undefined;
    if (!statusItem) { return; }

    const session = getWorkspaceAuthSession(context);
    const isTeacherView = !!session?.authenticated && (session.role === 'Teacher' || session.role === 'Admin');
    const formatTeacherApiTooltip = (apiStatus: string, backendStatus: string, routingStatus: string): string => {
        return `API: ${apiStatus} | Backend: ${backendStatus} | Routing: ${routingStatus}`;
    };
    
    if (state.isPersonalWorkspace) {
        statusItem.hide();
        return;
    }

    statusItem.show();
    statusItem.command = 'tbd-logger.openStudentSyncView';

    try {
        const health = await apiGet('/health');
        const apiStatus = String(health?.status ?? 'ok');
        const syncState = apiStatus.toLowerCase() === 'ok' ? 'online' : 'offline';
        const linkedTo = `${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;

        try {
            await apiGet('/api/sessions');
            statusItem.text = isTeacherView ? '$(cloud-upload) API Connected' : '$(refresh)';
            statusItem.tooltip = isTeacherView
                ? formatTeacherApiTooltip('Online', 'Online', 'Active & Responding')
                : `Sync: ${syncState} | Linked to: ${linkedTo}`;
            return;
        } catch (authErr) {
            if (authErr instanceof ApiHttpError && (authErr.status === 401 || authErr.status === 403)) {
                statusItem.text = isTeacherView ? '$(cloud-offline) API Auth Error' : '$(refresh)';
                statusItem.tooltip = isTeacherView
                    ? formatTeacherApiTooltip('Online', 'Online', 'Authentication Error')
                    : `Sync: offline | Linked to: ${linkedTo}`;
                return;
            }
            throw authErr;
        }
    } catch (err) {
        statusItem.text = isTeacherView ? '$(database) API Offline' : '$(refresh)';
        statusItem.tooltip = isTeacherView
            ? formatTeacherApiTooltip('Offline', 'Offline', 'Not Responding')
            : `Sync: offline | Linked to: ${state.activeCourse || 'None'} | ${state.activeAssignment || 'None'}`;
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

        return {
            classId: linkedClassId,
            courseName: className,
            assignmentId: linkedAssignmentId,
            assignmentName: String(linkedAssignment.assignmentName || linkedAssignment.name || `Assignment ID: ${linkedAssignmentId}`),
            studentWorkspaceAssignmentId: Number(linkedAssignment.workspaceId || linkedAssignment.id || 0)
        };
    } catch (error) {
        console.warn('[TBD Logger] Unable to hydrate linked workspace state from database.', error);
        return null;
    }
}

function syncTeacherDashboardLock(context: vscode.ExtensionContext): void {
    const session = getWorkspaceAuthSession(context);
    const shouldShowLock = !!(session?.authenticated && (session.role === 'Teacher' || session.role === 'Admin')) && !state.isPersonalWorkspace;
    const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem | undefined;

    void vscode.commands.executeCommand('setContext', 'tbd.hasTeacherDashboardAccess', shouldShowLock);

    if (shouldShowLock) {
        if (!hiddenItem) {
            const newHiddenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
            newHiddenItem.text = '$(layout)';
            newHiddenItem.tooltip = 'Open Teacher Dashboard';
            newHiddenItem.command = 'tbd-logger.openTeacherView';
            newHiddenItem.show();
            context.subscriptions.push(newHiddenItem);
            (global as any).hiddenStatusBarItem = newHiddenItem;
        }
        return;
    }

    if (hiddenItem) {
        hiddenItem.dispose();
        delete (global as any).hiddenStatusBarItem;
    }
}

function updateAuthStatusBar(context: vscode.ExtensionContext): void {
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
        syncTeacherDashboardLock(context);
        return;
    }

    authItem.show();
    globalSb.show();
    dbItem?.show();

    updateTrackingUI(session?.role);
    updateApiKeyStatus(!!session?.authenticated && session.role === 'Student');
    
    if (session.role !== 'Student') {
        authItem.text = `$(account) ${session.role}`;
        authItem.tooltip = 'View Account Information';
        authItem.backgroundColor = undefined;
        authItem.color = new vscode.ThemeColor('terminal.ansiBrightBlue');
        
        globalSb.hide();
        const apiStatusItem = (global as any).apiStatusBarItem as vscode.StatusBarItem | undefined;
        apiStatusItem?.hide();
        syncTeacherDashboardLock(context);
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
        syncTeacherDashboardLock(context);
        void updateDbStatusBar(context);
        return;
    }
    
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
    }
    
    if (state.activeAssignment) {
        globalSb.text = `$(record) Recording: ${state.activeAssignment}`;
        globalSb.tooltip = `Logging data to ${state.activeCourse || 'Linked Assignment'} | ${state.activeAssignment}`;
        globalSb.color = new vscode.ThemeColor('testing.iconPassed');
        globalSb.backgroundColor = undefined;
        globalSb.command = undefined;
    } else {
        globalSb.text = `$(warning) Finish Linking Workspace`;
        globalSb.tooltip = `Click to connect this workspace to an assignment.`;
        globalSb.color = new vscode.ThemeColor('list.warningForeground');
        globalSb.backgroundColor = undefined;
        globalSb.command = 'tbd-logger.openStudentSyncView';
    }

    syncTeacherDashboardLock(context);
    void updateDbStatusBar(context);
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

    const personalFlagKey = `tbd.personalWorkspace.${workspaceRoot}`;
    const isAlreadyPersonal = context.workspaceState.get<boolean>(personalFlagKey);
    if (isAlreadyPersonal) {
        state.isPersonalWorkspace = true;
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
                        assignmentInfo = {
                            classId: c.id,
                            courseName: c.courseName || c.courseCode,
                            assignmentId: linked.assignmentId,
                            assignmentName: linked.assignmentName || linked.name,
                            studentWorkspaceAssignmentId: Number(linked.workspaceId || linked.id || 0)
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
        return session;
    }

    if (silentCheck || hasPromptedUnrecognizedWorkspace) {
        return session;
    }
    
    hasPromptedUnrecognizedWorkspace = true;
    const choice = await vscode.window.showInformationMessage(
        'TBD Logger: Unrecognized Workspace. Is this a Personal Project or a School Assignment?',
        { modal: true },
        'School Project',
        'Personal Project'
    );

    if (choice === 'Personal Project') {
        state.isPersonalWorkspace = true;
        await context.workspaceState.update(personalFlagKey, true);
        vscode.window.showInformationMessage('TBD Logger UI and Tracking hidden for this personal workspace.');
    } else if (choice === 'School Project') {
        await vscode.commands.executeCommand('tbd-logger.openStudentSyncView');
    }

    return session;
}

export interface ExtensionApi {
    state: typeof state;
    storageManager: typeof storageManager;
}

export async function activate(context: vscode.ExtensionContext) {
    installRuntimeWarningFilter();
    installNotificationToastTimeouts();
    console.log('TBD Logger: activate');

    // 👉 RULE 1 FIX: Every time VS Code boots up, wipe the old Session ID cache so a new one is forced!
    await context.workspaceState.update(SESSION_ID_KEY, undefined);

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
            let studentWorkspaceAssignmentId = Number(currentSession?.studentWorkspaceAssignmentId ?? 0);
            
            if (!studentWorkspaceAssignmentId) {
                studentWorkspaceAssignmentId = Number(currentSession?.workspaceLinkedAssignmentId ?? 0);
            }

            if (!Number.isFinite(studentWorkspaceAssignmentId) || studentWorkspaceAssignmentId <= 0) {
                throw new Error('Cannot start API session without a valid studentWorkspaceAssignmentId.');
            }

            const payload = {
                userId,
                projectId,
                sessionNumber,
                startedAt: new Date().toISOString(),
                studentWorkspaceAssignmentId
            };

            const apiSession = await withApiTokenRetry(() => apiPost('/api/sessions', {
                ...payload
            }));

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
                eventData: data
            }));
        } catch (error) {
            console.warn(`[TBD Logger] Failed to log event: ${eventType}`, error);
        }
    };

    try { printSessionInfo(); } catch (e) { /* no-op */ }

    await storageManager.init(context);

    let isBootingSession = false;
    const bootStudentSession = async (silentCheck = false) => {
        if (isBootingSession) return;
        isBootingSession = true;
        try {
            let curSession = getWorkspaceAuthSession(context);
            if (!curSession?.authenticated || curSession.role !== 'Student' || state.isPersonalWorkspace) {
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
                        const nextSessionNumber = (context.workspaceState.get<number>(SESSION_COUNTER_KEY) || 0) + 1;
                        const startedSessionId = await startSession(curSession.authUserId, projectId, nextSessionNumber);
                        if (startedSessionId) {
                            await context.workspaceState.update(SESSION_COUNTER_KEY, nextSessionNumber);
                            void logEvent('session_start', {
                                workspaceName: vscode.workspace.name || 'Unknown Workspace',
                                workspacePath: wRoot
                            });
                        }
                    }
                }
            }
            
            updateTrackingUI(curSession.role);
            updateApiKeyStatus(true);
            updateAuthStatusBar(context);
            void updateDbStatusBar(context);
        } catch (e) {
            console.error('[TBD Logger] Boot session error', e);
        } finally {
            isBootingSession = false;
        }
    };

    await bootStudentSession(false);

    const startupDebugSession = getWorkspaceAuthSession(context);
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

    let latestSessionForConsent = getWorkspaceAuthSession(context);
    if (latestSessionForConsent?.authenticated) {
        if (latestSessionForConsent.role === 'Student' && !state.isPersonalWorkspace) {
            const hasConsented = isTrackingConsentGranted(latestSessionForConsent.trackingConsent);
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
            vscode.window.showErrorMessage(`Access Denied: ${err}`);
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
            vscode.window.showErrorMessage(`Unable to access deletion activity log: ${err}`);
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

            await openAccountView(context, storageManager, { ideUser: ideIdentity, workspaceName });
            updateAuthStatusBar(context);
            return;
        }

        await openAuthView(context, storageManager);
        updateAuthStatusBar(context);
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
            await clearWorkspaceAuthSession(context);
            updateAuthStatusBar(context);
            vscode.window.showInformationMessage('You have been logged out.');
        }
    }));

    updateAuthStatusBar(context);

    context.subscriptions.push(createEditListener());
    context.subscriptions.push(createFocusListener());
    context.subscriptions.push(createWindowStateListener());
    context.subscriptions.push(createSaveListener());

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

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (state.isPersonalWorkspace || state.currentUserRole === 'Teacher' || state.currentUserRole === 'Admin') { return; }
        if (e.contentChanges.length === 0) { return; }
        const docPath = vscode.workspace.asRelativePath(e.document.uri, false);
        if (isIgnoredPath(docPath)) { return; }
        void promptIfUnauthenticated();

        const charsAdded = e.contentChanges.reduce((sum, change) => sum + change.text.length, 0);
        const isPaste = e.contentChanges.some((change) => change.text.length > 1);
        void logEvent(isPaste ? 'paste' : 'file_edit', {
            file: docPath,
            changeCount: e.contentChanges.length,
            charsAdded
        });
    }));

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
            vscode.window.showErrorMessage(
                `API health check failed!\nError: ${err?.message || String(err)}`
            );
        }
        void updateDbStatusBar(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tbd.testConnection', async () => {
        try {
            const result = await apiGet('/health');
            vscode.window.showInformationMessage(`API status: ${result.status}`);
        } catch (error: any) {
            const message = error?.message || String(error);
            vscode.window.showErrorMessage(`API test failed: ${message}`);
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

    const statusUpdateTimer = setInterval(() => {
        const curSession = getWorkspaceAuthSession(context);
        if (curSession?.authenticated && curSession.role === 'Student' && !state.isPersonalWorkspace) {
            const hasSessionId = !!context.workspaceState.get<number>(SESSION_ID_KEY);
            if (!state.activeAssignment || !hasSessionId) {
                void bootStudentSession(true);
            }
        }
        void updateDbStatusBar(context);
    }, 5000); 
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
            vscode.window.showInformationMessage(`Successfully synced to: ${assignmentLink.assignmentName}`);
        } catch (error) {
            vscode.window.showErrorMessage("Sync failed. Check your network connection.");
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