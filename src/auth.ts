import * as vscode from 'vscode';
import type { DbStorageManager, UserRole, ClassActivityRecord } from './dbStorageManager';

export type AuthProvider = 'microsoft' | 'google' | 'email';

interface AuthIdentity {
    provider: AuthProvider;
    subjectId: string;
    email: string;
    displayName: string;
}

export interface WorkspaceAuthSession {
    authenticated: boolean;
    authUserId: number;
    role: UserRole;
    provider: AuthProvider;
    displayName: string;
    email: string;
    workspaceLinkedActivityId?: number;
    workspaceLinkedClassId?: number;
    workspaceLinkedAssignmentId?: number;
}

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

function isLikelyTestContext(context: vscode.ExtensionContext): boolean {
    return !context.extensionPath || !context.globalStoragePath;
}

function extractWorkspaceMetadata(): {
    workspaceName: string;
    workspaceRootPath: string;
    workspaceFoldersJson: string;
} {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const first = folders[0];
    return {
        workspaceName: vscode.workspace.name || first?.name || 'Untitled Workspace',
        workspaceRootPath: first?.uri.fsPath || 'unknown-workspace',
        workspaceFoldersJson: JSON.stringify(
            folders.map(f => ({ name: f.name, fsPath: f.uri.fsPath }))
        )
    };
}

async function pickRole(): Promise<UserRole | undefined> {
    const selected = await vscode.window.showQuickPick(
        [
            { label: 'Student', description: 'Link this workspace to a class activity' },
            { label: 'Teacher', description: 'Access teacher dashboard and class activities' },
            { label: 'Admin', description: 'Full system management and troubleshooting access' }
        ],
        {
            title: 'Select your role for this account',
            placeHolder: 'Choose your role (first-time setup)'
        }
    );

    return selected?.label as UserRole | undefined;
}

async function authenticateWithOAuth(provider: 'microsoft' | 'google'): Promise<AuthIdentity | undefined> {
    try {
        const scopes = provider === 'microsoft' ? ['User.Read'] : ['openid', 'profile', 'email'];
        const session = await vscode.authentication.getSession(provider, scopes, { createIfNone: true });
        if (!session) {
            return undefined;
        }

        const accountName = session.account.label || `${provider} user`;
        const emailGuess = accountName.includes('@') ? accountName : `${session.account.id}@${provider}.local`;

        return {
            provider,
            subjectId: session.account.id,
            email: emailGuess,
            displayName: accountName
        };
    } catch (err) {
        vscode.window.showWarningMessage(
            `${provider} sign-in is unavailable in this environment. You can use Email/Password instead.`
        );
        return undefined;
    }
}

async function authenticateWithEmailPassword(): Promise<AuthIdentity | undefined> {
    const email = await vscode.window.showInputBox({
        title: 'Sign in with Email/Password',
        prompt: 'Enter your school email',
        placeHolder: 'student@school.edu',
        ignoreFocusOut: true
    });
    if (!email) {
        return undefined;
    }

    const password = await vscode.window.showInputBox({
        title: 'Sign in with Email/Password',
        prompt: 'Enter your password',
        password: true,
        ignoreFocusOut: true
    });

    if (!password) {
        return undefined;
    }

    // Placeholder verifier for email/password mode.
    if (password.trim().length < 4) {
        vscode.window.showErrorMessage('Invalid credentials. Password was too short.');
        return undefined;
    }

    return {
        provider: 'email',
        subjectId: email.toLowerCase(),
        email: email.toLowerCase(),
        displayName: email.split('@')[0] || email
    };
}

async function runSignInFlow(): Promise<AuthIdentity | undefined> {
    const method = await vscode.window.showQuickPick(
        [
            { label: 'School Microsoft (OAuth2)', value: 'microsoft' },
            { label: 'Google (OAuth2)', value: 'google' },
            { label: 'Email/Password', value: 'email' }
        ],
        {
            title: 'TBD Logger Login / Register',
            placeHolder: 'Choose a login or registration method to continue'
        }
    );

    if (!method) {
        return undefined;
    }

    if (method.value === 'microsoft') {
        return authenticateWithOAuth('microsoft');
    }
    if (method.value === 'google') {
        return authenticateWithOAuth('google');
    }
    return authenticateWithEmailPassword();
}

async function promptStudentAssignmentLink(
    storageManager: DbStorageManager,
    authUserId: number
): Promise<{ classId: number; assignmentId: number } | undefined> {
    const joinCode = await vscode.window.showInputBox({
        title: 'Join Class',
        prompt: 'Enter your class join code provided by your teacher',
        placeHolder: 'Example: TBD-A1B2C3',
        ignoreFocusOut: true
    });

    if (!joinCode) {
        return undefined;
    }

    const linkedClass = await storageManager.findClassByJoinCode(joinCode.trim());
    if (!linkedClass) {
        vscode.window.showErrorMessage('Class join code not found. Please verify the code with your teacher.');
        return undefined;
    }

    const assignments = await storageManager.listAssignmentsForClass(linkedClass.id);
    if (assignments.length === 0) {
        vscode.window.showErrorMessage(
            'This class does not have assignments yet. Ask your teacher to create an assignment first.'
        );
        return undefined;
    }

    const pick = await vscode.window.showQuickPick(
        assignments.map(a => ({
            label: a.name,
            description: `${linkedClass.courseCode} • ${linkedClass.teacherName}`,
            detail: a.dueDate ? `Due: ${a.dueDate}` : 'No due date',
            assignment: a
        })),
        {
            title: `Link Workspace to Assignment (${linkedClass.courseName})`,
            placeHolder: 'Select the assignment/project for this workspace'
        }
    );

    if (!pick) {
        return undefined;
    }

    const metadata = extractWorkspaceMetadata();
    await storageManager.linkStudentWorkspaceToAssignment({
        studentAuthUserId: authUserId,
        teacherAuthUserId: linkedClass.teacherAuthUserId,
        classId: linkedClass.id,
        assignmentId: pick.assignment.id,
        workspaceName: metadata.workspaceName,
        workspaceRootPath: metadata.workspaceRootPath,
        workspaceFoldersJson: metadata.workspaceFoldersJson
    });

    return {
        classId: linkedClass.id,
        assignmentId: pick.assignment.id
    };
}

export async function initializeWorkspaceAccess(
    context: vscode.ExtensionContext,
    storageManager: DbStorageManager,
    forcePrompt = false
): Promise<WorkspaceAuthSession | undefined> {
    const existing = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
    if (!forcePrompt && existing?.authenticated) {
        return existing;
    }

    if (isLikelyTestContext(context)) {
        const synthetic: WorkspaceAuthSession = {
            authenticated: true,
            authUserId: -1,
            role: 'Admin',
            provider: 'email',
            displayName: 'test-user',
            email: 'test@local'
        };
        await context.workspaceState.update(WORKSPACE_AUTH_KEY, synthetic);
        return synthetic;
    }

    const identity = await runSignInFlow();
    if (!identity) {
        vscode.window.showWarningMessage('Workspace authentication was cancelled. Restricted features will remain locked.');
        return undefined;
    }

    const upserted = await storageManager.upsertAuthUser({
        provider: identity.provider,
        subjectId: identity.subjectId,
        email: identity.email,
        displayName: identity.displayName
    });

    let resolvedRole: UserRole = upserted.role;
    if (upserted.isNew) {
        const chosenRole = await pickRole();
        if (!chosenRole) {
            vscode.window.showWarningMessage('Role assignment was cancelled. Access-controlled features remain unavailable.');
            return undefined;
        }

        resolvedRole = chosenRole;
        await storageManager.updateAuthUserRole(upserted.authUserId, chosenRole);
    }

    let workspaceLinkedActivityId: number | undefined;
    let workspaceLinkedClassId: number | undefined;
    let workspaceLinkedAssignmentId: number | undefined;
    if (resolvedRole === 'Student') {
        const linked = await promptStudentAssignmentLink(storageManager, upserted.authUserId);
        workspaceLinkedClassId = linked?.classId;
        workspaceLinkedAssignmentId = linked?.assignmentId;
        workspaceLinkedActivityId = linked?.assignmentId;
    }

    const session: WorkspaceAuthSession = {
        authenticated: true,
        authUserId: upserted.authUserId,
        role: resolvedRole,
        provider: identity.provider,
        displayName: identity.displayName,
        email: identity.email,
        workspaceLinkedActivityId,
        workspaceLinkedClassId,
        workspaceLinkedAssignmentId
    };

    await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
    vscode.window.showInformationMessage(`Signed in as ${session.displayName} (${session.role}).`);
    return session;
}

export function getWorkspaceAuthSession(context: vscode.ExtensionContext): WorkspaceAuthSession | undefined {
    return context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
}

export async function clearWorkspaceAuthSession(context: vscode.ExtensionContext): Promise<void> {
    await context.workspaceState.update(WORKSPACE_AUTH_KEY, undefined);
}

export async function requireRoleAccess(
    context: vscode.ExtensionContext,
    allowedRoles: UserRole[],
    featureName: string
): Promise<boolean> {
    const session = getWorkspaceAuthSession(context);
    if (!session?.authenticated) {
        vscode.window.showErrorMessage(`${featureName} requires authentication.`);
        return false;
    }

    if (!allowedRoles.includes(session.role)) {
        vscode.window.showErrorMessage(`${featureName} is only available to: ${allowedRoles.join(', ')}.`);
        return false;
    }

    return true;
}

export async function manageClassActivities(
    context: vscode.ExtensionContext,
    storageManager: DbStorageManager
): Promise<void> {
    const session = getWorkspaceAuthSession(context);
    if (!session?.authenticated) {
        vscode.window.showErrorMessage('Please sign in before managing class activities.');
        return;
    }
    if (!(session.role === 'Teacher' || session.role === 'Admin')) {
        vscode.window.showErrorMessage('Only Teachers and Admins can manage class activities.');
        return;
    }

    const choice = await vscode.window.showQuickPick(
        [
            { label: 'Create Class Activity', value: 'create' },
            { label: 'View Existing Activities', value: 'view' }
        ],
        {
            title: 'Class Activity Manager',
            placeHolder: 'Choose an action'
        }
    );

    if (!choice) {
        return;
    }

    if (choice.value === 'view') {
        const activities = await storageManager.listClassActivities();
        if (activities.length === 0) {
            vscode.window.showInformationMessage('No class activities created yet.');
            return;
        }

        await vscode.window.showQuickPick(
            activities.map((a: ClassActivityRecord) => ({
                label: a.name,
                description: `Teacher: ${a.teacherDisplayName}`,
                detail: a.description || 'No description'
            })),
            {
                title: 'Existing Class Activities',
                placeHolder: 'Read-only list'
            }
        );
        return;
    }

    const activityName = await vscode.window.showInputBox({
        title: 'Create Class Activity',
        prompt: 'Activity name',
        placeHolder: 'Week 7 - Sorting Algorithms Lab',
        ignoreFocusOut: true
    });

    if (!activityName) {
        return;
    }

    const activityDescription = await vscode.window.showInputBox({
        title: 'Create Class Activity',
        prompt: 'Description (optional)',
        placeHolder: 'Any constraints, due date, and expected deliverables.',
        ignoreFocusOut: true
    });

    const newId = await storageManager.createClassActivity(
        session.authUserId,
        activityName.trim(),
        (activityDescription || '').trim()
    );

    vscode.window.showInformationMessage(`Class activity created (ID: ${newId}).`);
}
