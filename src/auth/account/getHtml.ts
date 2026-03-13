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
    canViewClasses: boolean;
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
      --bg: #eef2f6;
      --surface: #ffffff;
      --surface-strong: #f7fafc;
      --muted: #5b6472;
      --fg: #0f172a;
      --border: rgba(15,23,42,0.1);
      --accent: #0f766e;
      --accent-soft: rgba(15,118,110,0.12);
      --error: #dc2626;
      --success: #16a34a;
      --shadow: 0 20px 60px rgba(15, 23, 42, 0.12);
    }
    .dark, :root.dark {
      --bg: #08131f;
      --surface: #0f1b2d;
      --surface-strong: #13233a;
      --muted: #96a3b8;
      --fg: #e7edf6;
      --border: rgba(255,255,255,0.08);
      --accent: #38b2ac;
      --accent-soft: rgba(56,178,172,0.16);
      --error: #f87171;
      --success: #4ade80;
      --shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
    }

    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.18), transparent 34%),
        linear-gradient(160deg, var(--bg), color-mix(in srgb, var(--bg) 82%, var(--surface) 18%));
      color: var(--fg);
      font-family: 'Segoe UI', 'Aptos', sans-serif;
    }

    .top-theme-btn {
      background: var(--surface-strong);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 1.1rem;
      color: var(--fg);
      line-height: 1;
    }

    .account-container {
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
    }
    .dashboard-shell {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }

    .dashboard-sidebar,
    .account-card,
    .classes-shell,
    .class-detail-card,
    .class-list-card,
    .assignment-card {
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
    }

    .dashboard-sidebar {
      position: sticky;
      top: 24px;
      border-radius: 24px;
      padding: 24px;
      overflow: hidden;
    }

    .sidebar-brand {
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }

    .sidebar-eyebrow {
      margin: 0 0 8px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.75rem;
      color: var(--muted);
    }

    .sidebar-title {
      margin: 0;
      font-size: 1.7rem;
      line-height: 1.05;
    }

    .sidebar-copy {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .sidebar-nav {
      display: grid;
      gap: 10px;
    }

    .sidebar-nav-btn {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface-strong);
      color: var(--fg);
      padding: 14px 16px;
      text-align: left;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }

    .sidebar-nav-btn strong,
    .class-list-btn strong,
    .assignment-card-title {
      display: block;
      font-size: 1rem;
    }

    .sidebar-nav-btn span,
    .class-list-btn span,
    .assignment-card-copy,
    .page-subtitle,
    .class-detail-meta,
    .assignment-meta {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.45;
    }

    .sidebar-nav-btn:hover,
    .class-list-btn:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--accent) 45%, var(--border) 55%);
    }

    .sidebar-nav-btn.active,
    .class-list-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .sidebar-meta {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      display: grid;
      gap: 10px;
    }

    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: fit-content;
      border-radius: 999px;
      background: var(--surface-strong);
      border: 1px solid var(--border);
      padding: 8px 12px;
      color: var(--muted);
      font-size: 0.84rem;
    }

    .dashboard-main {
      min-width: 0;
    }

    .dashboard-view.hidden,
    .hidden {
      display: none !important;
    }

    .account-card,
    .classes-shell {
      border-radius: 26px;
      padding: 30px;
    }

    .account-header,
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 24px;
    }
    .account-logo {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      background: var(--accent-soft);
      font-size: 1.6rem;
    }
    .account-title, .page-title { margin: 0 0 6px; font-size: 1.85rem; }
    .account-subtitle { margin: 0; color: var(--muted); font-size: 0.95rem; line-height: 1.5; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.88rem; }

    input[type="text"] {
      width: 100%;
      min-height: 42px;
      border-radius: 14px;
      border: 1.5px solid var(--border);
      background: var(--surface-strong);
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
      cursor: default;
      background: color-mix(in srgb, var(--surface-strong) 85%, var(--surface) 15%);
    }

    .actions { margin-top: 6px; display: flex; justify-content: flex-end; }
    .btn-primary {
      border: none;
      border-radius: 14px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      padding: 12px 18px;
      min-width: 170px;
    }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

    .btn-secondary {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface-strong);
      color: var(--fg);
      font-weight: 700;
      cursor: pointer;
      padding: 12px 18px;
      min-width: 160px;
    }
    .btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }

    .classes-layout {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      gap: 18px;
      min-height: 420px;
    }

    .class-list-card,
    .class-detail-card {
      border-radius: 20px;
      padding: 20px;
    }

    .class-list {
      display: grid;
      gap: 12px;
    }

    .class-list-btn {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--surface-strong);
      color: var(--fg);
      padding: 16px;
      text-align: left;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }

    .class-list-label-row,
    .assignment-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .pill,
    .assignment-status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      border: 1px solid transparent;
    }

    .pill {
      background: color-mix(in srgb, var(--accent) 12%, var(--surface) 88%);
      color: var(--accent);
    }

    .assignment-status.started {
      background: rgba(22,163,74,0.12);
      color: var(--success);
      border-color: rgba(22,163,74,0.18);
    }

    .assignment-status.not-started {
      background: rgba(245,158,11,0.12);
      color: #b45309;
      border-color: rgba(245,158,11,0.2);
    }

    .assignment-list {
      display: grid;
      gap: 14px;
      margin-top: 20px;
    }

    .assignment-card {
      border-radius: 18px;
      padding: 18px;
    }

    .assignment-card-copy {
      margin-top: 10px;
    }

    .assignment-meta {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .empty-state,
    .detail-placeholder,
    .loading-state {
      border: 1px dashed var(--border);
      border-radius: 18px;
      padding: 22px;
      background: var(--surface-strong);
      color: var(--muted);
      line-height: 1.6;
    }

    .account-error, .account-success {
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 0.9rem;
      margin-top: 2px;
      margin-bottom: 8px;
    }
    .account-error { background: rgba(220,38,38,0.1); color: var(--error); }
    .account-success { background: rgba(22,163,74,0.12); color: var(--success); }
    @media (max-width: 980px) {
      .dashboard-shell,
      .classes-layout {
        grid-template-columns: 1fr;
      }

      .dashboard-sidebar {
        position: static;
      }
    }

    @media (max-width: 700px) {
      body { padding: 14px; }
      .account-card,
      .classes-shell,
      .dashboard-sidebar,
      .class-list-card,
      .class-detail-card { padding: 20px; border-radius: 18px; }
      .grid-2 { grid-template-columns: 1fr; }
      .actions { justify-content: stretch; }
      .btn-primary { width: 100%; }
      .account-header,
      .page-header { flex-direction: column; }
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
