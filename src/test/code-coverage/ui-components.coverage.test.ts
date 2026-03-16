// Test: ui-components.coverage.test.ts
// Purpose: Comprehensive coverage tests for UI components (statusBar, uiTimer, confidenceIndicator)
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createStatusBar } from '../../statusBar';
import { startUiTimer } from '../../uiTimer';
import { computeConfidence } from '../../confidenceIndicator';
import { state } from '../../state';

suite('Code Coverage: UI Components', () => {
    let context: vscode.ExtensionContext;
    let disposables: vscode.Disposable[] = [];

    setup(() => {
        // Create minimal mock context
        context = {
            subscriptions: [],
            extensionPath: '',
            extensionUri: vscode.Uri.file(''),
            globalState: {} as any,
            workspaceState: {} as any,
            secrets: {} as any,
            extensionMode: vscode.ExtensionMode.Development,
            storagePath: undefined,
            globalStoragePath: '',
            logPath: '',
            storageUri: undefined,
            globalStorageUri: vscode.Uri.file(''),
            logUri: vscode.Uri.file(''),
            asAbsolutePath: (relativePath: string) => relativePath,
            environmentVariableCollection: {} as any,
            extension: {} as any,
            languageModelAccessInformation: {} as any
        } as vscode.ExtensionContext;

        // Reset state
        state.sessionBuffer = [];
        state.focusAwayStartTime = null;
        state.sessionStartTime = Date.now();

        disposables = [];
    });

    teardown(() => {
        // Clean up all disposables
        disposables.forEach(d => d.dispose());
        context.subscriptions.forEach(d => d.dispose());
        disposables = [];

        // Clear globals
        delete (global as any).statusBarItem;
        delete (global as any).hiddenStatusBarItem;
    });

    suite('statusBar', () => {
        test('createStatusBar creates and shows status bar item', () => {
            const item = createStatusBar(context);
            
            assert.ok(item, 'Should create status bar item');
            assert.ok(item.text.includes('TBD Logger'), 'Should set text');
            assert.strictEqual(item.command, undefined, 'Primary timer should be display-only (no command)');
            
            disposables.push(item);
        });

        test('createStatusBar registers item in subscriptions', () => {
            const item = createStatusBar(context);
            
            assert.ok(context.subscriptions.length > 0, 'Should register in subscriptions');
            assert.ok(context.subscriptions.includes(item), 'Should include the status bar item');
            
            disposables.push(item);
        });

        test('createStatusBar sets global statusBarItem', () => {
            const item = createStatusBar(context);
            
            assert.ok((global as any).statusBarItem, 'Should set global statusBarItem');
            assert.strictEqual((global as any).statusBarItem, item, 'Global should reference created item');
            
            disposables.push(item);
        });

        test('createStatusBar creates hidden item when hiddenCommandId provided', () => {
            const item = createStatusBar(context, 'tbd-logger.openTeacherView');
            
            assert.ok((global as any).hiddenStatusBarItem, 'Should create hidden status bar item');
            assert.ok(context.subscriptions.length >= 2, 'Should register both items');
            
            const hiddenItem = (global as any).hiddenStatusBarItem as vscode.StatusBarItem;
            assert.ok(hiddenItem.text.includes('lock'), 'Hidden item should have lock icon');
            assert.strictEqual(hiddenItem.command, 'tbd-logger.openTeacherView', 'Hidden item should have correct command');
            
            disposables.push(item);
        });

        test('createStatusBar without hiddenCommandId does not create hidden item', () => {
            const item = createStatusBar(context);
            
            assert.strictEqual((global as any).hiddenStatusBarItem, undefined, 'Should not create hidden item');
            
            disposables.push(item);
        });

        test('createStatusBar sets tooltip', () => {
            const item = createStatusBar(context);
            
            assert.ok(item.tooltip, 'Should set tooltip');
            assert.ok(item.tooltip.toString().includes('Capstone'), 'Tooltip should mention Capstone');
            
            disposables.push(item);
        });

        test('createStatusBar sets alignment and priority', () => {
            const item = createStatusBar(context);
            
            assert.strictEqual(item.alignment, vscode.StatusBarAlignment.Left, 'Should align left');
            
            disposables.push(item);
        });
    });

    suite('uiTimer', () => {
        test('startUiTimer returns a Disposable', () => {
            const mockItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            const timer = startUiTimer(mockItem);
            
            assert.ok(timer, 'Should return a timer');
            assert.ok(typeof timer.dispose === 'function', 'Should be disposable');
            
            disposables.push(timer, mockItem);
        });

        test('uiTimer updates status bar text with session duration', async () => {
            const mockItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            state.focusAwayStartTime = null;
            state.sessionStartTime = Date.now() - 5000;
            
            const timer = startUiTimer(mockItem);
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            assert.ok(mockItem.text.includes('REC'), 'Should show REC when not away');
            assert.ok(mockItem.text.includes(':'), 'Should include time format');
            
            disposables.push(timer, mockItem);
        });

        test('uiTimer shows AWAY when focus is lost', async () => {
            const mockItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            state.focusAwayStartTime = Date.now() - 3000;
            
            const timer = startUiTimer(mockItem);
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            assert.ok(mockItem.text.includes('AWAY'), 'Should show AWAY when focus lost');
            
            disposables.push(timer, mockItem);
        });

        test('uiTimer can be disposed', async () => {
            const mockItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            const timer = startUiTimer(mockItem);
            
            assert.doesNotThrow(() => timer.dispose(), 'Should dispose cleanly');
            
            disposables.push(mockItem);
        });
    });

    suite('confidenceIndicator', () => {
        test('computeConfidence returns Low for empty events', () => {
            const result = computeConfidence([]);
            
            assert.strictEqual(result.label, 'Low', 'Should return Low for no events');
            assert.strictEqual(result.score, 0, 'Score should be 0');
            assert.ok(result.reasons.length > 0, 'Should have reasons');
            assert.ok(result.flags.includes('NO_DATA'), 'Should flag NO_DATA');
        });

        test('computeConfidence handles non-array input defensively', () => {
            const result = computeConfidence('not-an-array' as any);
            assert.strictEqual(result.label, 'Low', 'Should treat invalid input as no data');
            assert.strictEqual(result.stats.eventCount, 0, 'Event count should default to 0 for invalid input');
        });

        test('computeConfidence handles low volume', () => {
            const events = Array.from({length: 30}, (_, i) => ({
                time: new Date(Date.now() - i * 1000).toISOString()
            }));
            
            const result = computeConfidence(events);
            assert.ok(result.score < 100, 'Score should be reduced');
        });

        test('computeConfidence detects large gaps', () => {
            const events = [
                { time: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
                { time: new Date(Date.now()).toISOString() }
            ];
            
            const result = computeConfidence(events);
            assert.ok(result.stats.gapCountOver2h > 0, 'Should detect 2h+ gaps');
        });

        test('computeConfidence detects session pauses', () => {
            const events = Array.from({length: 10}, () => ({
                time: new Date().toISOString(),
                fileView: '[INTERRUPTION] Session Paused (Inactivity 5m)'
            }));
            
            const result = computeConfidence(events);
            assert.ok(result.stats.pauseCount >= 8, 'Should count pause events');
        });

        test('computeConfidence detects integrity warnings', () => {
            const events = [
                {
                    time: new Date().toISOString(),
                    possibleAiDetection: 'Integrity check failed'
                },
                ...Array.from({length: 100}, (_, i) => ({
                    time: new Date(Date.now() - i * 1000).toISOString()
                }))
            ];
            
            const result = computeConfidence(events);
            assert.ok(result.stats.integrityWarnings > 0, 'Should detect integrity warnings');
        });

        test('computeConfidence detects corrupt/tamper integrity keyword variants', () => {
            const events = [
                { time: new Date().toISOString(), possibleAiDetection: 'log appears corrupt' },
                { time: new Date().toISOString(), possibleAiDetection: 'tamper evidence present' },
                ...Array.from({ length: 120 }, (_, i) => ({
                    time: new Date(Date.now() - i * 1000).toISOString()
                }))
            ];

            const result = computeConfidence(events);
            assert.ok(result.stats.integrityWarnings >= 2, 'Should count corrupt/tamper keywords as integrity warnings');
        });

        test('computeConfidence clamps score', () => {
            const events = [
                {
                    time: new Date().toISOString(),
                    fileView: '[INTERRUPTION] Session Paused',
                    possibleAiDetection: 'integrity warning'
                }
            ];
            
            const result = computeConfidence(events);
            assert.ok(result.score >= 0 && result.score <= 100, 'Score should be 0-100');
        });

        test('computeConfidence returns clean OK result when data is complete', () => {
            const now = Date.now();
            const events = Array.from({ length: 220 }, (_, i) => ({
                time: new Date(now - i * 1000).toISOString(),
                fileView: 'active.ts'
            }));

            const result = computeConfidence(events);
            assert.strictEqual(result.label, 'High', 'Should stay High with strong data');
            assert.strictEqual(result.score, 100, 'Should remain at full score');
            assert.ok(result.flags.includes('OK'), 'Should mark clean logs as OK');
        });

        test('computeConfidence reaches Medium label for moderate penalties', () => {
            const now = Date.now();
            const events: Array<{ time: string; fileView?: string }> = [];

            // Cluster 1
            for (let i = 0; i < 40; i++) {
                events.push({ time: new Date(now - i * 1000).toISOString(), fileView: 'main.ts' });
            }
            // Gap > 30m
            for (let i = 0; i < 30; i++) {
                events.push({ time: new Date(now - 40 * 60 * 1000 - i * 1000).toISOString(), fileView: 'main.ts' });
            }
            // Another gap > 30m
            for (let i = 0; i < 30; i++) {
                events.push({ time: new Date(now - 80 * 60 * 1000 - i * 1000).toISOString(), fileView: 'main.ts' });
            }

            events.push({ time: new Date(now - 3000).toISOString(), fileView: '[INTERRUPTION] Session Paused' });
            events.push({ time: new Date(now - 4000).toISOString(), fileView: '[INTERRUPTION] Session Paused' });
            events.push({ time: new Date(now - 5000).toISOString(), fileView: '[INTERRUPTION] Session Paused' });

            const result = computeConfidence(events);
            assert.strictEqual(result.label, 'Medium', 'Should downgrade to Medium for stacked moderate penalties');
            assert.ok(result.flags.includes('MED_VOLUME'), 'Should include medium volume flag');
            assert.ok(result.flags.includes('MED_GAPS'), 'Should include medium gaps flag');
            assert.ok(result.flags.includes('SOME_PAUSES'), 'Should include some pauses flag');
        });

        test('computeConfidence handles invalid timestamp entries safely', () => {
            const events = [
                { time: 'not-a-timestamp', fileView: 'main.ts' },
                { time: new Date().toISOString(), fileView: 'main.ts' },
                { fileView: 'main.ts' } as any
            ];

            const result = computeConfidence(events);
            assert.ok(result.score >= 0 && result.score <= 100, 'Should still return valid score with malformed times');
        });

        test('computeConfidence reaches Low label when penalties stack heavily', () => {
            const now = Date.now();
            const events: Array<{ time: string; fileView?: string; possibleAiDetection?: string }> = [];

            for (let i = 0; i < 20; i++) {
                events.push({ time: new Date(now - i * 1000).toISOString(), fileView: 'main.ts' });
            }
            for (let i = 0; i < 10; i++) {
                events.push({
                    time: new Date(now - 3 * 60 * 60 * 1000 - i * 1000).toISOString(),
                    fileView: '[INTERRUPTION] Session Paused',
                    possibleAiDetection: 'integrity warning'
                });
            }

            const result = computeConfidence(events);
            assert.strictEqual(result.label, 'Low', 'Should drop to Low when severe penalties stack');
            assert.ok(result.flags.includes('LARGE_GAPS'), 'Should include large gaps flag');
            assert.ok(result.flags.includes('INTEGRITY_WARNING'), 'Should include integrity warning flag');
        });
    });
});
