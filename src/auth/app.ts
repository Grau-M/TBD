import * as vscode from 'vscode';
import { DbStorageManager, UserRole } from '../dbStorageManager';
import { WorkspaceAuthSession } from '../auth';
import { getAuthHtml } from './getHtml';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let authPanel: vscode.WebviewPanel | undefined;

async function pickRoleForNewUser(): Promise<UserRole | undefined> {
    const selected = await vscode.window.showQuickPick([
        { label: 'Student', description: 'Link workspace to class assignments' },
        { label: 'Teacher', description: 'Access teacher dashboard and class management' },
        { label: 'Admin', description: 'Full system management access' }
    ], {
        title: 'Select your role for this account',
        placeHolder: 'Choose your role (first-time setup)'
    });
    return selected?.label as UserRole | undefined;
}

/**
 * Opens the dedicated login/register GUI webview.
 * Returns a Promise that resolves with the new session when the user
 * successfully authenticates, or undefined if they close the panel.
 */
export async function openAuthView(
    context: vscode.ExtensionContext,
    storageManager: DbStorageManager
): Promise<WorkspaceAuthSession | undefined> {
    // If the panel is already open, just reveal it and wait for its resolution.
    if (authPanel) {
        authPanel.reveal(vscode.ViewColumn.One);
        return undefined;
    }

    return new Promise<WorkspaceAuthSession | undefined>((resolve) => {
        authPanel = vscode.window.createWebviewPanel(
            'tbdAuthView',
            'TBD Logger — Sign In',
            { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(context.extensionPath)],
                retainContextWhenHidden: false
            }
        );

        authPanel.webview.html = getAuthHtml(authPanel.webview, context);

        // Panel closed without completing auth
        authPanel.onDidDispose(() => {
            authPanel = undefined;
            resolve(undefined);
        }, null, context.subscriptions);

        authPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'oauthSignIn': {
                        const provider = String(message.provider || '').toLowerCase();
                        if (provider !== 'microsoft' && provider !== 'google') {
                            authPanel?.webview.postMessage({
                                command: 'authError',
                                form: 'signin',
                                message: 'Unsupported sign-in provider.'
                            });
                            return;
                        }

                        const scopes = provider === 'microsoft'
                            ? ['User.Read']
                            : ['openid', 'profile', 'email'];
                        const oauthSession = await vscode.authentication.getSession(provider, scopes, { createIfNone: true });
                        if (!oauthSession) {
                            authPanel?.webview.postMessage({
                                command: 'authError',
                                form: 'signin',
                                message: 'Sign-in was cancelled.'
                            });
                            return;
                        }

                        const accountName = oauthSession.account.label || `${provider} user`;
                        const emailGuess = accountName.includes('@')
                            ? accountName.toLowerCase()
                            : `${oauthSession.account.id}@${provider}.local`;

                        const result = await storageManager.upsertAuthUser({
                            provider,
                            subjectId: oauthSession.account.id,
                            email: emailGuess,
                            displayName: accountName
                        });

                        let resolvedRole = result.role;
                        if (result.isNew) {
                            const chosenRole = await pickRoleForNewUser();
                            if (!chosenRole) {
                                authPanel?.webview.postMessage({
                                    command: 'authError',
                                    form: 'signin',
                                    message: 'Role assignment was cancelled.'
                                });
                                return;
                            }
                            resolvedRole = chosenRole;
                            await storageManager.updateAuthUserRole(result.authUserId, chosenRole);
                        }

                        const signedSession: WorkspaceAuthSession = {
                            authenticated: true,
                            authUserId: result.authUserId,
                            role: resolvedRole,
                            provider: provider as 'microsoft' | 'google',
                            displayName: accountName,
                            email: emailGuess
                        };

                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, signedSession);
                        authPanel?.webview.postMessage({
                            command: 'authSuccess',
                            displayName: signedSession.displayName,
                            role: signedSession.role
                        });

                        const panel = authPanel;
                        setTimeout(() => { panel?.dispose(); }, 1500);
                        resolve(signedSession);
                        break;
                    }

                    case 'signIn': {
                        const user = await storageManager.findAuthUserByEmail(message.email as string);
                        if (!user) {
                            authPanel?.webview.postMessage({
                                command: 'authError',
                                form: 'signin',
                                message: 'No account found with that email. Please register first.'
                            });
                            return;
                        }

                        const session: WorkspaceAuthSession = {
                            authenticated: true,
                            authUserId: user.authUserId,
                            role: user.role,
                            provider: 'email',
                            displayName: user.displayName,
                            email: message.email as string
                        };
                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
                        authPanel?.webview.postMessage({
                            command: 'authSuccess',
                            displayName: session.displayName,
                            role: session.role
                        });

                        // Close the panel after a short moment so user sees the success state
                        const panel = authPanel;
                        setTimeout(() => { panel?.dispose(); }, 1500);
                        resolve(session);
                        break;
                    }

                    case 'register': {
                        const result = await storageManager.upsertAuthUser({
                            provider: 'email',
                            subjectId: (message.email as string).toLowerCase(),
                            email: (message.email as string).toLowerCase(),
                            displayName: message.displayName as string
                        });

                        if (!result.isNew) {
                            authPanel?.webview.postMessage({
                                command: 'authError',
                                form: 'register',
                                message: 'An account with that email already exists. Please sign in instead.'
                            });
                            return;
                        }

                        const role = message.role as UserRole;
                        await storageManager.updateAuthUserRole(result.authUserId, role);

                        const session: WorkspaceAuthSession = {
                            authenticated: true,
                            authUserId: result.authUserId,
                            role,
                            provider: 'email',
                            displayName: message.displayName as string,
                            email: (message.email as string).toLowerCase()
                        };
                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, session);
                        authPanel?.webview.postMessage({
                            command: 'authSuccess',
                            displayName: session.displayName,
                            role: session.role
                        });

                        const panel = authPanel;
                        setTimeout(() => { panel?.dispose(); }, 1500);
                        resolve(session);
                        break;
                    }
                }
            } catch (e: any) {
                authPanel?.webview.postMessage({
                    command: 'authError',
                    form: message.command === 'register' ? 'register' : 'signin',
                    message: String(e?.message || e)
                });
            }
        }, undefined, context.subscriptions);
    });
}
