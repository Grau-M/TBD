import * as vscode from 'vscode';
import { storageManager } from '../state';
import { getHtml } from './getHtml';
import { requireRoleAccess, getWorkspaceAuthSession } from '../auth';
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
  const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Teacher Dashboard');
  if (!allowed) {
    return;
  }

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

        case 'listClasses': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }
          const classes = await storageManager.listTeacherClasses(session.authUserId);
          panel?.webview.postMessage({ command: 'classList', data: classes });
          break;
        }

        case 'createClass': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }
          const newClass = await storageManager.createClass({
            teacherAuthUserId: session.authUserId,
            courseName: message.courseName,
            courseCode: message.courseCode,
            teacherName: message.teacherName,
            meetingTime: message.meetingTime,
            startDate: message.startDate,
            endDate: message.endDate
          });
          panel?.webview.postMessage({ command: 'classCreated', data: newClass });
          break;
        }

        case 'updateClass': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }
          await storageManager.updateClass({
            classId: Number(message.classId),
            teacherAuthUserId: session.authUserId,
            courseName: message.courseName,
            courseCode: message.courseCode,
            teacherName: message.teacherName,
            meetingTime: message.meetingTime,
            startDate: message.startDate,
            endDate: message.endDate
          });
          panel?.webview.postMessage({ command: 'classUpdated', data: { classId: Number(message.classId) } });
          break;
        }

        case 'openClass': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }

          const classId = Number(message.classId);
          const classInfo = await storageManager.getTeacherClassById(classId, session.authUserId);
          if (!classInfo) {
            panel?.webview.postMessage({ command: 'error', message: 'Class not found or access denied.' });
            break;
          }

          const students = await storageManager.listClassStudentsSummary(classId, session.authUserId);
          const assignments = await storageManager.listClassAssignments(classId, session.authUserId);

          panel?.webview.postMessage({
            command: 'classDetails',
            data: {
              classInfo,
              students,
              assignments
            }
          });
          break;
        }

        case 'createClassAssignment': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }

          const assignment = await storageManager.createClassAssignment({
            classId: Number(message.classId),
            teacherAuthUserId: session.authUserId,
            name: message.name,
            description: message.description || '',
            dueDate: message.dueDate || undefined
          });

          panel?.webview.postMessage({ command: 'classAssignmentCreated', data: assignment });
          break;
        }

        case 'openAssignmentWork': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }

          const classId = Number(message.classId);
          const assignmentId = Number(message.assignmentId);
          const classInfo = await storageManager.getTeacherClassById(classId, session.authUserId);
          if (!classInfo) {
            panel?.webview.postMessage({ command: 'error', message: 'Class not found or access denied.' });
            break;
          }

          const assignments = await storageManager.listClassAssignments(classId, session.authUserId);
          const assignment = assignments.find(a => a.id === assignmentId);
          if (!assignment) {
            panel?.webview.postMessage({ command: 'error', message: 'Assignment not found.' });
            break;
          }

          const students = await storageManager.listAssignmentStudentWork(classId, assignmentId, session.authUserId);
          panel?.webview.postMessage({
            command: 'assignmentWorkData',
            data: { classInfo, assignment, students }
          });
          break;
        }

        case 'openAssignmentStudent': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }

          const classId = Number(message.classId);
          const assignmentId = Number(message.assignmentId);
          const studentAuthUserId = Number(message.studentAuthUserId);

          const sessions = await storageManager.listAssignmentStudentSessions(
            classId,
            assignmentId,
            studentAuthUserId,
            session.authUserId
          );

          panel?.webview.postMessage({
            command: 'assignmentStudentSessions',
            data: {
              classId,
              assignmentId,
              studentAuthUserId,
              studentName: String(message.studentName || ''),
              sessions
            }
          });
          break;
        }

        case 'loadClassSessionLog': {
          const pwd = await ensurePassword(`Enter Administrator Password to view ${message.filename}`);
          if (!pwd) {
            panel?.webview.postMessage({ command: 'error', message: 'Password required' });
            break;
          }

          const all = await storageManager.listLogFiles();
          const target = all.find(f => f.label === String(message.filename || ''));
          if (!target) {
            panel?.webview.postMessage({ command: 'error', message: 'Session log not found.' });
            break;
          }

          const content = await storageManager.retrieveLogContentForUri(pwd, target.uri);
          panel?.webview.postMessage({
            command: 'classSessionLogData',
            data: {
              filename: target.label,
              text: content
            }
          });
          break;
        }
      }
    } catch (e: any) {
      panel?.webview.postMessage({ command: 'error', message: String(e.message || e) });
    }
  }, undefined, context.subscriptions);
}