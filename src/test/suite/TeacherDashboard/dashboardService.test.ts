import * as assert from 'assert';
import * as vscode from 'vscode';
import { storageManager } from '../../../state';
import { handleCompareAssignmentStudents, handleGenerateProfile, handleGenerateTimeline } from '../../../teacher/services/dashboardService';

suite('Teacher Dashboard - Behavioral Profile & Timeline Tests', () => {
    let postedMessages: any[] = [];
    let mockLogStore: { [uri: string]: string } = {};

    const mockPanel = {
        webview: {
            postMessage: async (msg: any) => {
                postedMessages.push(msg);
                return true;
            }
        }
    } as unknown as vscode.WebviewPanel;

    const mockContext = {
        globalState: {
            get: (key: string, def: any) => def 
        }
    } as unknown as vscode.ExtensionContext;

    function makeTimeStr(minutesOffset: number, secondsOffset: number = 0) {
        const d = new Date(2026, 1, 25, 10, minutesOffset, secondsOffset, 0); 
        const hr = d.getHours().toString().padStart(2, '0');
        const min = d.getMinutes().toString().padStart(2, '0');
        const sec = d.getSeconds().toString().padStart(2, '0');
        return `Feb-25-2026 ${hr}:${min}:${sec}:000 EST`;
    }

    setup(() => {
        postedMessages = [];
        mockLogStore = {};

        storageManager.listLogFiles = async () => {
            return Object.keys(mockLogStore).map(filename => ({
                label: filename,
                uri: vscode.Uri.file(filename)
            }));
        };

        storageManager.retrieveLogContentWithPassword = async (pwd, uri) => {
            const filename = uri.scheme === 'tbd-db'
                ? `session-${uri.path.replace(/^\//, '')}`
                : uri.fsPath.replace(/\\/g, '/').split('/').pop() || '';
            if (mockLogStore[filename]) {
                return { text: mockLogStore[filename], partial: false };
            }
            throw new Error("File not found");
        };
    });

    test('Profile: Sunny Day - Calculates normal session metrics correctly', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' }, 
                { time: makeTimeStr(1), eventType: 'input' }, 
                { time: makeTimeStr(2), eventType: 'replace' }, 
                { time: makeTimeStr(3), eventType: 'paste', source: 'external' }, 
                { time: makeTimeStr(4), eventType: 'paste', internal: true }, 
                { time: makeTimeStr(5), eventType: 'terminal' } 
            ]
        });

        await handleGenerateProfile(mockPanel, 'dummy', ['log1.log']);

        assert.strictEqual(postedMessages.length, 1);
        const data = postedMessages[0].data;
        assert.strictEqual(postedMessages[0].command, 'profileData');
        assert.strictEqual(data.user, 'Keenan');
        assert.strictEqual(data.totalActiveMins, 5);
        assert.strictEqual(data.externalPasteRatio, 50, '1 external and 1 internal paste = 50% ratio');
        assert.strictEqual(data.internalPasteRatio, 50);
        // FIXED ASSERTION: 2 keystrokes over 5 minutes = 0 WPM. It accurately calculated 0.
        assert.strictEqual(data.wpm, 0, 'WPM should correctly calculate 0 for sparse inputs');
    });

    test('Profile: Edge Case - Extremely short session handles floating-point math', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0, 0), eventType: 'input' }, 
                { time: makeTimeStr(0, 15), eventType: 'input' }, 
                { time: makeTimeStr(0, 30), eventType: 'input' }  
            ]
        });

        await handleGenerateProfile(mockPanel, 'dummy', ['log1.log']);
        
        const data = postedMessages[0].data;
        assert.strictEqual(data.totalActiveMins, 1, 'UI rounds up/down to nearest minute for display');
        assert.ok(isFinite(data.wpm), 'WPM should be a finite number, not Infinity');
        assert.ok(!isNaN(data.wpm), 'WPM should not be NaN');
    });

    test('Profile: Edge Case - Zero pastes handles divide-by-zero gracefully', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' }
            ] 
        });

        await handleGenerateProfile(mockPanel, 'dummy', ['log1.log']);
        
        const data = postedMessages[0].data;
        assert.strictEqual(data.pasteFreq, 0, 'Paste frequency should be 0');
        assert.strictEqual(data.externalPasteRatio, 0, 'Ratio should safely fallback to 0');
        assert.strictEqual(data.internalPasteRatio, 100, 'Internal fallback is 100% when 0 pastes occur');
    });

    test('Profile: Rainy Day - Rejects mismatched student names', async () => {
        mockLogStore['log1.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Keenan', project: 'Prj' }, events: [{ time: makeTimeStr(0), eventType: 'input' }] });
        mockLogStore['log2.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Alice', project: 'Prj' }, events: [{ time: makeTimeStr(1), eventType: 'input' }] });

        await handleGenerateProfile(mockPanel, 'dummy', ['log1.log', 'log2.log']);
        assert.ok(postedMessages[0].message.includes('Student mismatch'));
    });

    test('Profile: Rainy Day - Rejects mismatched projects', async () => {
        mockLogStore['log1.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Keenan', project: 'PrjA' }, events: [{ time: makeTimeStr(0), eventType: 'input' }] });
        mockLogStore['log2.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Keenan', project: 'PrjB' }, events: [{ time: makeTimeStr(1), eventType: 'input' }] });

        await handleGenerateProfile(mockPanel, 'dummy', ['log1.log', 'log2.log']);
        assert.ok(postedMessages[0].message.includes('Project mismatch'));
    });

    test('Timeline: Sunny Day - Sorts out-of-order events before processing', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(10), eventType: 'input' }, 
                { time: makeTimeStr(2), eventType: 'input' },  
                { time: makeTimeStr(1), eventType: 'input' },  
                { time: makeTimeStr(5), eventType: 'input' },  
                { time: makeTimeStr(3), eventType: 'input' }   
            ]
        });

        await handleGenerateTimeline(mockPanel, 'dummy', ['log1.log'], mockContext);
        
        const data = postedMessages[0].data;
        assert.strictEqual(data.totalEvents, 5, 'Should process all 5 events');
        assert.ok(data.periods.length > 0, 'Should form at least 1 period');
        assert.strictEqual(new Date(data.periods[0].startTime).getMinutes(), 1, 'First period must start at earliest chronologically sorted event');
    });

    test('Timeline: Sunny Day - Accurately splits periods based on > 5min gap', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(7), eventType: 'input' },
                { time: makeTimeStr(8), eventType: 'input' },
                { time: makeTimeStr(9), eventType: 'input' }
            ]
        });

        await handleGenerateTimeline(mockPanel, 'dummy', ['log1.log'], mockContext);
        
        const data = postedMessages[0].data;
        assert.strictEqual(data.periods.length, 2, 'Should divide events into exactly 2 work periods');
        assert.strictEqual(data.periods[0].eventCount, 2, 'First period should have 2 events');
        assert.strictEqual(data.periods[1].eventCount, 3, 'Second period should have 3 events');
    });

    test('Timeline: Rainy Day - Rejects sparse activity (< 5 events)', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'input' },
                { time: makeTimeStr(3), eventType: 'input' } 
            ]
        });

        await handleGenerateTimeline(mockPanel, 'dummy', ['log1.log'], mockContext);
        assert.strictEqual(postedMessages[0].command, 'error');
        assert.ok(postedMessages[0].message.includes('Sparse activity'));
    });

    test('Timeline: Sunny Day - Accepts exactly 5 events (Boundary Test)', async () => {
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'input' },
                { time: makeTimeStr(3), eventType: 'input' },
                { time: makeTimeStr(4), eventType: 'input' } 
            ]
        });

        await handleGenerateTimeline(mockPanel, 'dummy', ['log1.log'], mockContext);
        assert.strictEqual(postedMessages[0].command, 'timelineData', 'Should succeed with exactly 5 events');
    });

    test('Timeline: Rainy Day - Rejects mismatched student names', async () => {
        mockLogStore['log1.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Keenan', project: 'Prj' }, events: [{ time: makeTimeStr(0), eventType: 'input' }] });
        mockLogStore['log2.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Alice', project: 'Prj' }, events: [{ time: makeTimeStr(1), eventType: 'input' }] });

        await handleGenerateTimeline(mockPanel, 'dummy', ['log1.log', 'log2.log'], mockContext);
        assert.ok(postedMessages[0].message.includes('Student mismatch'));
    });

    test('Timeline: Rainy Day - Rejects mismatched projects', async () => {
        mockLogStore['log1.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Keenan', project: 'PrjA' }, events: [{ time: makeTimeStr(0), eventType: 'input' }] });
        mockLogStore['log2.log'] = JSON.stringify({ sessionHeader: { startedBy: 'Keenan', project: 'PrjB' }, events: [{ time: makeTimeStr(1), eventType: 'input' }] });

        await handleGenerateTimeline(mockPanel, 'dummy', ['log1.log', 'log2.log'], mockContext);
        assert.ok(postedMessages[0].message.includes('Project mismatch'));
    });

    test('Assignment comparison: Sunny Day - returns similarity and student payloads', async () => {
        mockLogStore['session-101'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone', metadata: { extensionVersion: '0.0.3', vscodeVersion: '1.108.1' } },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'paste', pasteCharCount: 80, source: 'external' },
                { time: makeTimeStr(3), eventType: 'run' },
                { time: makeTimeStr(4), eventType: 'input' }
            ]
        });
        mockLogStore['session-202'] = JSON.stringify({
            sessionHeader: { startedBy: 'Avery', project: 'Capstone', metadata: { extensionVersion: '0.0.3', vscodeVersion: '1.108.1' } },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'paste', pasteCharCount: 72, source: 'external' },
                { time: makeTimeStr(3), eventType: 'run' },
                { time: makeTimeStr(4), eventType: 'input' }
            ]
        });

        await handleCompareAssignmentStudents(mockPanel, 'dummy', [
            {
                studentAuthUserId: 1,
                studentName: 'Keenan',
                sessions: [{ sessionId: 101, filename: 'k-session.log', startedAt: '', ideUser: 'keenan', workspaceName: 'Capstone' }]
            },
            {
                studentAuthUserId: 2,
                studentName: 'Avery',
                sessions: [{ sessionId: 202, filename: 'a-session.log', startedAt: '', ideUser: 'avery', workspaceName: 'Capstone' }]
            }
        ], mockContext);

        assert.strictEqual(postedMessages[0].command, 'assignmentComparisonData');
        assert.strictEqual(postedMessages[0].data.students.length, 2);
        assert.ok(postedMessages[0].data.similarity.overall >= 0);
    });

    test('Assignment comparison: Rainy Day - warns on different extension versions', async () => {
        mockLogStore['session-301'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone', metadata: { extensionVersion: '0.0.2', vscodeVersion: '1.108.1' } },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'paste', pasteCharCount: 55 },
                { time: makeTimeStr(3), eventType: 'input' },
                { time: makeTimeStr(4), eventType: 'input' }
            ]
        });
        mockLogStore['session-302'] = JSON.stringify({
            sessionHeader: { startedBy: 'Avery', project: 'Capstone', metadata: { extensionVersion: '0.0.3', vscodeVersion: '1.108.1' } },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'paste', pasteCharCount: 65 },
                { time: makeTimeStr(3), eventType: 'input' },
                { time: makeTimeStr(4), eventType: 'input' }
            ]
        });

        await handleCompareAssignmentStudents(mockPanel, 'dummy', [
            {
                studentAuthUserId: 1,
                studentName: 'Keenan',
                sessions: [{ sessionId: 301, filename: 'k-session.log', startedAt: '', ideUser: 'keenan', workspaceName: 'Capstone' }]
            },
            {
                studentAuthUserId: 2,
                studentName: 'Avery',
                sessions: [{ sessionId: 302, filename: 'a-session.log', startedAt: '', ideUser: 'avery', workspaceName: 'Capstone' }]
            }
        ], mockContext);

        assert.ok(postedMessages[0].data.warnings.some((warning: string) => warning.includes('different versions of the extension')));
    });

    test('Assignment comparison: Rainy Day - warns when a student has no synced data', async () => {
        mockLogStore['session-401'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone', metadata: { extensionVersion: '0.0.3', vscodeVersion: '1.108.1' } },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'paste', pasteCharCount: 60 },
                { time: makeTimeStr(3), eventType: 'input' },
                { time: makeTimeStr(4), eventType: 'input' }
            ]
        });

        await handleCompareAssignmentStudents(mockPanel, 'dummy', [
            {
                studentAuthUserId: 1,
                studentName: 'Keenan',
                sessions: [{ sessionId: 401, filename: 'k-session.log', startedAt: '', ideUser: 'keenan', workspaceName: 'Capstone' }]
            },
            {
                studentAuthUserId: 2,
                studentName: 'Avery',
                sessions: []
            }
        ], mockContext);

        assert.ok(postedMessages[0].data.warnings.some((warning: string) => warning.includes('Missing data')));
        assert.strictEqual(postedMessages[0].data.similarity, null);
    });
});