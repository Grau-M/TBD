import * as vscode from 'vscode';
import { storageManager } from '../state';
import { getHtml } from './getHtml';

let panel: vscode.WebviewPanel | undefined;
let sessionPassword: string | undefined;

// FIXED: Now properly handles alphabetic months (e.g., "Feb") and timezones
function parseLogTime(s: string): number {
    if (!s) return 0;
    const cleanStr = s.replace(/ [A-Z]{3,4}$/, ""); // remove EST/UTC etc.
    const parts = cleanStr.split(' ');
    if (parts.length < 2) return 0;

    const datePart = parts[0];
    const timePart = parts[1];

    const dateSub = datePart.split('-');
    if (dateSub.length < 3) return 0;

    const monthStr = dateSub[0];
    const months: { [key: string]: number } = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };
    
    // Parse the string month into a number
    const month = months[monthStr] !== undefined ? months[monthStr] : parseInt(monthStr) - 1;
    const day = parseInt(dateSub[1]);
    const year = parseInt(dateSub[2]);

    const timeSub = timePart.split(':');
    const hr = parseInt(timeSub[0]) || 0;
    const min = parseInt(timeSub[1]) || 0;
    const sec = parseInt(timeSub[2]) || 0;
    const ms = parseInt(timeSub[3]) || 0;

    const parsedTime = new Date(year, month, day, hr, min, sec, ms).getTime();
    return isNaN(parsedTime) ? 0 : parsedTime;
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
                    let fileExtension = format;

                    if (format === 'json') {
                        fileContent = JSON.stringify(logData, null, 2);
                    } else {
                        const header = "Timestamp,EventType,FlightTime(ms),File,PasteLength,Details\n";
                        const rows = (logData.events || []).map((e: any) => {
                            const escape = (s: any) => `"${String(s || '').replace(/"/g, '""')}"`;
                            return [
                                escape(e.time), escape(e.eventType), escape(e.flightTime),
                                escape(e.fileView || e.fileEdit), escape(e.pasteLength || e.length),
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
                            try { currentAudit = (await vscode.workspace.fs.readFile(auditUri)).toString(); } catch {} 
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

            // --- GENERATE BEHAVIORAL PROFILE ---
            if (message.command === 'generateProfile') {
                const filenames: string[] = message.filenames;
                let password = sessionPassword;
                if (!password) {
                    password = await vscode.window.showInputBox({ prompt: `Enter Administrator Password to Generate Profile`, password: true });
                    if (!password) { panel?.webview.postMessage({ command: 'error', message: 'Password required' }); return; }
                    sessionPassword = password;
                }

                try {
                    const files = await storageManager.listLogFiles();
                    let totalActiveMs = 0;
                    let totalWallMs = 0;
                    let keystrokes = 0;
                    let edits = 0;
                    let pastes = 0;
                    let externalPastes = 0;
                    let terminalRuns = 0;
                    let pauseLengths: number[] = [];
                    let project = "Unknown";
                    let user = "Unknown";

                    for (const fname of filenames) {
                        const chosen = files.find(f => f.label === fname);
                        if (!chosen) continue;
                        
                        const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
                        let parsed: any = null;
                        try { parsed = JSON.parse(res.text); } catch {
                            try {
                                const s = res.text.indexOf('{');
                                const e = res.text.lastIndexOf('}');
                                if (s !== -1 && e > s) parsed = JSON.parse(res.text.slice(s, e + 1));
                            } catch (_) { continue; }
                        }
                        
                        if (parsed && parsed.events && parsed.events.length > 0) {
                            if (parsed.sessionHeader) {
                                project = parsed.sessionHeader.project || project;
                                user = parsed.sessionHeader.startedBy || user;
                            }
                            const events = parsed.events;
                            const firstTime = parseLogTime(events[0].time);
                            const lastTime = parseLogTime(events[events.length - 1].time);
                            
                            if (firstTime > 0 && lastTime > 0 && lastTime >= firstTime) {
                                totalWallMs += (lastTime - firstTime);
                            }

                            let prevTime = 0;
                            for (const e of events) {
                                const t = parseLogTime(e.time);
                                if (prevTime > 0 && t > 0) {
                                    const diff = t - prevTime;
                                    // Less than 5 mins is considered "Active" time
                                    if (diff < 5 * 60 * 1000) { 
                                        totalActiveMs += diff;
                                    }
                                    // Micro-pauses (Thinking time): Pauses between 5 seconds and 1 minute
                                    if (diff >= 5000 && diff <= 60000) { 
                                        pauseLengths.push(diff);
                                    }
                                }
                                if (t > 0) prevTime = t;

                                const evType = (e.eventType || '').toLowerCase();
                                
                                // Metrics Counting
                                if (evType === 'input' || evType === 'key' || evType === 'keystroke') keystrokes++;
                                if (evType === 'replace' || evType === 'delete' || evType === 'backspace') edits++;
                                if (evType === 'terminal' || evType === 'debug' || evType === 'run' || evType === 'terminalcommand') terminalRuns++;
                                
                                if (evType === 'paste' || evType === 'clipboard' || evType === 'pasteevent' || evType === 'ai-paste') {
                                    pastes++;
                                    // FIXED PASTE LOGIC: Assume Internal unless explicitly marked otherwise
                                    if (e.source === 'external' || e.pastedFrom === 'external' || evType === 'ai-paste' || e.internal === false) {
                                        externalPastes++;
                                    }
                                }
                            }
                        }
                    }

                    // FIXED MATH: Use floats so short test sessions (e.g. 40 seconds) don't round down to 0 minutes!
                    const activeMinsFloat = totalActiveMs / 60000;
                    const wallMinsFloat = totalWallMs / 60000;
                    const activeHoursFloat = activeMinsFloat / 60 || 0.01; // Prevent divide by zero

                    const wpm = activeMinsFloat > 0 ? Math.round((keystrokes / 5) / activeMinsFloat) : 0;
                    const editRate = activeMinsFloat > 0 ? Math.round(edits / activeMinsFloat) : 0;
                    const pasteFreq = Math.round(pastes / activeHoursFloat);
                    const avgPauseMs = pauseLengths.length > 0 ? Math.round(pauseLengths.reduce((a,b)=>a+b,0)/pauseLengths.length) : 0;
                    const externalPasteRatio = pastes > 0 ? Math.round((externalPastes / pastes) * 100) : 0;
                    const debugRunFreq = Math.round(terminalRuns / activeHoursFloat);

                    // Provide rounded values for the UI display only
                    const totalActiveMins = Math.max(0, Math.round(activeMinsFloat));
                    const totalWallMins = Math.max(0, Math.round(wallMinsFloat));

                    panel?.webview.postMessage({
                        command: 'profileData',
                        data: {
                            user,
                            project,
                            sessionsAnalyzed: filenames.length,
                            totalActiveMins,
                            totalWallMins,
                            wpm,
                            editRate,
                            pasteFreq,
                            avgPauseMs,
                            externalPasteRatio,
                            internalPasteRatio: 100 - externalPasteRatio,
                            debugRunFreq
                        }
                    });

                } catch (err: any) {
                    panel?.webview.postMessage({ command: 'error', message: `Profile generation failed: ${err.message}` });
                }
            }

            // --- ANALYZE LOGS (WITH ADVANCED AI DETECTION) ---
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

                // Load persisted thresholds
                const savedSettings = context.globalState.get('tbdSettings', { inactivityThreshold: 5, flightTimeThreshold: 50, pasteLengthThreshold: 50, flagAiEvents: true });
                const thresholds = {
                    inactivity: savedSettings.inactivityThreshold || 5,
                    flight: savedSettings.flightTimeThreshold || 50,
                    pasteLength: savedSettings.pasteLengthThreshold || 50,
                    flagAiEvents: (typeof savedSettings.flagAiEvents === 'boolean') ? savedSettings.flagAiEvents : true
                };

                const aggregate: any = { 
                    totalLogs: files.length, totalEvents: 0, pasteCount: 0, deleteCount: 0, keystrokeCount: 0, 
                    pasteLengths: [], partialCount: 0, perFile: [], 
                    aiCount: 0, aiPasteCount: 0, aiPasteLengths: [], aiFlagCount: 0, aiDeleteCount: 0, flaggedCount: 0,
                    totalWallTime: 0, totalActiveTime: 0
                };

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

                        const fileStats: any = { 
                            name: f.label, events: 0, paste: 0, delete: 0, keystrokes: 0, avgPasteLength: 0, 
                            aiCount: 0, aiPasteCount: 0, aiPasteLengths: [], aiFlagCount: 0, flagged: 0,
                            activeTime: 0, wallTime: 0
                        };

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

                                const flight = parseInt(e.flightTime || '0');
                                const inactivityLimitMs = thresholds.inactivity * 60 * 1000;
                                if (flight > 0 && flight < inactivityLimitMs) {
                                    fileStats.activeTime += flight;
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

                // Advanced AI probability algorithm
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
                    aiProbability
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