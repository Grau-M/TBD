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
import { registerWebviewPanel } from '../webviewRegistry';

const SECRET_PASSPHRASE = 'password';

let panel: vscode.WebviewPanel | undefined;
let openingPanel = false;

export async function openTeacherView(context: vscode.ExtensionContext) {
  const currentPanel = panel;
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  if (openingPanel) {
    return;
  }

  openingPanel = true;

  const allowed = await requireRoleAccess(context, ['Teacher', 'Admin'], 'Teacher Dashboard');
  if (!allowed) {
    openingPanel = false;
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

  const reopenedPanel = panel;
  if (reopenedPanel) {
    reopenedPanel.reveal(vscode.ViewColumn.One);
    openingPanel = false;
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'tbdTeacherView',
    'Teacher Dashboard',
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(context.extensionPath)] }
  );

  registerWebviewPanel(panel);

  panel.webview.html = getHtml(panel.webview, context);

  panel.onDidDispose(() => {
    panel = undefined;
    openingPanel = false;
  }, null, context.subscriptions);

  openingPanel = false;

  // Auto-Heals the connection if the cloud database was recently wiped or recreated
  const getValidTeacherId = async (): Promise<number> => {
    const session = getWorkspaceAuthSession(context) as any;
    if (!session?.authenticated) {
      throw new Error('Not authenticated. Please restart the extension and log in.');
    }

    const existingAuthUserId = Number(session.authUserId || 0);
    if (Number.isFinite(existingAuthUserId) && existingAuthUserId > 0) {
      return existingAuthUserId;
    }

    const authResult = await storageManager.upsertAuthUser({
      provider: session.provider || 'local-cache',
      subjectId: session.subjectId || session.email || 'teacher-sync',
      email: session.email || 'teacher@example.com',
      displayName: session.displayName || session.name || 'Teacher'
    });

    await storageManager.updateAuthUserRole(authResult.authUserId, 'Teacher');
    return authResult.authUserId; 
  };

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
          const teacherId = await getValidTeacherId();
          const classes = await storageManager.listTeacherClasses(teacherId);
          panel?.webview.postMessage({ command: 'classList', data: classes });
          break;
        }

        case 'createClass': {
          const teacherId = await getValidTeacherId();
          const newClass = await storageManager.createClass({
            teacherAuthUserId: teacherId, 
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
          const teacherId = await getValidTeacherId();
          const session = getWorkspaceAuthSession(context) as any;
          const fallbackTeacherName = String(session?.displayName || session?.name || '').trim();
          await storageManager.updateClass({
            classId: Number(message.classId),
            teacherAuthUserId: teacherId, 
            courseName: message.courseName,
            courseCode: message.courseCode,
            teacherName: String(message.teacherName || fallbackTeacherName),
            meetingTime: message.meetingTime,
            startDate: message.startDate,
            endDate: message.endDate
          });
          panel?.webview.postMessage({ command: 'classUpdated', data: { classId: Number(message.classId) } });
          break;
        }

        case 'getClassForEdit': {
          const teacherId = await getValidTeacherId();
          const classId = Number(message.classId);
          const classInfo = await storageManager.getTeacherClassById(classId, teacherId);
          if (!classInfo) {
            panel?.webview.postMessage({ command: 'error', message: 'Class not found or access denied.' });
            break;
          }
          panel?.webview.postMessage({ command: 'classEditData', data: classInfo });
          break;
        }

        case 'openClass': {
          const teacherId = await getValidTeacherId();
          const classId = Number(message.classId);
          
          const classInfo = await storageManager.getTeacherClassById(classId, teacherId);
          if (!classInfo) {
            panel?.webview.postMessage({ command: 'error', message: 'Class not found or access denied.' });
            break;
          }

          let students: any[] = [];
          let assignments: any[] = [];

          try {
            students = await storageManager.listClassStudentsSummary(classId, teacherId);
          } catch (error) {
            console.warn('Failed to load class students for openClass:', error);
          }

          try {
            assignments = await storageManager.listClassAssignments(classId, teacherId);
          } catch (error) {
            console.warn('Failed to load class assignments for openClass:', error);
          }

          panel?.webview.postMessage({
            command: 'classDetails',
            data: { classInfo, students, assignments }
          });
          break;
        }

        case 'createClassAssignment': {
          const teacherId = await getValidTeacherId();
          const assignment = await storageManager.createClassAssignment({
            classId: Number(message.classId),
            teacherAuthUserId: teacherId,
            name: message.name,
            description: message.description || '',
            dueDate: message.dueDate || undefined
          });

          panel?.webview.postMessage({ command: 'classAssignmentCreated', data: assignment });
          break;
        }

        case 'openAssignmentWork': {
          const teacherId = await getValidTeacherId();
          const classId = Number(message.classId);
          const assignmentId = Number(message.assignmentId);
          const focusStudentAuthUserId = Number(message.studentAuthUserId || 4);
          
          const classInfo = await storageManager.getTeacherClassById(classId, teacherId);
          if (!classInfo) {
            panel?.webview.postMessage({ command: 'error', message: 'Class not found or access denied.' });
            break;
          }

          const assignments = await storageManager.listClassAssignments(classId, teacherId);
          const assignment = assignments.find(a => a.id === assignmentId);
          if (!assignment) {
            panel?.webview.postMessage({ command: 'error', message: 'Assignment not found.' });
            break;
          }

          let classStudents: any[] = [];
          let students: any[] = [];
          try {
            classStudents = await storageManager.listClassStudentsSummary(classId, teacherId);
          } catch (error) {
            console.warn('Failed to load class students for openAssignmentWork:', error);
          }

          try {
            students = await storageManager.listAssignmentStudentWork(classId, assignmentId, teacherId);
          } catch (error) {
            console.warn('Failed to load assignment student work for openAssignmentWork:', error);
          }
          const studentWorkRawResponse = (students as any)?.rawResponse ?? null;
          const studentWorkRows = Array.isArray(studentWorkRawResponse?.students)
            ? studentWorkRawResponse.students
            : (Array.isArray(studentWorkRawResponse?.data) ? studentWorkRawResponse.data : students);
          const focusedStudentWorkRow = (studentWorkRows || []).find((studentRow: any) => Number(studentRow?.authUserId ?? studentRow?.UserId ?? studentRow?.userId ?? 0) === focusStudentAuthUserId) || null;

          let studentReport: any = null;
          try {
            const teacherClasses = await storageManager.listTeacherClasses(teacherId);
            const joinedClasses: any[] = [];
            let resolvedStudent: any = null;
            let currentAssignmentRecord: any = null;

            for (const teacherClass of teacherClasses || []) {
              const teacherClassId = Number(teacherClass?.id ?? teacherClass?.classId ?? 0);
              if (!teacherClassId) {
                continue;
              }

              let classStudents: any[] = [];
              try {
                classStudents = await storageManager.listClassStudentsSummary(teacherClassId, teacherId);
              } catch (error) {
                console.warn(`Failed to load students for class ${teacherClassId}:`, error);
              }

              const studentEntry = classStudents.find((student: any) => Number(student.authUserId) === focusStudentAuthUserId) || null;
              if (!studentEntry) {
                continue;
              }

              if (!resolvedStudent) {
                resolvedStudent = studentEntry;
              }

              let classAssignments: any[] = [];
              let studentAssignments: any[] = [];
              try {
                classAssignments = await storageManager.listClassAssignments(teacherClassId, teacherId);
              } catch (error) {
                console.warn(`Failed to load assignments for class ${teacherClassId}:`, error);
              }

              try {
                studentAssignments = await storageManager.listStudentAssignmentsForClass(focusStudentAuthUserId, teacherClassId);
              } catch (error) {
                console.warn(`Failed to load student assignments for class ${teacherClassId}:`, error);
              }

              if (teacherClassId === classId) {
                currentAssignmentRecord = (studentAssignments || []).find((assignmentRow: any) => Number(assignmentRow?.assignmentId ?? assignmentRow?.id ?? 0) === assignmentId) || currentAssignmentRecord;
              }

              const studentAssignmentMap = new Map<number, any>();
              for (const assignmentRow of studentAssignments || []) {
                const key = Number(assignmentRow?.assignmentId ?? assignmentRow?.id ?? 0);
                if (key > 0) {
                  studentAssignmentMap.set(key, assignmentRow);
                }
              }

              joinedClasses.push({
                classInfo: teacherClass,
                student: studentEntry,
                assignments: (classAssignments || []).map((assignmentRow: any) => {
                  const assignmentKey = Number(assignmentRow?.id ?? assignmentRow?.assignmentId ?? 0);
                  const studentAssignment = studentAssignmentMap.get(assignmentKey) || null;
                  return {
                    ...assignmentRow,
                    started: !!studentAssignment,
                    workspaceName: String(studentAssignment?.workspaceName || ''),
                    workspaceRootPath: String(studentAssignment?.workspaceRootPath || ''),
                    linkedAt: String(studentAssignment?.linkedAt || ''),
                    hasWorkspace: !!studentAssignment?.workspaceRootPath
                  };
                })
              });
            }

            studentReport = {
              authUserId: focusStudentAuthUserId,
              studentName: resolvedStudent?.studentName || resolvedStudent?.displayName || 'Unknown Student',
              studentEmail: resolvedStudent?.studentEmail || resolvedStudent?.email || '',
              role: resolvedStudent?.role || 'Student',
              classes: joinedClasses,
              currentClassJoined: !!classStudents.find((student: any) => Number(student.authUserId) === focusStudentAuthUserId),
              currentAssignmentStarted: !!focusedStudentWorkRow || !!students.find((student: any) => Number(student.authUserId) === focusStudentAuthUserId),
              currentAssignmentWorkspaceName: String(focusedStudentWorkRow?.workspaceName || currentAssignmentRecord?.workspaceName || ''),
              currentAssignmentWorkspacePath: String(focusedStudentWorkRow?.workspaceRootPath || currentAssignmentRecord?.workspaceRootPath || ''),
              currentAssignmentLinkedAt: String(focusedStudentWorkRow?.linkedAt || currentAssignmentRecord?.linkedAt || ''),
              currentAssignmentSessionCount: Number(focusedStudentWorkRow?.sessionCount ?? currentAssignmentRecord?.sessionCount ?? 0),
              currentAssignmentTotalEvents: Number(focusedStudentWorkRow?.totalEvents ?? currentAssignmentRecord?.totalEvents ?? 0),
              currentAssignmentLastActive: String(focusedStudentWorkRow?.lastActive || currentAssignmentRecord?.lastActive || '')
            };
          } catch (error) {
            console.warn('Failed to build student report for openAssignmentWork:', error);
          }

          panel?.webview.postMessage({
            command: 'assignmentWorkData',
            data: { classInfo, assignment, classStudents, students, studentReport, studentWorkRawResponse }
          });
          break;
        }

        case 'openAssignmentStudent': {
          const teacherId = await getValidTeacherId();
          const classId = Number(message.classId);
          const assignmentId = Number(message.assignmentId);
          const studentAuthUserId = Number(message.studentAuthUserId);

          const sessions = await storageManager.listAssignmentStudentSessions(
            classId,
            assignmentId,
            studentAuthUserId,
            teacherId
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
          const teacherId = await getValidTeacherId();
          const classId = Number(message.classId);
          const assignmentId = Number(message.assignmentId);
          const requestedStudents = Array.isArray(message.students) ? message.students.slice(0, 2) : [];
          
          if (requestedStudents.length < 2) {
            panel?.webview.postMessage({ command: 'error', message: 'Select two students to compare.' });
            break;
          }

          const classInfo = await storageManager.getTeacherClassById(classId, teacherId);
          if (!classInfo) {
            panel?.webview.postMessage({ command: 'error', message: 'Class not found or access denied.' });
            break;
          }

          const assignments = await storageManager.listClassAssignments(classId, teacherId);
          const assignment = assignments.find(a => a.id === assignmentId);
          if (!assignment) {
            panel?.webview.postMessage({ command: 'error', message: 'Assignment not found.' });
            break;
          }

          const selections = [];
          for (const requested of requestedStudents) {
            const studentAuthUserId = Number(requested?.studentAuthUserId);
            if (!Number.isFinite(studentAuthUserId) || studentAuthUserId <= 0) {continue;}

            const sessions = await storageManager.listAssignmentStudentSessions(
              classId,
              assignmentId,
              studentAuthUserId,
              teacherId
            );

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