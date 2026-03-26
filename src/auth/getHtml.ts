import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getThemePreference } from '../themePreference';

export function getAuthHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const nonce = getNonce();
  const themePreference = getThemePreference(context);
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
      --bg: var(--vscode-editor-background); 
      --surface: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); 
      --muted: var(--vscode-descriptionForeground); 
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.2)); 
      --accent: var(--vscode-button-background); 
      --accent-hover: var(--vscode-button-hoverBackground);
      --success: #16a34a; 
      --error: #dc2626;
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
      background:
        radial-gradient(circle at top left, rgba(59, 130, 246, 0.18), transparent 34%),
        radial-gradient(circle at bottom right, rgba(139, 92, 246, 0.16), transparent 30%),
        linear-gradient(180deg, color-mix(in srgb, var(--bg) 88%, #000 12%), var(--bg));
      color: var(--fg);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 28px 20px;
    }

    .auth-container {
      width: 100%;
      max-width: 460px;
    }

    .auth-card {
      position: relative;
      overflow: hidden;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--surface) 92%, white 8%),
        var(--surface)
      );
      border: 1px solid color-mix(in srgb, var(--border) 80%, white 20%);
      border-radius: 30px;
      padding: 46px 42px 38px;
      box-shadow:
        0 26px 70px rgba(0, 0, 0, 0.24),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(18px) saturate(140%);
      min-width: 0;
    }

    .auth-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 6px;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
    }

    .auth-card::after {
      content: "";
      position: absolute;
      inset: auto -20% -35% auto;
      width: 220px;
      height: 220px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.12), transparent 68%);
      pointer-events: none;
    }

    .auth-header {
      text-align: center;
      margin-bottom: 30px;
    }
    .auth-logo {
      font-size: 2.8rem;
      margin-bottom: 10px;
      display: block;
    }
    .auth-title {
      font-size: 1.8rem;
      font-weight: 800;
      color: var(--fg);
      margin: 0 0 6px;
      letter-spacing: -0.02em;
    }
    .auth-subtitle {
      color: var(--muted);
      font-size: 0.9rem;
      margin: 0;
    }

    .auth-tabs {
      display: flex;
      background: color-mix(in srgb, var(--bg) 82%, var(--surface) 18%);
      border-radius: 18px;
      padding: 6px;
      gap: 6px;
      margin-bottom: 26px;
      border: 1px solid color-mix(in srgb, var(--border) 70%, white 10%);
    }
    .auth-tab-btn {
      flex: 1;
      padding: 10px 12px;
      border: none;
      background: transparent;
      color: var(--muted);
      font-weight: 600;
      border-radius: 14px;
      cursor: pointer;
      transition: transform 0.18s ease, background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
      font-size: 0.95rem;
    }
    .auth-tab-btn.active {
      background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 84%, white 16%), var(--surface));
      color: var(--accent);
      box-shadow: 0 8px 18px rgba(0,0,0,0.16);
    }
    .auth-tab-btn:hover:not(.active) { color: var(--fg); transform: translateY(-1px); }

    .hidden { display: none !important; }

    .form-group { margin-bottom: 16px; }
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
    select,
    .custom-dropdown-trigger {
      width: 100%;
      padding: 12px 14px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--bg) 86%, white 14%);
      border: 1px solid color-mix(in srgb, var(--border) 78%, white 22%);
      color: var(--fg);
      font-size: 0.95rem;
      min-height: 48px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease, background 0.2s ease;
    }
    select {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      padding-right: 44px;
      cursor: pointer;
    }
    .custom-dropdown-trigger {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      font: inherit;
      text-align: left;
      line-height: 1.2;
      padding-right: 16px;
      user-select: none;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      background: color-mix(in srgb, var(--bg) 78%, white 22%);
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.16);
      transform: translateY(-1px);
    }
    .custom-dropdown-trigger:focus,
    .custom-dropdown-trigger:focus-visible {
      outline: none;
      border-color: var(--accent);
      background: color-mix(in srgb, var(--bg) 78%, white 22%);
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.16);
      transform: translateY(-1px);
    }

    .select-wrapper {
      position: relative;
    }

    .custom-dropdown {
      position: relative;
    }

    .custom-dropdown-trigger {
      width: 100%;
      min-height: 48px;
      padding: 12px 14px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--bg) 86%, white 14%);
      border: 1px solid color-mix(in srgb, var(--border) 78%, white 22%);
      color: var(--fg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease, background 0.2s ease;
      font-size: 0.95rem;
    }

    .custom-dropdown-trigger:hover {
      border-color: color-mix(in srgb, var(--accent) 65%, var(--border) 35%);
    }

    .custom-dropdown-trigger.open {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12);
    }

    #register-role-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .custom-dropdown-chevron {
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1;
      flex-shrink: 0;
      transition: transform 0.2s ease;
    }

    .custom-dropdown-trigger.open .custom-dropdown-chevron {
      transform: rotate(180deg);
    }

    .custom-dropdown-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 10px);
      z-index: 20;
      padding: 10px;
      border-radius: 18px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--surface) 92%, white 8%),
        var(--surface)
      );
      border: 1px solid color-mix(in srgb, var(--border) 75%, white 15%);
      box-shadow: 0 22px 42px rgba(0, 0, 0, 0.22);
      backdrop-filter: blur(18px) saturate(140%);
    }

    .custom-dropdown-option {
      width: 100%;
      border: none;
      background: transparent;
      color: var(--fg);
      text-align: left;
      padding: 12px 13px;
      border-radius: 13px;
      cursor: pointer;
      font-size: 0.95rem;
      transition: background 0.18s ease, transform 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
    }

    .custom-dropdown-option:hover,
    .custom-dropdown-option[aria-selected="true"] {
      background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent-hover) 70%, white 30%));
      color: white;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.12);
    }

    .custom-dropdown-option + .custom-dropdown-option {
      margin-top: 4px;
    }

    .password-wrapper { position: relative; }
    .password-wrapper input { padding-right: 48px; }
    .toggle-pw {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
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
      border-radius: 14px;
      padding: 10px 14px;
      font-size: 0.88rem;
      margin-bottom: 14px;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .auth-submit-btn {
      width: 100%;
      padding: 14px 16px;
      font-size: 1rem;
      font-weight: 700;
      border-radius: 16px;
      margin-top: 6px;
      border: none;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      color: white;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.15s ease, box-shadow 0.2s ease;
      letter-spacing: 0.01em;
      box-shadow: 0 12px 24px rgba(59, 130, 246, 0.22);
    }
    .auth-submit-btn:hover { opacity: 0.96; transform: translateY(-1px); }
    .auth-submit-btn:active { transform: scale(0.98); }
    .auth-submit-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    .oauth-buttons {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }
    .auth-oauth-btn {
      width: 100%;
      min-height: 44px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface) 88%, var(--bg) 12%);
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
      margin: 16px 0 18px;
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
      margin-top: 16px;
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
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .custom-modal {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .custom-modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(3, 7, 18, 0.58);
      backdrop-filter: blur(8px);
    }
    .custom-modal-card {
      position: relative;
      z-index: 1;
      width: min(100%, 460px);
      border-radius: 24px;
      padding: 24px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--surface) 96%, white 4%),
        var(--surface)
      );
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
      background: rgba(245, 158, 11, 0.14);
      color: #f59e0b;
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
      overflow-wrap: anywhere;
      word-break: break-word;
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
      box-shadow: 0 12px 24px rgba(59, 130, 246, 0.22);
    }
    .custom-modal-btn:hover { transform: translateY(-1px); }

    @media (max-width: 520px) {
      body {
        padding: 16px;
      }

      .auth-card {
        padding: 34px 22px 28px;
        border-radius: 24px;
      }

      .auth-title {
        font-size: 1.55rem;
      }

      .auth-tabs {
        gap: 4px;
        padding: 4px;
      }

      .auth-tab-btn {
        padding: 9px 10px;
        font-size: 0.92rem;
      }

      .auth-oauth-btn,
      .auth-submit-btn,
      .custom-modal-btn {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  ${loginHtml}
  <script nonce="${nonce}">window.__TBD_THEME_PREFERENCE__ = '${themePreference}';</script>
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
