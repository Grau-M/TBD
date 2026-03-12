import * as vscode from 'vscode';
import { DbStorageManager } from '../../dbStorageManager';
import { WorkspaceAuthSession } from '../../auth';
import { getAccountHtml } from './getHtml';

const WORKSPACE_AUTH_KEY = 'tbd.auth.workspaceSession.v1';

let accountPanel: vscode.WebviewPanel | undefined;

export async function openAccountView(
    context: vscode.ExtensionContext,
    storageManager: DbStorageManager,
    details: { ideUser: string; workspaceName: string }
): Promise<WorkspaceAuthSession | undefined> {
    const session = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
    if (!session?.authenticated) {
        vscode.window.showErrorMessage('You must be logged in to view account information.');
        return undefined;
    }

    if (accountPanel) {
        accountPanel.reveal(vscode.ViewColumn.One);
        return undefined;
    }

    return new Promise<WorkspaceAuthSession | undefined>((resolve) => {
        accountPanel = vscode.window.createWebviewPanel(
            'tbdAccountView',
            'TBD Logger — Account',
            { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(context.extensionPath)],
                retainContextWhenHidden: false
            }
        );

        accountPanel.webview.html = getAccountHtml(accountPanel.webview, context, {
            displayName: session.displayName,
            role: session.role,
            provider: session.provider,
            email: session.email,
            ideUser: details.ideUser,
            workspaceName: details.workspaceName
        });

        accountPanel.onDidDispose(() => {
            accountPanel = undefined;
            resolve(undefined);
        }, null, context.subscriptions);

        accountPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'saveAccount': {
                        const currentSession = context.workspaceState.get<WorkspaceAuthSession>(WORKSPACE_AUTH_KEY);
                        if (!currentSession?.authenticated) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Session expired. Please sign in again.' });
                            return;
                        }

                        const newDisplayName = String(message.displayName || '').trim();
                        if (!newDisplayName) {
                            accountPanel?.webview.postMessage({ command: 'accountError', message: 'Display name cannot be empty.' });
                            return;
                        }

                        await storageManager.updateAuthUserDisplayName(currentSession.authUserId, newDisplayName);
                        const updatedSession: WorkspaceAuthSession = {
                            ...currentSession,
                            displayName: newDisplayName
                        };
                        await context.workspaceState.update(WORKSPACE_AUTH_KEY, updatedSession);

                        accountPanel?.webview.postMessage({ command: 'accountSaved' });
                        resolve(updatedSession);
                        break;
                    }
                }
            } catch (e: any) {
                accountPanel?.webview.postMessage({
                    command: 'accountError',
                    message: String(e?.message || e)
                });
            }
        }, undefined, context.subscriptions);
    });
}
