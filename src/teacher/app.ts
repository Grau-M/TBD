import * as vscode from 'vscode';
import { storageManager } from '../state';
import { getHtml } from './getHtml';

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

    if (!initialPassword) return; // user cancelled
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

    panel.webview.onDidReceiveMessage(async message => {
        try {
            if (message.command === 'clientReady') {
                console.log('[teacher] webview clientReady received');
            }

            if (message.command === 'listLogs') {
                const files = await storageManager.listLogFiles();
                panel?.webview.postMessage({ command: 'logList', data: files.map(f => f.label) });
            }

            if (message.command === 'openLog') {
                const filename: string = message.filename;
                const files = await storageManager.listLogFiles();
                const chosen = files.find(f => f.label === filename);
                if (!chosen) {
                    panel?.webview.postMessage({ command: 'error', message: 'Log not found' });
                    return;
                }

                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ prompt: `Enter Administrator Password to view ${filename}`, password: true, ignoreFocusOut: true });
                    if (!password) { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); return; }
                    sessionPassword = password;
                }

                try {
                    const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
                    const content = res.text;
                    const partial = res.partial;

                    let parsed: any = null;
                    try { parsed = JSON.parse(content); } catch {
                        try {
                            const s = content.indexOf('{');
                            const e = content.lastIndexOf('}');
                            if (s !== -1 && e > s) parsed = JSON.parse(content.slice(s, e + 1));
                        } catch (_) { parsed = null; }
                    }

                    if (parsed) panel?.webview.postMessage({ command: 'logData', filename, data: parsed, partial });
                    else {
                        let safe = String(content).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '\uFFFD');
                        if (safe.length > 200_000) safe = safe.slice(0, 200_000) + '\n\n[truncated]';
                        panel?.webview.postMessage({ command: 'rawData', filename, data: safe, partial });
                    }
                } catch (err: any) {
                    panel?.webview.postMessage({ command: 'error', message: String(err) });
                }
            }

            // --- NEW: EXPORT LOG FEATURE ---
            if (message.command === 'exportLog') {
                const filename: string = message.filename;
                const format: 'csv' | 'json' = message.format;
                
                // 1. Authentication Check
                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ 
                        prompt: `Enter Admin Password to Export ${filename}`, 
                        password: true 
                    });
                    if (!password) {
                        panel?.webview.postMessage({ command: 'error', message: 'Export cancelled: Password required.' });
                        return;
                    }
                    sessionPassword = password;
                }

                try {
                    // 2. Retrieve & Decrypt Data
                    const files = await storageManager.listLogFiles();
                    const chosen = files.find(f => f.label === filename);
                    if(!chosen) throw new Error("File not found on disk");

                    const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
                    const logData = JSON.parse(res.text);

                    // 3. Format Data
                    let fileContent = '';
                    let fileExtension = '';

                    if (format === 'json') {
                        fileContent = JSON.stringify(logData, null, 2);
                        fileExtension = 'json';
                    } else {
                        // CSV Generation
                        fileExtension = 'csv';
                        const header = "Timestamp,EventType,FlightTime(ms),File,PasteLength,Details\n";
                        const rows = (logData.events || []).map((e: any) => {
                            // Sanitize fields for CSV (escape commas)
                            const escape = (s: any) => `"${String(s || '').replace(/"/g, '""')}"`;
                            
                            return [
                                escape(e.time),
                                escape(e.eventType),
                                escape(e.flightTime),
                                escape(e.fileView || e.fileEdit),
                                escape(e.pasteLength || e.length),
                                escape(e.text ? e.text.substring(0, 50) + "..." : "") // Truncate code snippets
                            ].join(',');
                        });
                        fileContent = header + rows.join('\n');
                    }

                    // 4. Show Save Dialog
                    const saveUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(`export-${filename.replace('.log','')}.${fileExtension}`),
                        filters: format === 'json' ? {'JSON': ['json']} : {'CSV': ['csv']}
                    });

                    if (saveUri) {
                        // 5. Write File
                        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(fileContent, 'utf8'));
                        
                        // 6. Audit Logging (Write to a separate audit file)
                        const auditEntry = `[${new Date().toISOString()}] EXPORT: Instructor exported ${filename} as ${format.toUpperCase()}.\n`;
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const auditUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode', 'audit_log.txt');
                            let currentAudit = '';
                            try {
                                const existing = await vscode.workspace.fs.readFile(auditUri);
                                currentAudit = existing.toString();
                            } catch {} // File might not exist yet
                            
                            await vscode.workspace.fs.writeFile(auditUri, Buffer.from(currentAudit + auditEntry, 'utf8'));
                        }

                        vscode.window.showInformationMessage(`Successfully exported ${filename} to ${format.toUpperCase()}`);
                        panel?.webview.postMessage({ command: 'success', message: 'Export complete.' });
                    }

                } catch (err: any) {
                    vscode.window.showErrorMessage(`Export Failed: ${err.message}`);
                    panel?.webview.postMessage({ command: 'error', message: `Export failed: ${err.message}` });
                }
            }
            // -------------------------------

            if (message.command === 'analyzeLogs') {
                const files = await storageManager.listLogFiles();
                if (!files || files.length === 0) {
                    panel?.webview.postMessage({ command: 'dashboardData', data: { totalLogs: 0, totalEvents: 0 } });
                    return;
                }

                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ prompt: `Enter Administrator Password to analyze all logs`, password: true, ignoreFocusOut: true });
                    if (!password) { panel?.webview.postMessage({ command: 'error', message: 'Password required for analysis' }); return; }
                    sessionPassword = password;
                }

                const aggregate: any = { totalLogs: files.length, totalEvents: 0, pasteCount: 0, deleteCount: 0, keystrokeCount: 0, pasteLengths: [], partialCount: 0, perFile: [] };

                for (const f of files) {
                    try {
                        const res = await storageManager.retrieveLogContentWithPassword(password, f.uri);
                        const content = res.text;
                        if (res.partial) aggregate.partialCount++;

                        let parsed: any = null;
                        try { parsed = JSON.parse(content); } catch {
                            try {
                                const s = content.indexOf('{');
                                const e = content.lastIndexOf('}');
                                if (s !== -1 && e > s) parsed = JSON.parse(content.slice(s, e + 1));
                            } catch (_) { parsed = null; }
                        }

                        const fileStats: any = { name: f.label, events: 0, paste: 0, delete: 0, keystrokes: 0, avgPasteLength: 0 };

                        if (parsed && Array.isArray(parsed.events)) {
                            fileStats.events = parsed.events.length;
                            for (const e of parsed.events) {
                                const t = (e.eventType || '').toString().toLowerCase();
                                if (t === 'paste' || t === 'clipboard' || t === 'pasteevent') {
                                    fileStats.paste++;
                                    const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : (typeof e.text === 'string' ? e.text.length : 0));
                                    if (len && len > 0) aggregate.pasteLengths.push(len);
                                }
                                if (t === 'delete' || t === 'deletion' || t === 'backspace') fileStats.delete++;
                                if (t === 'key' || t === 'keystroke' || t === 'keypress' || t === 'input') fileStats.keystrokes++;
                            }

                            aggregate.totalEvents += fileStats.events;
                            aggregate.pasteCount += fileStats.paste;
                            aggregate.deleteCount += fileStats.delete;
                            aggregate.keystrokeCount += fileStats.keystrokes;
                        }

                        aggregate.perFile.push(fileStats);
                    } catch (err: any) {
                        aggregate.perFile.push({ name: f.label, error: String(err) });
                    }
                }

                const total = aggregate.totalEvents || 1;
                const pasteRatio = Math.min(1, aggregate.pasteCount / total);
                const deleteRatio = Math.min(1, aggregate.deleteCount / total);
                const avgPasteLength = aggregate.pasteLengths.length ? (aggregate.pasteLengths.reduce((a: number, b: number) => a + b, 0) / aggregate.pasteLengths.length) : 0;

                const normalizedPasteLen = Math.min(1, avgPasteLength / 1000);
                let score = (pasteRatio * 0.6 + normalizedPasteLen * 0.35 + deleteRatio * 0.05) * 100;
                score = Math.max(0, Math.min(100, Math.round(score)));

                aggregate.metrics = { pasteRatio: Math.round(pasteRatio * 1000) / 10, deleteRatio: Math.round(deleteRatio * 1000) / 10, avgPasteLength: Math.round(avgPasteLength), aiProbability: score };

                panel?.webview.postMessage({ command: 'dashboardData', data: aggregate });
            }

            if (message.command === 'getSettings') {
                const current = context.globalState.get('tbdSettings', { inactivityThreshold: 5, flightTimeThreshold: 50, pasteLengthThreshold: 50 });
                panel?.webview.postMessage({ command: 'loadSettings', settings: current });
            }

            if (message.command === 'saveSettings') {
                await context.globalState.update('tbdSettings', message.settings);
                panel?.webview.postMessage({ command: 'settingsSaved', success: true });
            }

        } catch (e) {
            panel?.webview.postMessage({ command: 'error', message: String(e) });
        }
    }, undefined, context.subscriptions);
}