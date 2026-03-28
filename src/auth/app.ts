import * as vscode from 'vscode';
import { UserRole } from '../apiStorageManager';
import { WorkspaceAuthSession } from '../auth';
import { getAuthHtml } from './getHtml';
import { ApiHttpError } from '../api';
import { getThemePreference } from '../themePreference';
import { getUserFriendlyErrorMessage } from '../utils';
import { registerWebviewPanel } from '../webviewRegistry';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let authPanel: vscode.WebviewPanel | undefined;
let logoutConfirmPanel: vscode.WebviewPanel | undefined;
let openingAuthPanel = false;
let openingLogoutConfirmPanel = false;

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
        { label: 'Teacher', description: 'Access teacher dashboard and class management' }
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

    if (openingAuthPanel) {
        return undefined;
    }

    openingAuthPanel = true;

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

        registerWebviewPanel(authPanel);

        authPanel.webview.html = getAuthHtml(authPanel.webview, context);

        // Panel closed without completing auth
        authPanel.onDidDispose(() => {
            authPanel = undefined;
            openingAuthPanel = false;
            resolve(undefined);
        }, null, context.subscriptions);

        openingAuthPanel = false;

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
                let errorMessage = getUserFriendlyErrorMessage(e, 'Authentication failed. Please try again.');

                if (e instanceof ApiHttpError) {
                    console.error('Auth API error:', { status: e.status, body: e.responseBody });

                    if (message.command === 'register' && e.status === 409) {
                        errorMessage = 'An account with that email already exists. Please sign in instead.';
                    }
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

export async function openLogoutConfirmView(
        context: vscode.ExtensionContext,
        details: { displayName: string; role: string }
): Promise<boolean> {
        if (logoutConfirmPanel) {
                logoutConfirmPanel.reveal(vscode.ViewColumn.One);
                return false;
        }

    if (openingLogoutConfirmPanel) {
        return false;
    }

    openingLogoutConfirmPanel = true;

        return new Promise<boolean>((resolve) => {
                let settled = false;

                const finish = (confirmed: boolean) => {
                        if (settled) {
                                return;
                        }
                        settled = true;
                        resolve(confirmed);
                        logoutConfirmPanel?.dispose();
                };

                const themePreference = getThemePreference(context);
                const panel = vscode.window.createWebviewPanel(
                        'tbdLogoutConfirmView',
                        'TBD Logger — Log Out',
                        { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
                        {
                                enableScripts: true,
                                localResourceRoots: [vscode.Uri.file(context.extensionPath)],
                                retainContextWhenHidden: false
                        }
                );

                logoutConfirmPanel = panel;
                registerWebviewPanel(panel);

                const nonce = getNonce();
                const payload = JSON.stringify({
                        displayName: details.displayName,
                        role: details.role,
                        themePreference
                }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

                panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} https:; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} https: 'unsafe-inline';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TBD Logger — Log Out</title>
    <style>
        :root {
            --bg: #eef2f6;
            --surface: #ffffff;
            --muted: #5b6472;
            --fg: #0f172a;
            --border: rgba(15,23,42,0.1);
            --accent: #0f766e;
            --accent-hover: #115e59;
        }
        .dark, :root.dark {
            --bg: #08131f;
            --surface: #0f1b2d;
            --muted: #96a3b8;
            --fg: #e7edf6;
            --border: rgba(255,255,255,0.08);
            --accent: #38b2ac;
            --accent-hover: #2c948f;
        }
        *, *::before, *::after { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background:
                radial-gradient(circle at top left, rgba(15,118,110,0.18), transparent 34%),
                linear-gradient(160deg, var(--bg), color-mix(in srgb, var(--bg) 82%, var(--surface) 18%));
            color: var(--fg);
            font-family: 'Segoe UI', 'Aptos', sans-serif;
        }
        .custom-modal-card {
            width: min(100%, 460px);
            border-radius: 24px;
            padding: 24px;
            background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, white 4%), var(--surface));
            border: 1px solid color-mix(in srgb, var(--border) 82%, white 18%);
            box-shadow: 0 24px 72px rgba(0, 0, 0, 0.36);
        }
        .custom-modal-icon {
            width: 44px;
            height: 44px;
            border-radius: 14px;
            display: grid;
            place-items: center;
            margin-bottom: 14px;
            background: rgba(239, 68, 68, 0.14);
            color: #ef4444;
            font-size: 1.2rem;
            font-weight: 800;
        }
        .custom-modal-copy h3 {
            margin: 0 0 8px;
            font-size: 1.1rem;
            color: var(--fg);
        }
        .custom-modal-copy p {
            margin: 0;
            color: var(--muted);
            line-height: 1.55;
            font-size: 0.94rem;
        }
        .custom-modal-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 22px;
        }
        .custom-modal-btn {
            min-height: 42px;
            padding: 0 16px;
            border-radius: 14px;
            border: 1px solid transparent;
            font-weight: 700;
            cursor: pointer;
            transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .custom-modal-btn.secondary {
            background: color-mix(in srgb, var(--bg) 82%, var(--surface) 18%);
            color: var(--fg);
            border-color: color-mix(in srgb, var(--border) 72%, white 28%);
        }
        .custom-modal-btn.primary {
            background: linear-gradient(135deg, var(--accent), var(--accent-hover));
            color: #fff;
            box-shadow: 0 12px 24px rgba(56, 178, 172, 0.22);
        }
        .custom-modal-btn:hover { transform: translateY(-1px); }
    </style>
</head>
<body>
    <div class="custom-modal-card" role="dialog" aria-modal="true" aria-labelledby="logout-title" aria-describedby="logout-message">
        <div class="custom-modal-icon" aria-hidden="true">!</div>
        <div class="custom-modal-copy">
            <h3 id="logout-title">Log out of TBD Logger?</h3>
            <p id="logout-message"></p>
        </div>
        <div class="custom-modal-actions">
            <button type="button" class="custom-modal-btn secondary" id="logout-cancel">Cancel</button>
            <button type="button" class="custom-modal-btn primary" id="logout-confirm">Log Out</button>
        </div>
    </div>
    <script nonce="${nonce}">
        const logoutData = ${payload};
        const vscode = acquireVsCodeApi();
        if (logoutData.themePreference === 'dark' || (logoutData.themePreference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.body.classList.add('dark');
        }
        const message = document.getElementById('logout-message');
        const cancelBtn = document.getElementById('logout-cancel');
        const confirmBtn = document.getElementById('logout-confirm');

        if (message) {
            message.textContent = 'Are you sure you want to log out? (' + logoutData.displayName + ' - ' + logoutData.role + ')';
        }

        function resolve(confirmed) {
            vscode.postMessage({ command: confirmed ? 'confirmLogout' : 'cancelLogout' });
        }

        cancelBtn?.addEventListener('click', () => resolve(false));
        confirmBtn?.addEventListener('click', () => resolve(true));
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                resolve(false);
            }
            if (event.key === 'Enter') {
                resolve(true);
            }
        });
    </script>
</body>
</html>`;

                panel.onDidDispose(() => {
                        logoutConfirmPanel = undefined;
            openingLogoutConfirmPanel = false;
                        finish(false);
                }, null, context.subscriptions);

        openingLogoutConfirmPanel = false;

                panel.webview.onDidReceiveMessage((message) => {
                        if (message.command === 'confirmLogout') {
                                finish(true);
                        } else if (message.command === 'cancelLogout') {
                                finish(false);
                        }
                }, undefined, context.subscriptions);
        });
}

function getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
                text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
}