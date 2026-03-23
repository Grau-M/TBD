import * as vscode from 'vscode';
import { UserRole } from '../apiStorageManager';
import { WorkspaceAuthSession } from '../auth';
import { getAuthHtml } from './getHtml';
import { ApiHttpError } from '../api';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let authPanel: vscode.WebviewPanel | undefined;

function buildLocalSession(params: {
    role: UserRole;
    provider: 'microsoft' | 'google' | 'email';
    displayName: string;
    email: string;
}): WorkspaceAuthSession {
    return {
        authenticated: true,
        authUserId: -1,
        role: params.role,
        provider: params.provider,
        displayName: params.displayName,
        email: params.email
    };
}

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
    storageManager: any
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

                        let signedSession: WorkspaceAuthSession;
                        try {
                            const result = await storageManager.upsertAuthUser({
                                provider,
                                subjectId: oauthSession.account.id,
                                email: emailGuess,
                                displayName: accountName,
                                trackingConsent: false // Default to false for OAuth until they consent in dashboard
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

                            signedSession = {
                                authenticated: true,
                                authUserId: result.authUserId,
                                role: resolvedRole,
                                provider: provider as 'microsoft' | 'google',
                                displayName: accountName,
                                email: emailGuess,
                                trackingConsent: result.trackingConsent // Map the consent
                            };
                        } catch (error) {
                            throw error;
                        }

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
                        let session: WorkspaceAuthSession;
                        try {
                            const email = String(message.email || '').toLowerCase();
                            const password = String(message.password || '');
                            const user = await storageManager.authenticateEmailPassword(email, password);
                            if (!user) {
                                authPanel?.webview.postMessage({
                                    command: 'authError',
                                    form: 'signin',
                                    message: 'Invalid credentials. Please try again.'
                                });
                                return;
                            }

                            session = {
                                authenticated: true,
                                authUserId: user.authUserId,
                                role: user.role,
                                provider: 'email',
                                displayName: user.displayName,
                                email,
                                trackingConsent: user.trackingConsent // Map the consent
                            };
                        } catch (error) {
                            throw error;
                        }

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
                        const role = message.role as UserRole;
                        let session: WorkspaceAuthSession;
                        try {
                            const email = String(message.email || '').toLowerCase();
                            const password = String(message.password || '');
                            const displayName = String(message.displayName || '').trim();
                            
                            // EXTRACT CONSENT
                            const trackingConsent = Boolean(message.trackingConsent === true || message.trackingConsent === 'true');

                            const result = await storageManager.upsertAuthUser({
                                provider: 'email',
                                subjectId: email,
                                username: email,
                                email,
                                displayName,
                                password,
                                role,
                                trackingConsent // SEND TO DATABASE
                            });

                            if (!result.isNew) {
                                // Some backends may create the user but return isNew=false.
                                // Verify credentials and continue with sign-in when valid.
                                const existingUser = await storageManager.authenticateEmailPassword(email, password);
                                if (!existingUser) {
                                    authPanel?.webview.postMessage({
                                        command: 'authError',
                                        form: 'register',
                                        message: 'An account with that email already exists. Please sign in instead.'
                                    });
                                    return;
                                }

                                session = {
                                    authenticated: true,
                                    authUserId: existingUser.authUserId,
                                    role: existingUser.role,
                                    provider: 'email',
                                    displayName: existingUser.displayName || displayName,
                                    email,
                                    trackingConsent: existingUser.trackingConsent // MAP EXISTING
                                };
                            } else {
                                try {
                                    await storageManager.updateAuthUserRole(result.authUserId, role);
                                } catch (roleError) {
                                    // Keep registration successful even if role update fails.
                                    console.warn('Role update failed after registration:', roleError);
                                }

                                session = {
                                    authenticated: true,
                                    authUserId: result.authUserId,
                                    role,
                                    provider: 'email',
                                    displayName,
                                    email,
                                    trackingConsent: result.trackingConsent // MAP NEW
                                };
                            }
                        } catch (error) {
                            // If it's an API HTTP error (like 500), show the response body for debugging
                            if (error instanceof ApiHttpError) {
                                console.error('Registration API error:', {
                                    status: error.status,
                                    body: error.responseBody
                                });
                                throw error;
                            }
                            throw error;
                        }

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
                // If it's an API HTTP error (like 500), show the response body for debugging
                let errorMessage = String(e?.message || e);
                if (e instanceof ApiHttpError) {
                    errorMessage = `API Error ${e.status}: ${e.responseBody}`;
                    console.error('Auth API error:', { status: e.status, body: e.responseBody });
                }
                authPanel?.webview.postMessage({
                    command: 'authError',
                    form: message.command === 'register' ? 'register' : 'signin',
                    message: errorMessage
                });
            }
        }, undefined, context.subscriptions);
    });
}