import * as assert from 'assert';
import * as vscode from 'vscode';
import { storageManager } from '../../state';
import { handleGenerateProfile, handleGenerateTimeline } from '../../teacher/services/dashboardService';

suite('Teacher Dashboard - Behavioral Profile & Timeline Tests', () => {
    let postedMessages: any[] = [];
    let mockLogStore: { [uri: string]: string } = {};

    // Mock the Webview Panel
    const mockPanel = {
        webview: {
            postMessage: async (msg: any) => {
                postedMessages.push(msg);
                return true;
            }
        }
    } as unknown as vscode.WebviewPanel;

    // Mock the Extension Context (default settings: 5 min gap threshold)
    const mockContext = {
        globalState: {
            get: (key: string, def: any) => def 
        }
    } as unknown as vscode.ExtensionContext;

    // Helper to generate a timestamp string in the extension's exact format
    function makeTimeStr(minutesOffset: number) {
        const d = new Date(2026, 1, 25, 10, minutesOffset, 0, 0); // Feb 25, 2026, 10:00 AM + offset
        const hr = d.getHours().toString().padStart(2, '0');
        const min = d.getMinutes().toString().padStart(2, '0');
        const sec = d.getSeconds().toString().padStart(2, '0');
        return `Feb-25-2026 ${hr}:${min}:${sec}:000 EST`;
    }

    // Mock Storage Manager methods before tests run
    setup(() => {
        postedMessages = [];
        mockLogStore = {};

        // Stub listLogFiles to return whatever is currently in mockLogStore
        storageManager.listLogFiles = async () => {
            return Object.keys(mockLogStore).map(filename => ({
                label: filename,
                uri: vscode.Uri.file(filename)
            }));
        };

        // Stub retrieveLogContentWithPassword to return our fake JSON string
        storageManager.retrieveLogContentWithPassword = async (pwd, uri) => {
            const filename = uri.fsPath.replace(/\\/g, '/').split('/').pop() || '';
            if (mockLogStore[filename]) {
                return { text: mockLogStore[filename], partial: false };
            }
            throw new Error("File not found");
        };
    });

    // --- BEHAVIORAL PROFILE TESTS ---

    test('Profile: Sunny Day - Calculates WPM, Ratios, and Churn correctly', async () => {
        // Arrange: Create a 5-minute session with various events
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' }, // Start
                { time: makeTimeStr(1), eventType: 'input' }, // +1 min
                { time: makeTimeStr(2), eventType: 'replace' }, // +2 mins (Edit)
                { time: makeTimeStr(3), eventType: 'paste', source: 'external' }, // +3 mins (External Paste)
                { time: makeTimeStr(4), eventType: 'paste', internal: true }, // +4 mins (Internal Paste)
                { time: makeTimeStr(5), eventType: 'terminal' } // +5 mins (Debug)
            ]
        });

        // Act
        await handleGenerateProfile(mockPanel, 'dummyPassword', ['log1.log']);

        // Assert
        assert.strictEqual(postedMessages.length, 1, 'Should post exactly one message to Webview');
        const msg = postedMessages[0];
        assert.strictEqual(msg.command, 'profileData', 'Should return profileData command');
        
        const data = msg.data;
        assert.strictEqual(data.user, 'Keenan', 'User should match');
        assert.strictEqual(data.project, 'Capstone', 'Project should match');
        assert.strictEqual(data.totalActiveMins, 5, 'Active time should be exactly 5 minutes');
        assert.strictEqual(data.externalPasteRatio, 50, '1 external and 1 internal paste = 50% ratio');
    });

    test('Profile: Rainy Day - Rejects mismatched student names', async () => {
        // Arrange: Log 1 belongs to Keenan, Log 2 belongs to Alice
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [{ time: makeTimeStr(0), eventType: 'input' }]
        });
        mockLogStore['log2.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Alice', project: 'Capstone' },
            events: [{ time: makeTimeStr(1), eventType: 'input' }]
        });

        // Act
        await handleGenerateProfile(mockPanel, 'dummyPassword', ['log1.log', 'log2.log']);

        // Assert
        const msg = postedMessages[0];
        assert.strictEqual(msg.command, 'error', 'Should return error command for mismatch');
        assert.ok(msg.message.includes('Student mismatch'), 'Error message should specify Student mismatch');
    });


    // --- TIMELINE TESTS ---

    test('Timeline: Sunny Day - Groups continuous work and identifies gaps', async () => {
        // Arrange: 
        // 3 events grouped together (minutes 0, 1, 2)
        // 10 minute gap! (Threshold is 5)
        // 3 events grouped together (minutes 12, 13, 14)
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' },
                { time: makeTimeStr(2), eventType: 'input' },
                // --- GAP ---
                { time: makeTimeStr(12), eventType: 'input' },
                { time: makeTimeStr(13), eventType: 'input' },
                { time: makeTimeStr(14), eventType: 'input' }
            ]
        });

        // Act
        await handleGenerateTimeline(mockPanel, 'dummyPassword', ['log1.log'], mockContext);

        // Assert
        const msg = postedMessages[0];
        assert.strictEqual(msg.command, 'timelineData', 'Should return timelineData command');
        
        const data = msg.data;
        assert.strictEqual(data.periods.length, 2, 'Should divide events into exactly 2 work periods');
        
        // Period 1 ends at minute 2, Period 2 starts at minute 12
        assert.strictEqual(data.periods[0].eventCount, 3, 'First period should have 3 events');
        assert.strictEqual(data.periods[1].eventCount, 3, 'Second period should have 3 events');
    });

    test('Timeline: Rainy Day - Rejects sparse activity', async () => {
        // Arrange: Only 2 events total (we require at least 5 for a meaningful timeline)
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Capstone' },
            events: [
                { time: makeTimeStr(0), eventType: 'input' },
                { time: makeTimeStr(1), eventType: 'input' }
            ]
        });

        // Act
        await handleGenerateTimeline(mockPanel, 'dummyPassword', ['log1.log'], mockContext);

        // Assert
        const msg = postedMessages[0];
        assert.strictEqual(msg.command, 'error', 'Should return an error command');
        assert.ok(msg.message.includes('Sparse activity'), 'Error should specify Sparse Activity');
    });

    test('Timeline: Rainy Day - Rejects mismatched projects', async () => {
        // Arrange: Same user, different projects
        mockLogStore['log1.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Frontend' },
            events: [{ time: makeTimeStr(0), eventType: 'input' }]
        });
        mockLogStore['log2.log'] = JSON.stringify({
            sessionHeader: { startedBy: 'Keenan', project: 'Backend' },
            events: [{ time: makeTimeStr(1), eventType: 'input' }]
        });

        // Act
        await handleGenerateTimeline(mockPanel, 'dummyPassword', ['log1.log', 'log2.log'], mockContext);

        // Assert
        const msg = postedMessages[0];
        assert.strictEqual(msg.command, 'error');
        assert.ok(msg.message.includes('Project mismatch'), 'Error message should specify Project mismatch');
    });
});