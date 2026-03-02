import * as vscode from 'vscode';
import { storageManager } from '../state';
import { getHtml } from './getHtml';
import { handleAnalyzeLogs, handleGenerateProfile, handleGenerateTimeline } from './services/dashboardService';
import {
  handleOpenLog,
  handleExportLog,
  handleGetDeletions,
  handleSaveLogNotes,
  handleLoadLogNotes,
  handleGenerateStudentSummary
} from './services/fileService';

let panel: vscode.WebviewPanel | undefined;
let sessionPassword: string | undefined;

export async function openTeacherView(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  const initialPassword = await vscode.window.showInputBox({
    prompt: `Enter Administrator Password to open Teacher Dashboard`,
    password: true,
    ignoreFocusOut: true
  });

  if (!initialPassword) { return; }
  sessionPassword = initialPassword;

  panel = vscode.window.createWebviewPanel(
    'tbdTeacherView',
    'Teacher Dashboard',
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(context.extensionPath)] }
  );

  panel.webview.html = getHtml(panel.webview, context);

  panel.onDidDispose(() => {
    panel = undefined;
    sessionPassword = undefined;
  }, null, context.subscriptions);

  // HELPER to prompt for password if session expires
  async function ensurePassword(promptMsg: string) {
    if (!sessionPassword) {
      const pwd = await vscode.window.showInputBox({
        prompt: promptMsg,
        password: true,
        ignoreFocusOut: true
      });
      if (pwd) { sessionPassword = pwd; }
    }
    return sessionPassword;
  }

  panel.webview.onDidReceiveMessage(async message => {
    try {
      switch (message.command) {
        case 'clientReady':
          break;

        case 'listLogs': {
          const files = await storageManager.listLogFiles();
          panel?.webview.postMessage({ command: 'logList', data: files.map(f => f.label) });
          break;
        }

        case 'openLog': {
          const pwd = await ensurePassword(`Enter Administrator Password to view ${message.filename}`);
          if (pwd && panel) { await handleOpenLog(panel, pwd, message.filename); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'exportLog': {
          const pwd = await ensurePassword(`Enter Admin Password to Export ${message.filename}`);
          if (pwd && panel) { await handleExportLog(panel, pwd, message.filename, message.format); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'analyzeLogs': {
          const pwd = await ensurePassword(`Enter Administrator Password to analyze all logs`);
          if (pwd && panel) { await handleAnalyzeLogs(panel, pwd, context); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'generateProfile': {
          const pwd = await ensurePassword(`Enter Administrator Password to Generate Profile`);
          if (pwd && panel) { await handleGenerateProfile(panel, pwd, message.filenames); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'generateTimeline': {
          const pwd = await ensurePassword(`Enter Administrator Password to Generate Timeline`);
          if (pwd && panel) { await handleGenerateTimeline(panel, pwd, message.filenames, context); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'getDeletions': {
          const pwd = await ensurePassword(`Enter Administrator Password to view deletion activity`);
          if (pwd && panel) { await handleGetDeletions(panel, pwd); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'loadLogNotes': {
          const pwd = await ensurePassword(`Enter Administrator Password to load notes for ${message.filename}`);
          if (pwd && panel) { await handleLoadLogNotes(panel, pwd, message.filename); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'saveLogNotes': {
          const pwd = await ensurePassword(`Enter Administrator Password to save notes for ${message.filename}`);
          if (pwd && panel) { await handleSaveLogNotes(panel, pwd, message.filename, message.notes); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        // ✅ NEW: Generate Student Transparency Summary
        case 'generateStudentSummary': {
          const pwd = await ensurePassword(
            `Enter Administrator Password to generate student summary for ${message.filename}`
          );
          if (pwd && panel) { await handleGenerateStudentSummary(panel, pwd, message.filename); }
          else { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); }
          break;
        }

        case 'getSettings': {
          const current = context.globalState.get('tbdSettings', {
            inactivityThreshold: 5,
            flightTimeThreshold: 50,
            pasteLengthThreshold: 50,
            flagAiEvents: true
          });
          panel?.webview.postMessage({ command: 'loadSettings', settings: current });
          break;
        }

        case 'saveSettings': {
          await context.globalState.update('tbdSettings', message.settings);
          panel?.webview.postMessage({ command: 'settingsSaved', success: true });
          break;
        }
      }
    } catch (e: any) {
      panel?.webview.postMessage({ command: 'error', message: String(e.message || e) });
    }
  }, undefined, context.subscriptions);
}