import * as vscode from 'vscode';
import { storageManager } from '../../state';
import { parseLogTime, fetchAndParseLog } from '../utilis/LogHelpers';

type AssignmentComparisonSelection = {
    studentAuthUserId: number;
    studentName: string;
    totalSessionCount?: number;
    sessions: Array<{
        sessionId: number;
        filename: string;
        startedAt: string;
        ideUser: string;
        workspaceName: string;
    }>;
};

type ComparisonCategory = 'input' | 'edit' | 'paste' | 'ai' | 'focus' | 'run' | 'other';

function toCategory(eventType: string): ComparisonCategory {
    const lowered = String(eventType || '').toLowerCase();
    if (lowered === 'input' || lowered === 'key' || lowered === 'keystroke' || lowered === 'keypress') {return 'input';}
    if (lowered === 'replace' || lowered === 'delete' || lowered === 'backspace' || lowered === 'undo') {return 'edit';}
    if (lowered === 'paste' || lowered === 'clipboard' || lowered === 'pasteevent' || lowered === 'external-paste') {return 'paste';}
    if (lowered.startsWith('ai-') || lowered === 'ai' || lowered === 'ai-assist') {return 'ai';}
    if (lowered === 'focuschange' || lowered === 'focusduration' || lowered === 'save') {return 'focus';}
    if (lowered === 'terminal' || lowered === 'debug' || lowered === 'run' || lowered === 'terminalcommand') {return 'run';}
    return 'other';
}

function basenameish(value: string): string {
    const normalized = String(value || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function readPasteLength(event: any): number {
    if (typeof event.pasteCharCount === 'number') {return event.pasteCharCount;}
    if (typeof event.pasteLength === 'number') {return event.pasteLength;}
    if (typeof event.length === 'number') {return event.length;}
    if (typeof event.text === 'string') {return event.text.length;}
    return 0;
}

function average(values: number[]): number {
    if (!values.length) {return 0;}
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
    if (value < 0) {return 0;}
    if (value > 1) {return 1;}
    return value;
}

function sampleCategories(events: Array<{ category: ComparisonCategory }>, sampleCount: number): ComparisonCategory[] {
    if (!events.length || sampleCount <= 0) {return [];}
    if (events.length <= sampleCount) {return events.map(event => event.category);}

    const sampled: ComparisonCategory[] = [];
    for (let index = 0; index < sampleCount; index++) {
        const sourceIndex = Math.round((index * (events.length - 1)) / Math.max(1, sampleCount - 1));
        sampled.push(events[sourceIndex].category);
    }
    return sampled;
}

function computeSequenceSimilarity(left: Array<{ category: ComparisonCategory }>, right: Array<{ category: ComparisonCategory }>): number {
    const sampleCount = Math.min(60, Math.max(left.length, right.length));
    if (sampleCount <= 0) {return 0;}

    const leftSample = sampleCategories(left, sampleCount);
    const rightSample = sampleCategories(right, sampleCount);
    let matches = 0;
    for (let index = 0; index < sampleCount; index++) {
        if (leftSample[index] === rightSample[index]) {
            matches++;
        }
    }

    return matches / sampleCount;
}

function computeComparisonScore(left: any, right: any) {
    const categories: ComparisonCategory[] = ['input', 'edit', 'paste', 'ai', 'focus', 'run', 'other'];
    const leftTotal = Math.max(1, left.totalEvents || 0);
    const rightTotal = Math.max(1, right.totalEvents || 0);

    let distributionDelta = 0;
    for (const category of categories) {
        const leftRatio = (left.categoryCounts?.[category] || 0) / leftTotal;
        const rightRatio = (right.categoryCounts?.[category] || 0) / rightTotal;
        distributionDelta += Math.abs(leftRatio - rightRatio);
    }
    const distributionScore = clamp01(1 - (distributionDelta / 2));

    const sequenceScore = computeSequenceSimilarity(left.timelineEvents || [], right.timelineEvents || []);

    const gapScore = clamp01(1 - (Math.abs((left.averageGapMs || 0) - (right.averageGapMs || 0)) / Math.max(1, left.averageGapMs || 0, right.averageGapMs || 0)));
    const pasteScore = clamp01(1 - (Math.abs((left.pasteRate || 0) - (right.pasteRate || 0)) / Math.max(1, left.pasteRate || 0, right.pasteRate || 0)));
    const durationScore = clamp01(1 - (Math.abs((left.activeSpanMs || 0) - (right.activeSpanMs || 0)) / Math.max(1, left.activeSpanMs || 0, right.activeSpanMs || 0)));
    const cadenceScore = average([gapScore, pasteScore, durationScore]);

    const overall = Math.round(((distributionScore * 0.45) + (sequenceScore * 0.35) + (cadenceScore * 0.20)) * 100);

    return {
        overall,
        distribution: Math.round(distributionScore * 100),
        sequence: Math.round(sequenceScore * 100),
        cadence: Math.round(cadenceScore * 100)
    };
}

async function buildAssignmentComparisonStudent(selection: AssignmentComparisonSelection, password: string, pasteThreshold: number) {
    const timelineEvents: any[] = [];
    const sessionSummaries: any[] = [];
    const warnings: string[] = [];
    const projects = new Set<string>();
    const extensionVersions = new Set<string>();
    const vscodeVersions = new Set<string>();
    const categoryCounts: Record<ComparisonCategory, number> = {
        input: 0,
        edit: 0,
        paste: 0,
        ai: 0,
        focus: 0,
        run: 0,
        other: 0
    };

    await Promise.all(selection.sessions.map(async (session) => {
        try {
            const uri = vscode.Uri.parse(`tbd-db://session/${session.sessionId}`);
            const { parsed, partial } = await fetchAndParseLog(password, uri);
            if (!parsed || !Array.isArray(parsed.events)) {
                warnings.push(`Session ${session.filename} could not be parsed for comparison.`);
                return;
            }

            const metadata = parsed.sessionHeader?.metadata || {};
            const extensionVersion = String(metadata.extensionVersion || '');
            const vscodeVersion = String(metadata.vscodeVersion || '');
            const project = String(parsed.sessionHeader?.project || session.workspaceName || '');

            if (extensionVersion) {extensionVersions.add(extensionVersion);} else {warnings.push(`Session ${session.filename} is missing extension version metadata.`);}
            if (vscodeVersion) {vscodeVersions.add(vscodeVersion);}
            if (project) {projects.add(project);}

            const parsedEvents = parsed.events
                .map((event: any, index: number) => {
                    const timeMs = parseLogTime(event.time || '');
                    const category = toCategory(event.eventType || '');
                    const pasteLength = readPasteLength(event);
                    const suspiciousPaste = category === 'paste' && (!pasteLength || pasteLength > pasteThreshold || event.source === 'external' || event.pastedFrom === 'external' || event.internal === false);
                    const fileName = basenameish(event.fileEdit || event.fileView || event.file || event.filePath || '');

                    categoryCounts[category]++;
                    return {
                        key: `${session.sessionId}-${index}`,
                        time: event.time || '',
                        timeMs,
                        category,
                        eventType: String(event.eventType || 'unknown'),
                        sessionId: session.sessionId,
                        sessionLabel: session.filename,
                        workspaceName: session.workspaceName || project || '',
                        fileName,
                        pasteLength,
                        suspiciousPaste,
                        flightTime: Number.parseInt(String(event.flightTime || '0'), 10) || 0,
                        source: String(event.source || event.pastedFrom || ''),
                        possibleAiDetection: String(event.possibleAiDetection || '')
                    };
                })
                .sort((left: any, right: any) => left.timeMs - right.timeMs);

            timelineEvents.push(...parsedEvents);
            sessionSummaries.push({
                sessionId: session.sessionId,
                filename: session.filename,
                startedAt: session.startedAt,
                ideUser: session.ideUser,
                workspaceName: session.workspaceName,
                eventCount: parsedEvents.length,
                partial: !!partial,
                extensionVersion,
                vscodeVersion,
                integrityVerified: metadata.integrityVerification?.verified !== false
            });
        } catch (err: any) {
            warnings.push(`Session ${session.filename} failed to load: ${String(err?.message || err)}`);
        }
    }));

    timelineEvents.sort((left: any, right: any) => left.timeMs - right.timeMs);
    const validEventTimes = timelineEvents.map((event: any) => event.timeMs).filter((value: number) => value > 0);
    const firstTime = validEventTimes.length ? validEventTimes[0] : 0;
    const lastTime = validEventTimes.length ? validEventTimes[validEventTimes.length - 1] : 0;
    const gaps: number[] = [];
    for (let index = 1; index < validEventTimes.length; index++) {
        const gap = validEventTimes[index] - validEventTimes[index - 1];
        if (gap > 0) {
            gaps.push(gap);
        }
    }

    for (const event of timelineEvents) {
        event.offsetMs = event.timeMs > 0 && firstTime > 0 ? event.timeMs - firstTime : 0;
    }

    const totalEvents = timelineEvents.length;
    const totalPasteEvents = timelineEvents.filter(event => event.category === 'paste').length;
    const suspiciousPasteCount = timelineEvents.filter(event => event.suspiciousPaste).length;
    const synced = selection.sessions.length > 0 && totalEvents > 0;
    if ((selection.totalSessionCount || selection.sessions.length) > selection.sessions.length) {
        warnings.push(`Only the most recent ${selection.sessions.length} session(s) were analyzed for ${selection.studentName}.`);
    }

    return {
        studentAuthUserId: selection.studentAuthUserId,
        studentName: selection.studentName,
        synced,
        sessionCount: selection.sessions.length,
        totalEvents,
        totalPasteEvents,
        suspiciousPasteCount,
        activeSpanMs: firstTime > 0 && lastTime >= firstTime ? lastTime - firstTime : 0,
        averageGapMs: Math.round(average(gaps)),
        pasteRate: totalEvents > 0 ? totalPasteEvents / totalEvents : 0,
        categoryCounts,
        projects: Array.from(projects),
        extensionVersions: Array.from(extensionVersions),
        vscodeVersions: Array.from(vscodeVersions),
        warnings,
        sessions: sessionSummaries,
        timelineEvents
    };
}

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
        totalWallTime: 0, totalActiveTime: 0, unmonitoredAlertCount: 0, unmonitoredAlerts: []
    };

    try {
        const alerts = await storageManager.listRecentUnmonitoredWorkAlerts(20);
        aggregate.unmonitoredAlertCount = alerts.length;
        aggregate.unmonitoredAlerts = alerts;
    } catch {
        // Keep dashboard usable when alert lookup is unavailable.
    }

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
                    
                    if (t === 'paste' || t === 'clipboard' || t === 'pasteevent' || t === 'external-paste') {
                        fileStats.paste++;
                        const len = (typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : (typeof e.pasteCharCount === 'number' ? e.pasteCharCount : (typeof e.text === 'string' ? e.text.length : 0)));
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
                if (evType === 'paste' || evType === 'clipboard' || evType === 'pasteevent' || evType === 'ai-paste' || evType === 'external-paste') {
                    pastes++;
                    if (e.source === 'external' || e.pastedFrom === 'external' || evType === 'ai-paste' || evType === 'external-paste' || e.internal === false) {
                        externalPastes++;
                    }
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

export async function handleCompareAssignmentStudents(
    panel: vscode.WebviewPanel,
    password: string,
    selections: AssignmentComparisonSelection[],
    context: vscode.ExtensionContext
) {
    const limitedSelections = Array.isArray(selections) ? selections.slice(0, 2) : [];
    if (limitedSelections.length < 2) {
        panel.webview.postMessage({ command: 'error', message: 'Select two students to compare sessions.' });
        return;
    }

    const savedSettings = context.globalState.get('tbdSettings', { pasteLengthThreshold: 50 });
    const pasteThreshold = Number(savedSettings?.pasteLengthThreshold || 50);
    const students = [];
    for (const selection of limitedSelections) {
        students.push(await buildAssignmentComparisonStudent(selection, password, pasteThreshold));
    }

    const warnings: string[] = [];
    const missingStudents = students.filter(student => !student.synced).map(student => student.studentName);
    if (missingStudents.length > 0) {
        warnings.push(`Missing data: ${missingStudents.join(', ')} have not synced session data yet. Ask them to sync before relying on this comparison.`);
    }

    const extensionVersions = new Set(students.flatMap(student => student.extensionVersions));
    if (extensionVersions.size > 1) {
        warnings.push('Selected students are using different versions of the extension. Comparison may be less accurate.');
    }
    if (extensionVersions.size === 0) {
        warnings.push('Extension version metadata is unavailable for the selected sessions. Comparison accuracy may be reduced.');
    }

    const projects = new Set(students.flatMap(student => student.projects));
    if (projects.size > 1) {
        warnings.push('Selected students have session data across different projects or workspace names. Review the context before drawing conclusions.');
    }

    for (const student of students) {
        warnings.push(...student.warnings);
    }

    const comparableStudents = students.filter(student => student.synced);
    const similarity = comparableStudents.length === 2 ? computeComparisonScore(comparableStudents[0], comparableStudents[1]) : null;
    const maxOffsetMs = students.reduce((largest, student) => Math.max(largest, student.activeSpanMs || 0), 0);

    panel.webview.postMessage({
        command: 'assignmentComparisonData',
        data: {
            students,
            warnings,
            missingStudents,
            similarity,
            maxOffsetMs,
            categories: ['input', 'edit', 'paste', 'ai', 'focus', 'run', 'other'],
            summary: similarity
                ? `Similarity score ${similarity.overall}% based on event mix, sequence shape, and session pacing.`
                : 'Comparison is partial because one or more selected students do not yet have enough synced session data.'
        }
    });
}