import * as vscode from 'vscode';
import { storageManager } from '../state';
import { getHtml } from './getHtml';
import { requireRoleAccess, getWorkspaceAuthSession } from '../auth';
import { handleAnalyzeLogs, handleCompareAssignmentStudents, handleGenerateProfile, handleGenerateTimeline } from './services/dashboardService';
import {
  handleOpenLog,
  handleExportLog,
  handleGetDeletions,
  handleSaveLogNotes,
  handleLoadLogNotes,
  handleGenerateStudentSummary
} from './services/fileService';

const SECRET_PASSPHRASE = 'password';

let panel: vscode.WebviewPanel | undefined;

export async function openTeacherView(context: vscode.ExtensionContext) {
  const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Teacher Dashboard');
  if (!allowed) {
    return;
  }

  try {
    const recentAlerts = await storageManager.listRecentUnmonitoredWorkAlerts(5);
    if (recentAlerts.length > 0) {
      const latest = recentAlerts[0];
      vscode.window.showWarningMessage(
        `Monitoring alert: ${recentAlerts.length} unmonitored work record(s). Latest: ${latest.ideUser} in ${latest.workspaceName} at ${latest.observedAt}.`
      );
    }
  } catch {
    // Non-blocking: dashboard can still open when alert query is unavailable.
  }

  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'tbdTeacherView',
    'Teacher Dashboard',
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(context.extensionPath)] }
  );

  panel.webview.html = getHtml(panel.webview, context);

  panel.onDidDispose(() => {
    panel = undefined;
  }, null, context.subscriptions);

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
          if (panel) { await handleOpenLog(panel, SECRET_PASSPHRASE, message.filename); }
          break;
        }

        case 'exportLog': {
          if (panel) { await handleExportLog(panel, SECRET_PASSPHRASE, message.filename, message.format); }
          break;
        }

        case 'analyzeLogs': {
          if (panel) { await handleAnalyzeLogs(panel, SECRET_PASSPHRASE, context); }
          break;
        }

        case 'generateProfile': {
          if (panel) { await handleGenerateProfile(panel, SECRET_PASSPHRASE, message.filenames); }
          break;
        }

        case 'generateTimeline': {
          if (panel) { await handleGenerateTimeline(panel, SECRET_PASSPHRASE, message.filenames, context); }
          break;
        }

        case 'getDeletions': {
          if (panel) { await handleGetDeletions(panel, SECRET_PASSPHRASE); }
          break;
        }

        case 'loadLogNotes': {
          if (panel) { await handleLoadLogNotes(panel, SECRET_PASSPHRASE, message.filename); }
          break;
        }

        case 'saveLogNotes': {
          if (panel) { await handleSaveLogNotes(panel, SECRET_PASSPHRASE, message.filename, message.notes); }
          break;
        }

        case 'generateStudentSummary': {
          if (panel) { await handleGenerateStudentSummary(panel, SECRET_PASSPHRASE, message.filename); }
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

        case 'compareAssignmentStudents': {
          const session = getWorkspaceAuthSession(context);
          if (!session?.authenticated) {
            panel?.webview.postMessage({ command: 'error', message: 'Not authenticated.' });
            break;
          }

          const classId = Number(message.classId);
          const assignmentId = Number(message.assignmentId);
          const requestedStudents = Array.isArray(message.students) ? message.students.slice(0, 2) : [];
          if (requestedStudents.length < 2) {
            panel?.webview.postMessage({ command: 'error', message: 'Select two students to compare.' });
            break;
          }

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

          const selections = [];
          for (const requested of requestedStudents) {
            const studentAuthUserId = Number(requested?.studentAuthUserId);
            if (!Number.isFinite(studentAuthUserId) || studentAuthUserId <= 0) {
              continue;
            }

            const sessions = await storageManager.listAssignmentStudentSessions(
              classId,
              assignmentId,
              studentAuthUserId,
              session.authUserId
            );

            // Compare mode prioritizes the most recent sessions to keep response time predictable.
            const limitedSessions = sessions.slice(0, 12);
            selections.push({
              studentAuthUserId,
              studentName: String(requested?.studentName || 'Student'),
              sessions: limitedSessions,
              totalSessionCount: sessions.length
            });
          }

          if (selections.length < 2) {
            panel?.webview.postMessage({ command: 'error', message: 'Two valid students are required for comparison.' });
            break;
          }

          if (panel) {
            await handleCompareAssignmentStudents(panel, SECRET_PASSPHRASE, selections, context);
          }
          break;
        }

        case 'loadClassSessionLog': {
          const all = await storageManager.listLogFiles();
          const target = all.find(f => f.label === String(message.filename || ''));
          if (!target) {
            panel?.webview.postMessage({ command: 'error', message: 'Session log not found.' });
            break;
          }

          const content = await storageManager.retrieveLogContentForUri(SECRET_PASSPHRASE, target.uri);
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