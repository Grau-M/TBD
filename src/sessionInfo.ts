import * as vscode from 'vscode';
import * as os from 'os';

export function getSessionInfo() {
    const userEnv = process.env.USER || process.env.USERNAME || '';
    let user = userEnv || '';
    try {
        if (!user) user = os.userInfo().username || '';
    } catch (e) {
        // ignore
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const project = (workspaceFolders && workspaceFolders.length > 0)
        ? workspaceFolders[0].name
        : '';

    return { user: user || 'unknown', project: project || 'unknown' };
}

export function printSessionInfo() {
    const info = getSessionInfo();
    console.log(`[TBD Logger] User: ${info.user}; Project: ${info.project}`);
    return info;
}

export default printSessionInfo;
