import * as vscode from 'vscode';
import { storageManager } from '../state';
import { getHtml } from './getHtml';

let panel: vscode.WebviewPanel | undefined;
let sessionPassword: string | undefined;

// Helper to parse "MM-DD-YYYY hh:mm:ss:SSS" into milliseconds
function parseLogTime(s: string): number {
    if (!s) return 0;
    const [datePart, timePart] = s.split(' ');
    if (!datePart || !timePart) return 0;
    const [month, day, year] = datePart.split('-').map(Number);
    const [hr, min, sec, ms] = timePart.split(':').map(Number);
    return new Date(year, month - 1, day, hr, min, sec, ms || 0).getTime();
}

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

    if (!initialPassword) return; 
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

            if (message.command === 'exportLog') {
                const filename: string = message.filename;
                const format: 'csv' | 'json' = message.format;
                
                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ prompt: `Enter Admin Password to Export ${filename}`, password: true });
                    if (!password) { panel?.webview.postMessage({ command: 'error', message: 'Export cancelled: Password required.' }); return; }
                    sessionPassword = password;
                }

                try {
                    const files = await storageManager.listLogFiles();
                    const chosen = files.find(f => f.label === filename);
                    if(!chosen) throw new Error("File not found on disk");

                    const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
                    const logData = JSON.parse(res.text);

                    let fileContent = '';
                    let fileExtension = '';

                    if (format === 'json') {
                        fileContent = JSON.stringify(logData, null, 2);
                        fileExtension = 'json';
                    } else {
                        fileExtension = 'csv';
                        const header = "Timestamp,EventType,FlightTime(ms),File,PasteLength,Details\n";
                        const rows = (logData.events || []).map((e: any) => {
                            const escape = (s: any) => `"${String(s || '').replace(/"/g, '""')}"`;
                            return [
                                escape(e.time),
                                escape(e.eventType),
                                escape(e.flightTime),
                                escape(e.fileView || e.fileEdit),
                                escape(e.pasteLength || e.length),
                                escape(e.text ? e.text.substring(0, 50) + "..." : "")
                            ].join(',');
                        });
                        fileContent = header + rows.join('\n');
                    }

                    const saveUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(`export-${filename.replace('.log','')}.${fileExtension}`),
                        filters: format === 'json' ? {'JSON': ['json']} : {'CSV': ['csv']}
                    });

                    if (saveUri) {
                        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(fileContent, 'utf8'));
                        
                        const auditEntry = `[${new Date().toISOString()}] EXPORT: Instructor exported ${filename} as ${format.toUpperCase()}.\n`;
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const auditUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode', 'audit_log.txt');
                            let currentAudit = '';
                            try {
                                const existing = await vscode.workspace.fs.readFile(auditUri);
                                currentAudit = existing.toString();
                            } catch {} 
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

                // Load persisted thresholds/settings
                const savedSettings = context.globalState.get('tbdSettings', { inactivityThreshold: 5, flightTimeThreshold: 50, pasteLengthThreshold: 50, flagAiEvents: true });
                const thresholds = {
                    inactivity: savedSettings.inactivityThreshold || 5,
                    flight: savedSettings.flightTimeThreshold || 50,
                    pasteLength: savedSettings.pasteLengthThreshold || 50,
                    flagAiEvents: (typeof savedSettings.flagAiEvents === 'boolean') ? savedSettings.flagAiEvents : true
                };

                const aggregate: any = { totalLogs: files.length, totalEvents: 0, pasteCount: 0, deleteCount: 0, keystrokeCount: 0, pasteLengths: [], partialCount: 0, perFile: [], aiCount: 0, aiPasteCount: 0, aiPasteLengths: [], aiFlagCount: 0, aiDeleteCount: 0, flaggedCount: 0 };

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

                        const fileStats: any = { name: f.label, events: 0, paste: 0, delete: 0, keystrokes: 0, avgPasteLength: 0, aiCount: 0, aiPasteCount: 0, aiPasteLengths: [], aiFlagCount: 0, flagged: 0 };

                        if (parsed && Array.isArray(parsed.events) && parsed.events.length > 0) {
                            const events = parsed.events;
                            fileStats.events = events.length;
                            
                            const firstTime = parseLogTime(events[0].time);
                            const lastTime = parseLogTime(events[events.length - 1].time);
                            if (firstTime > 0 && lastTime > 0 && lastTime >= firstTime) {
                                fileStats.wallTime = lastTime - firstTime;
                            }

                            for (const e of events) {
                                const t = (e.eventType || '').toString().toLowerCase();
                                
                                if (t === 'paste' || t === 'clipboard' || t === 'pasteevent') {
                                    fileStats.paste++;
                                    const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : (typeof e.text === 'string' ? e.text.length : 0));
                                    if (len && len > 0) aggregate.pasteLengths.push(len);
                                    if (!len || len === 0 || len > thresholds.pasteLength) { fileStats.flagged = (fileStats.flagged || 0) + 1; aggregate.flaggedCount = (aggregate.flaggedCount || 0) + 1; }
                                }
                                
                                if (t.startsWith('ai-') || t === 'ai' || t === 'ai-assist') {
                                    aggregate.aiCount = (aggregate.aiCount || 0) + 1;
                                    fileStats.aiCount = (fileStats.aiCount || 0) + 1;
                                    
                                    if (t === 'ai-paste' || t === 'ai-replace') {
                                        aggregate.aiPasteCount = (aggregate.aiPasteCount || 0) + 1;
                                        fileStats.aiPasteCount = (fileStats.aiPasteCount || 0) + 1;
                                        const alen = (typeof e.pasteCharCount === 'number') ? e.pasteCharCount : ((typeof e.pasteLength === 'number') ? e.pasteLength : ((typeof e.length === 'number') ? e.length : (typeof e.text === 'string' ? e.text.length : 0)));
                                        if (alen && alen > 0) { aggregate.aiPasteLengths.push(alen); fileStats.aiPasteLengths.push(alen); }
                                    }
                                    if (t === 'ai-delete' || (t.includes('delete') && t.startsWith('ai-'))) {
                                        aggregate.aiDeleteCount = (aggregate.aiDeleteCount || 0) + 1;
                                        fileStats.aiDeleteCount = (fileStats.aiDeleteCount || 0) + 1;
                                    }
                                    if (e.possibleAiDetection) { 
                                        aggregate.aiFlagCount = (aggregate.aiFlagCount || 0) + 1; 
                                        fileStats.aiFlagCount = (fileStats.aiFlagCount || 0) + 1; 
                                        if (thresholds.flagAiEvents) { fileStats.flagged = (fileStats.flagged || 0) + 1; aggregate.flaggedCount = (aggregate.flaggedCount || 0) + 1; } 
                                    }
                                }
                                if (t === 'delete' || t === 'deletion' || t === 'backspace') fileStats.delete++;
                                if (t === 'key' || t === 'keystroke' || t === 'keypress' || t === 'input') {
                                    fileStats.keystrokes++;
                                    try {
                                        if (e.flightTime && parseInt(e.flightTime) < thresholds.flight) { fileStats.flagged = (fileStats.flagged || 0) + 1; aggregate.flaggedCount = (aggregate.flaggedCount || 0) + 1; }
                                    } catch (err) {}
                                }
                            }

                            aggregate.totalEvents += fileStats.events;
                            aggregate.pasteCount += fileStats.paste;
                            aggregate.deleteCount += fileStats.delete;
                            aggregate.keystrokeCount += fileStats.keystrokes;
                            aggregate.totalWallTime += fileStats.wallTime;
                            aggregate.totalActiveTime += fileStats.activeTime;
                        }

                        aggregate.perFile.push(fileStats);
                    } catch (err: any) {
                        aggregate.perFile.push({ name: f.label, error: String(err) });
                    }
                }

                const total = aggregate.totalEvents || 1;
                const combinedPasteLengths = (aggregate.pasteLengths || []).concat(aggregate.aiPasteLengths || []);
                const avgPasteLength = combinedPasteLengths.length ? (combinedPasteLengths.reduce((a: number, b: number) => a + b, 0) / combinedPasteLengths.length) : 0;
                const totalPasteCount = (aggregate.pasteCount || 0) + (aggregate.aiPasteCount || 0);
                const totalDeleteCount = (aggregate.deleteCount || 0) + (aggregate.aiDeleteCount || 0);
                const pasteRatio = Math.min(1, totalPasteCount / total);
                const deleteRatio = Math.min(1, totalDeleteCount / total);

                const aiEventRatio = Math.min(1, (aggregate.aiCount || 0) / total);
                const aiPasteRatio = Math.min(1, (aggregate.aiPasteCount || 0) / Math.max(1, (aggregate.aiCount || 0)));
                const avgAIPasteLen = aggregate.aiPasteLengths.length ? (aggregate.aiPasteLengths.reduce((a: number, b: number) => a + b, 0) / aggregate.aiPasteLengths.length) : 0;
                const avgAIPasteLenNorm = Math.min(1, avgAIPasteLen / Math.max(100, avgPasteLength || 100));
                const aiFlagRate = Math.min(1, (aggregate.aiFlagCount || 0) / Math.max(1, (aggregate.aiCount || 0)));

                const aiScoreRaw = (aiEventRatio * 0.6) + (aiPasteRatio * 0.2) + (avgAIPasteLenNorm * 0.15) + (aiFlagRate * 0.05);
                let aiProbability = Math.max(0, Math.min(100, Math.round(aiScoreRaw * 100)));

                aggregate.totalPasteCount = totalPasteCount;
                aggregate.totalDeleteCount = totalDeleteCount;
                aggregate.flaggedCount = aggregate.flaggedCount || 0;
                aggregate.integrityScore = Math.max(0, Math.round((1 - (aggregate.flaggedCount / Math.max(1, aggregate.totalEvents))) * 100));
                aggregate.metrics = {
                    pasteRatio: Math.round(pasteRatio * 1000) / 10,
                    deleteRatio: Math.round(deleteRatio * 1000) / 10,
                    avgPasteLength: Math.round(avgPasteLength),
                    aiProbability,
                    _debug: {
                        aiEventRatio: +(aiEventRatio.toFixed(4)),
                        aiPasteRatio: +(aiPasteRatio.toFixed(4)),
                        avgAIPasteLen: Math.round(avgAIPasteLen),
                        aiFlagRate: +(aiFlagRate.toFixed(4))
                    }
                };

                try {
                    for (const fs of aggregate.perFile) {
                        if (!fs || fs.error) continue;
                        const totalF = fs.events || 1;
                        const aiEventRatioF = Math.min(1, (fs.aiCount || 0) / totalF);
                        const aiPasteRatioF = Math.min(1, (fs.aiPasteCount || 0) / Math.max(1, (fs.aiCount || 0)));
                        const avgAIPasteLenF = (fs.aiPasteLengths && fs.aiPasteLengths.length) ? (fs.aiPasteLengths.reduce((a: number, b: number) => a + b, 0) / fs.aiPasteLengths.length) : 0;
                        const avgAIPasteLenNormF = Math.min(1, avgAIPasteLenF / Math.max(100, avgPasteLength || 100));
                        const aiFlagRateF = Math.min(1, (fs.aiFlagCount || 0) / Math.max(1, (fs.aiCount || 0)));
                        const aiScoreRawF = (aiEventRatioF * 0.6) + (aiPasteRatioF * 0.2) + (avgAIPasteLenNormF * 0.15) + (aiFlagRateF * 0.05);
                        const aiProbF = Math.max(0, Math.min(100, Math.round(aiScoreRawF * 100)));
                        fs.aiProbability = aiProbF;
                        fs.metrics = fs.metrics || {};
                        fs.metrics.aiProbability = aiProbF;
                        fs.metrics._debug = {
                            aiEventRatio: +(aiEventRatioF.toFixed(4)),
                            aiPasteRatio: +(aiPasteRatioF.toFixed(4)),
                            avgAIPasteLen: Math.round(avgAIPasteLenF),
                            aiFlagRate: +(aiFlagRateF.toFixed(4))
                        };
                    }
                } catch (e) { }

                panel?.webview.postMessage({ command: 'dashboardData', data: aggregate });
            }

            if (message.command === 'getSettings') {
                const current = context.globalState.get('tbdSettings', { inactivityThreshold: 5, flightTimeThreshold: 50, pasteLengthThreshold: 50, flagAiEvents: true });
                panel?.webview.postMessage({ command: 'loadSettings', settings: current });
            }

            if (message.command === 'saveSettings') {
                await context.globalState.update('tbdSettings', message.settings);
                panel?.webview.postMessage({ command: 'settingsSaved', success: true });
            }

            if (message.command === 'getDeletions') {
                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ prompt: `Enter Administrator Password to view deletion activity`, password: true, ignoreFocusOut: true });
                    if (!password) { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); return; }
                    sessionPassword = password;
                }
                try {
                    const json = await storageManager.retrieveHiddenLogContent(password);
                    let parsed: any = null;
                    try { parsed = JSON.parse(json); } catch { parsed = { raw: json }; }
                    panel?.webview.postMessage({ command: 'deletionData', data: parsed });
                } catch (err: any) {
                    panel?.webview.postMessage({ command: 'error', message: String(err) });
                }
            }

        } catch (e) {
            panel?.webview.postMessage({ command: 'error', message: String(e) });
        }
    }, undefined, context.subscriptions);
}