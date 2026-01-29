// Module: sessionInfo.ts
// Purpose: Provide utilities to determine the current session identity
// (user and project). Exposes `getSessionInfo` for programmatic use and
// `printSessionInfo` which logs and returns the session info for diagnostics.
import * as vscode from 'vscode';
import * as os from 'os';

// Function: getSessionInfo
// Purpose: Return a small object identifying the current session: the
// current OS user and the first workspace folder name (project). Used to
// construct per-session filenames and metadata.
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

// Function: printSessionInfo
// Purpose: Convenience wrapper that logs session info to the console and
// returns the same object. Useful for diagnostics during activation.
export function printSessionInfo() {
    const info = getSessionInfo();
    console.log(`[TBD Logger] User: ${info.user}; Project: ${info.project}`);
    return info;
}

export default printSessionInfo;
