import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface AccountViewData {
    displayName: string;
    role: string;
    provider: string;
    email: string;
    ideUser: string;
    workspaceName: string;
}

export function getAccountHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    accountData: AccountViewData
): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'src', 'auth', 'account', 'static', 'account.js')
    );

    const viewHtml = fs.readFileSync(path.join(context.asAbsolutePath('src/auth/account/views'), 'account.html'), 'utf8');
    const escapedData = JSON.stringify(accountData)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} https: 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TBD Logger — Account</title>
  <style>
    :root {
      --bg: #f0f4f8;
      --surface: #ffffff;
      --muted: #6b7280;
      --fg: #111827;
      --border: rgba(0,0,0,0.1);
      --accent: #2563eb;
      --error: #dc2626;
      --success: #16a34a;
    }
    .dark, :root.dark {
      --bg: #071021;
      --surface: #0b1220;
      --muted: #9aa4b2;
      --fg: #e6eef8;
      --border: rgba(255,255,255,0.08);
      --accent: #3b82f6;
      --error: #f87171;
      --success: #4ade80;
    }

    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      min-height: 100vh;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .top-theme-btn {
      position: fixed;
      top: 16px;
      right: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 1.1rem;
      color: var(--fg);
      line-height: 1;
    }

    .account-container { width: 100%; max-width: 680px; }
    .account-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 30px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.14);
    }

    .account-header { text-align: center; margin-bottom: 24px; }
    .account-logo { font-size: 2.2rem; margin-bottom: 6px; }
    .account-title { margin: 0 0 4px; font-size: 1.5rem; }
    .account-subtitle { margin: 0; color: var(--muted); font-size: 0.92rem; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.88rem; }

    input[type="text"] {
      width: 100%;
      min-height: 42px;
      border-radius: 10px;
      border: 1.5px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      padding: 9px 12px;
      font-size: 0.95rem;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(37,99,235,0.12);
    }
    input[readonly] {
      opacity: 0.9;
      cursor: not-allowed;
      background: color-mix(in srgb, var(--bg) 75%, var(--surface) 25%);
    }

    .actions { margin-top: 6px; display: flex; justify-content: flex-end; }
    .btn-primary {
      border: none;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      padding: 11px 16px;
      min-width: 170px;
    }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

    .account-error, .account-success {
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 0.9rem;
      margin-top: 2px;
      margin-bottom: 8px;
    }
    .account-error { background: rgba(220,38,38,0.1); color: var(--error); }
    .account-success { background: rgba(22,163,74,0.12); color: var(--success); }
    .hidden { display: none !important; }

    @media (max-width: 700px) {
      body { padding: 14px; align-items: stretch; }
      .account-card { padding: 20px; border-radius: 14px; }
      .grid-2 { grid-template-columns: 1fr; }
      .actions { justify-content: stretch; }
      .btn-primary { width: 100%; }
    }
  </style>
</head>
<body>
  ${viewHtml}
  <script nonce="${nonce}">
    window.__ACCOUNT_DATA__ = ${escapedData};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
