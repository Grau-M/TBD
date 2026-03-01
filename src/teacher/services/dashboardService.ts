import * as vscode from 'vscode';
import { storageManager } from '../../state';
import { parseLogTime, fetchAndParseLog } from '../utilis/LogHelpers';

export async function handleAnalyzeLogs(panel: vscode.WebviewPanel, password: string, context: vscode.ExtensionContext) {
    const files = await storageManager.listLogFiles();
    if (!files || files.length === 0) {
        panel.webview.postMessage({ command: 'dashboardData', data: { totalLogs: 0, totalEvents: 0 } });
        return;
    }

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
            const { parsed, partial } = await fetchAndParseLog(password, f.uri);
            if (partial) {aggregate.partialCount++;}

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
                        if (len && len > 0) {aggregate.pasteLengths.push(len);}
                        if (!len || len === 0 || len > thresholds.pasteLength) { fileStats.flagged++; aggregate.flaggedCount++; }
                    }
                    
                    if (t.startsWith('ai-') || t === 'ai' || t === 'ai-assist') {
                        aggregate.aiCount++; fileStats.aiCount++;
                        if (t === 'ai-paste' || t === 'ai-replace') {
                            aggregate.aiPasteCount++; fileStats.aiPasteCount++;
                            const alen = (typeof e.pasteCharCount === 'number') ? e.pasteCharCount : ((typeof e.pasteLength === 'number') ? e.pasteLength : ((typeof e.length === 'number') ? e.length : (typeof e.text === 'string' ? e.text.length : 0)));
                            if (alen && alen > 0) { aggregate.aiPasteLengths.push(alen); fileStats.aiPasteLengths.push(alen); }
                        }
                        if (t === 'ai-delete' || (t.includes('delete') && t.startsWith('ai-'))) {
                            aggregate.aiDeleteCount++; fileStats.aiDeleteCount++;
                        }
                        if (e.possibleAiDetection) { 
                            aggregate.aiFlagCount++; fileStats.aiFlagCount++; 
                            if (thresholds.flagAiEvents) { fileStats.flagged++; aggregate.flaggedCount++; } 
                        }
                    }
                    if (t === 'delete' || t === 'deletion' || t === 'backspace') {fileStats.delete++;}
                    if (t === 'key' || t === 'keystroke' || t === 'keypress' || t === 'input') {
                        fileStats.keystrokes++;
                        try {
                            if (e.flightTime && parseInt(e.flightTime) < thresholds.flight) { fileStats.flagged++; aggregate.flaggedCount++; }
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

    const aiEventRatio = Math.min(1, (aggregate.aiCount || 0) / total);
    const aiPasteRatio = Math.min(1, (aggregate.aiPasteCount || 0) / Math.max(1, (aggregate.aiCount || 0)));
    const avgAIPasteLen = aggregate.aiPasteLengths.length ? (aggregate.aiPasteLengths.reduce((a: number, b: number) => a + b, 0) / aggregate.aiPasteLengths.length) : 0;
    const avgAIPasteLenNorm = Math.min(1, avgAIPasteLen / Math.max(100, avgPasteLength || 100));
    const aiFlagRate = Math.min(1, (aggregate.aiFlagCount || 0) / Math.max(1, (aggregate.aiCount || 0)));

    const aiScoreRaw = (aiEventRatio * 0.6) + (aiPasteRatio * 0.2) + (avgAIPasteLenNorm * 0.15) + (aiFlagRate * 0.05);
    let aiProbability = Math.max(0, Math.min(100, Math.round(aiScoreRaw * 100)));

    aggregate.totalPasteCount = totalPasteCount;
    aggregate.totalDeleteCount = totalDeleteCount;
    aggregate.integrityScore = Math.max(0, Math.round((1 - ((aggregate.flaggedCount || 0) / Math.max(1, aggregate.totalEvents))) * 100));
    
    aggregate.metrics = {
        pasteRatio: Math.round(pasteRatio * 1000) / 10,
        deleteRatio: Math.round(deleteRatio * 1000) / 10,
        avgPasteLength: Math.round(avgPasteLength),
        aiProbability
    };

    try {
        for (const fs of aggregate.perFile) {
            if (!fs || fs.error) {continue;}
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

    panel.webview.postMessage({ command: 'dashboardData', data: aggregate });
}

export async function handleGenerateProfile(panel: vscode.WebviewPanel, password: string, filenames: string[]) {
    const files = await storageManager.listLogFiles();
    let expectedUser: string | null = null;
    let expectedProject: string | null = null;
    let totalActiveMs = 0, totalWallMs = 0, keystrokes = 0, edits = 0, pastes = 0, externalPastes = 0, terminalRuns = 0;
    let pauseLengths: number[] = [];

    for (const fname of filenames) {
        const chosen = files.find(f => f.label === fname);
        if (!chosen) {continue;}
        const { parsed } = await fetchAndParseLog(password, chosen.uri);
        
        if (parsed && parsed.events && parsed.events.length > 0) {
            const sessionUser = parsed.sessionHeader?.startedBy || 'Unknown';
            const sessionProject = parsed.sessionHeader?.project || 'Unknown';

            if (expectedUser === null) {expectedUser = sessionUser;}
            if (expectedProject === null) {expectedProject = sessionProject;}

            if (expectedUser !== sessionUser) {return panel.webview.postMessage({ command: 'error', message: 'Profile cancelled: Student mismatch.' });}
            if (expectedProject !== sessionProject) {return panel.webview.postMessage({ command: 'error', message: 'Profile cancelled: Project mismatch.' });}

            const events = parsed.events;
            const firstTime = parseLogTime(events[0].time);
            const lastTime = parseLogTime(events[events.length - 1].time);
            if (firstTime > 0 && lastTime > 0 && lastTime >= firstTime) {totalWallMs += (lastTime - firstTime);}

            let prevTime = 0;
            for (const e of events) {
                const t = parseLogTime(e.time);
                if (prevTime > 0 && t > 0) {
                    const diff = t - prevTime;
                    if (diff < 5 * 60 * 1000) {totalActiveMs += diff;}
                    if (diff >= 5000 && diff <= 60000) {pauseLengths.push(diff);}
                }
                if (t > 0) {prevTime = t;}

                const evType = (e.eventType || '').toLowerCase();
                if (evType === 'input' || evType === 'key' || evType === 'keystroke') {keystrokes++;}
                if (evType === 'replace' || evType === 'delete' || evType === 'backspace') {edits++;}
                if (evType === 'terminal' || evType === 'debug' || evType === 'run' || evType === 'terminalcommand') {terminalRuns++;}
                if (evType === 'paste' || evType === 'clipboard' || evType === 'pasteevent' || evType === 'ai-paste') {
                    pastes++;
                    if (e.source === 'external' || e.pastedFrom === 'external' || evType === 'ai-paste' || e.internal === false) {externalPastes++;}
                }
            }
        }
    }

    const activeMinsFloat = totalActiveMs / 60000;
    const activeHoursFloat = activeMinsFloat / 60 || 0.01;

    panel.webview.postMessage({
        command: 'profileData',
        data: {
            user: expectedUser, project: expectedProject, sessionsAnalyzed: filenames.length,
            totalActiveMins: Math.max(0, Math.round(activeMinsFloat)),
            totalWallMins: Math.max(0, Math.round(totalWallMs / 60000)),
            wpm: activeMinsFloat > 0 ? Math.round((keystrokes / 5) / activeMinsFloat) : 0,
            editRate: activeMinsFloat > 0 ? Math.round(edits / activeMinsFloat) : 0,
            pasteFreq: Math.round(pastes / activeHoursFloat),
            avgPauseMs: pauseLengths.length > 0 ? Math.round(pauseLengths.reduce((a,b)=>a+b,0)/pauseLengths.length) : 0,
            externalPasteRatio: pastes > 0 ? Math.round((externalPastes / pastes) * 100) : 0,
            internalPasteRatio: pastes > 0 ? Math.round(100 - ((externalPastes / pastes) * 100)) : 100,
            debugRunFreq: Math.round(terminalRuns / activeHoursFloat)
        }
    });
}

export async function handleGenerateTimeline(panel: vscode.WebviewPanel, password: string, filenames: string[], context: vscode.ExtensionContext) {
    const files = await storageManager.listLogFiles();
    let expectedUser: string | null = null;
    let expectedProject: string | null = null;
    let allEvents: any[] = [];
    
    for (const fname of filenames) {
        const chosen = files.find(f => f.label === fname);
        if (!chosen) {continue;}
        const { parsed } = await fetchAndParseLog(password, chosen.uri);

        if (parsed && parsed.events && parsed.events.length > 0) {
            const sessionUser = parsed.sessionHeader?.startedBy || 'Unknown';
            const sessionProject = parsed.sessionHeader?.project || 'Unknown';

            if (expectedUser === null) {expectedUser = sessionUser;}
            if (expectedProject === null) {expectedProject = sessionProject;}

            if (expectedUser !== sessionUser) {return panel.webview.postMessage({ command: 'error', message: 'Timeline cancelled: Student mismatch.' });}
            if (expectedProject !== sessionProject) {return panel.webview.postMessage({ command: 'error', message: 'Timeline cancelled: Project mismatch.' });}

            allEvents = allEvents.concat(parsed.events);
        }
    }

    if (allEvents.length < 5) {return panel.webview.postMessage({ command: 'error', message: 'Sparse activity: Not enough data points.' });}

    allEvents.sort((a, b) => parseLogTime(a.time) - parseLogTime(b.time));
    const gapThresholdMs = (context.globalState.get<any>('tbdSettings', { inactivityThreshold: 5 }).inactivityThreshold || 5) * 60 * 1000;
    const periods: any[] = [];
    let currentPeriod: any = null;

    for (let i = 0; i < allEvents.length; i++) {
        const t = parseLogTime(allEvents[i].time);
        if (t === 0) {continue;}

        if (!currentPeriod) {currentPeriod = { startTime: t, endTime: t, eventCount: 1 };}
        else {
            if (t - currentPeriod.endTime > gapThresholdMs) {
                periods.push(currentPeriod);
                currentPeriod = { startTime: t, endTime: t, eventCount: 1 };
            } else {
                currentPeriod.endTime = t;
                currentPeriod.eventCount++;
            }
        }
    }
    if (currentPeriod) {periods.push(currentPeriod);}

    panel.webview.postMessage({ command: 'timelineData', data: { user: expectedUser, project: expectedProject, periods, totalEvents: allEvents.length } });
}