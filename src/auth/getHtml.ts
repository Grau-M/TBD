import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function getAuthHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'src', 'auth', 'static', 'auth.js')
  );

  const viewsRoot = context.asAbsolutePath('src/auth/views');
  const loginHtml = fs.readFileSync(path.join(viewsRoot, 'login.html'), 'utf8');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} https: 'unsafe-inline';" />
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TBD Logger — Sign In</title>
  <style>
    :root {
      --bg: #f0f4f8;
      --surface: #ffffff;
      --muted: #6b7280;
      --fg: #111827;
      --border: rgba(0,0,0,0.1);
      --accent: #2563eb;
      --accent-2: #7c3aed;
      --error: #dc2626;
      --error-bg: rgba(220,38,38,0.08);
      --success: #16a34a;
      --success-bg: rgba(22,163,74,0.08);
    }
    .dark, :root.dark {
      --bg: #071021;
      --surface: #0b1220;
      --muted: #9aa4b2;
      --fg: #e6eef8;
      --border: rgba(255,255,255,0.08);
      --accent: #3b82f6;
      --accent-2: #8b5cf6;
      --error: #f87171;
      --error-bg: rgba(248,113,113,0.1);
      --success: #4ade80;
    }

    *, *::before, *::after { box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
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
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      line-height: 1;
    }
    .top-theme-btn:hover { opacity: 0.85; }

    .auth-container {
      width: 100%;
      max-width: 460px;
    }

    .auth-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 44px 40px 36px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.14);
    }

    .auth-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .auth-logo {
      font-size: 2.8rem;
      margin-bottom: 10px;
      display: block;
    }
    .auth-title {
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--fg);
      margin: 0 0 4px;
    }
    .auth-subtitle {
      color: var(--muted);
      font-size: 0.9rem;
      margin: 0;
    }

    .auth-tabs {
      display: flex;
      background: var(--bg);
      border-radius: 12px;
      padding: 4px;
      gap: 4px;
      margin-bottom: 28px;
      border: 1px solid var(--border);
    }
    .auth-tab-btn {
      flex: 1;
      padding: 9px;
      border: none;
      background: transparent;
      color: var(--muted);
      font-weight: 600;
      border-radius: 9px;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 0.95rem;
    }
    .auth-tab-btn.active {
      background: var(--surface);
      color: var(--accent);
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
    }
    .auth-tab-btn:hover:not(.active) { color: var(--fg); }

    .hidden { display: none !important; }

    .form-group { margin-bottom: 18px; }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
      font-size: 0.9rem;
      color: var(--muted);
    }
    .muted-label {
      font-weight: 400;
      font-size: 0.8rem;
      opacity: 0.85;
    }

    input[type="text"],
    input[type="password"],
    input[type="email"],
    select {
      width: 100%;
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--bg);
      border: 1.5px solid var(--border);
      color: var(--fg);
      font-size: 0.95rem;
      min-height: 44px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(37,99,235,0.12);
    }

    .password-wrapper { position: relative; }
    .password-wrapper input { padding-right: 48px; }
    .toggle-pw {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      color: var(--muted);
      padding: 4px;
      line-height: 1;
    }
    .toggle-pw:hover { opacity: 0.7; }

    .auth-error {
      background: var(--error-bg);
      color: var(--error);
      border: 1px solid rgba(220,38,38,0.2);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.88rem;
      margin-bottom: 14px;
      line-height: 1.45;
    }

    .auth-submit-btn {
      width: 100%;
      padding: 13px;
      font-size: 1rem;
      font-weight: 700;
      border-radius: 10px;
      margin-top: 4px;
      border: none;
      background: var(--accent);
      color: white;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.1s;
      letter-spacing: 0.01em;
    }
    .auth-submit-btn:hover { opacity: 0.9; }
    .auth-submit-btn:active { transform: scale(0.98); }
    .auth-submit-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    .oauth-buttons {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }
    .auth-oauth-btn {
      width: 100%;
      min-height: 42px;
      border-radius: 10px;
      border: 1.5px solid var(--border);
      background: var(--surface);
      color: var(--fg);
      font-size: 0.94rem;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s, transform 0.1s;
    }
    .auth-oauth-btn:hover {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--surface) 80%, var(--bg) 20%);
    }
    .auth-oauth-btn:active { transform: scale(0.98); }
    .auth-oauth-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    .auth-divider {
      position: relative;
      text-align: center;
      margin: 14px 0 16px;
      color: var(--muted);
      font-size: 0.85rem;
    }
    .auth-divider::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      border-top: 1px solid var(--border);
      transform: translateY(-50%);
    }
    .auth-divider span {
      position: relative;
      background: var(--surface);
      padding: 0 8px;
    }

    .auth-switch-hint {
      text-align: center;
      margin-top: 18px;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .link-btn {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-weight: 600;
      padding: 0;
      font-size: inherit;
    }
    .link-btn:hover { text-decoration: underline; }

    .auth-success {
      text-align: center;
      padding: 28px 0 12px;
    }
    .auth-success-icon {
      font-size: 3.5rem;
      color: var(--success);
      margin-bottom: 14px;
      display: block;
    }
    .auth-success h2 {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 10px;
    }
    .auth-success-sub {
      color: var(--muted);
      font-size: 0.9rem;
      margin: 0;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  ${loginHtml}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
  return text;
}
