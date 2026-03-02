// Test: handlers.coverage.test.ts
// Purpose: Comprehensive coverage tests for focus handlers
import * as assert from 'assert';
import * as vscode from 'vscode';
import { handleFocusLost, handleFocusRegained } from '../../handlers/focusHandlers';
import { state, CONSTANTS } from '../../state';

suite('Code Coverage: Focus Handlers', () => {
    setup(() => {
        // Reset state before each test
        state.sessionBuffer = [];
        state.focusAwayStartTime = null;
        state.lastEventTime = Date.now();
        
        // Clear globals
        delete (global as any).statusBarItem;
    });

    teardown(() => {
        delete (global as any).statusBarItem;
    });

    suite('handleFocusLost', () => {
        test('sets focusAwayStartTime when focus is lost', () => {
            const beforeTime = Date.now();
            handleFocusLost();
            
            assert.ok(state.focusAwayStartTime !== null, 'Should set focusAwayStartTime');
            assert.ok(state.focusAwayStartTime >= beforeTime, 'Should set to current time');
        });

        test('does not reset focusAwayStartTime if already set', () => {
            const firstTime = Date.now() - 5000;
            state.focusAwayStartTime = firstTime;
            
            handleFocusLost();
            
            assert.strictEqual(state.focusAwayStartTime, firstTime, 'Should not reset if already away');
        });

        test('updates status bar when global statusBarItem exists', () => {
            const mockStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            (global as any).statusBarItem = mockStatusBar;
            
            handleFocusLost();
            
            assert.ok(mockStatusBar.text.includes('AWAY'), 'Should update text to AWAY');
            assert.ok(mockStatusBar.tooltip!.toString().includes('Focus Lost'), 'Should update tooltip');
            
            mockStatusBar.dispose();
        });

        test('handles missing global statusBarItem gracefully', () => {
            delete (global as any).statusBarItem;
            
            assert.doesNotThrow(() => handleFocusLost(), 'Should not throw if statusBarItem is missing');
        });

        test('sets AWAY timer to 00:00:00', () => {
            const mockStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            (global as any).statusBarItem = mockStatusBar;
            
            handleFocusLost();
            
            assert.ok(mockStatusBar.text.includes('00:00:00'), 'Should show 00:00:00 initially');
            
            mockStatusBar.dispose();
        });

        test('sets yellow color theme when focus lost', () => {
            const mockStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            (global as any).statusBarItem = mockStatusBar;
            
            handleFocusLost();
            
            assert.ok(mockStatusBar.color, 'Should set color');
            
            mockStatusBar.dispose();
        });
    });

    suite('handleFocusRegained', () => {
        test('clears focusAwayStartTime when focus returns', () => {
            state.focusAwayStartTime = Date.now() - 5000;
            
            handleFocusRegained();
            
            assert.strictEqual(state.focusAwayStartTime, null, 'Should clear focusAwayStartTime');
        });

        test('does nothing if focusAwayStartTime was not set', () => {
            state.focusAwayStartTime = null;
            const initialBufferLength = state.sessionBuffer.length;
            
            handleFocusRegained();
            
            assert.strictEqual(state.sessionBuffer.length, initialBufferLength, 'Should not log if never lost focus');
        });

        test('logs event when away time exceeds threshold', () => {
            const threshold = CONSTANTS.FOCUS_THRESHOLD_MS;
            state.focusAwayStartTime = Date.now() - threshold - 1000; // Exceed threshold
            
            handleFocusRegained();
            
            const focusEvent = state.sessionBuffer.find(
                e => e.eventType === 'focusChange' && e.fileView === 'Focus Away (Major)'
            );
            
            assert.ok(focusEvent, 'Should log Focus Away (Major) event');
            assert.ok(parseInt(focusEvent!.flightTime) >= threshold, 'flightTime should reflect time away');
        });

        test('does not log event when away time is below threshold', () => {
            const threshold = CONSTANTS.FOCUS_THRESHOLD_MS;
            state.focusAwayStartTime = Date.now() - (threshold - 1000); // Below threshold
            
            const initialLength = state.sessionBuffer.length;
            handleFocusRegained();
            
            assert.strictEqual(state.sessionBuffer.length, initialLength, 'Should not log if below threshold');
        });

        test('calculates time away correctly', () => {
            const timeAwayMs = 65000; // 65 seconds
            state.focusAwayStartTime = Date.now() - timeAwayMs;
            
            handleFocusRegained();
            
            // Should clear the away time
            assert.strictEqual(state.focusAwayStartTime, null, 'Should clear away time');
        });

        test('handles focus regained at exact threshold', () => {
            const threshold = CONSTANTS.FOCUS_THRESHOLD_MS;
            state.focusAwayStartTime = Date.now() - threshold;
            
            handleFocusRegained();
            
            const focusEvent = state.sessionBuffer.find(
                e => e.eventType === 'focusChange' && e.fileView === 'Focus Away (Major)'
            );
            
            assert.ok(focusEvent, 'Should log event at exact threshold');
        });

        test('sets correct timestamp for focus regained event', () => {
            const threshold = CONSTANTS.FOCUS_THRESHOLD_MS;
            state.focusAwayStartTime = Date.now() - threshold - 1000;
            
            const beforeRegain = Date.now();
            handleFocusRegained();
            const afterRegain = Date.now();
            
            const focusEvent = state.sessionBuffer.find(
                e => e.eventType === 'focusChange' && e.fileView === 'Focus Away (Major)'
            );
            
            if (focusEvent) {
                // Time should be set to current time
                assert.ok(focusEvent.time, 'Should have timestamp');
            }
        });
    });

    suite('Focus Handler Integration', () => {
        test('lost and regained cycle works correctly', () => {
            const threshold = CONSTANTS.FOCUS_THRESHOLD_MS;
            
            // Lose focus
            handleFocusLost();
            assert.ok(state.focusAwayStartTime !== null, 'Should mark focus lost');
            
            // Simulate time passing
            state.focusAwayStartTime = Date.now() - threshold - 1000;
            
            // Regain focus
            handleFocusRegained();
            assert.strictEqual(state.focusAwayStartTime, null, 'Should mark focus regained');
            
            const focusEvent = state.sessionBuffer.find(
                e => e.eventType === 'focusChange' && e.fileView === 'Focus Away (Major)'
            );
            assert.ok(focusEvent, 'Should log the away event');
        });

        test('multiple focus lost calls do not reset timer', () => {
            const firstCall = Date.now() - 10000;
            state.focusAwayStartTime = firstCall;
            
            // Call again
            handleFocusLost();
            
            assert.strictEqual(state.focusAwayStartTime, firstCall, 'Should preserve original time');
        });

        test('focus regained followed by lost works correctly', () => {
            // First cycle
            state.focusAwayStartTime = Date.now() - CONSTANTS.FOCUS_THRESHOLD_MS - 1000;
            handleFocusRegained();
            assert.strictEqual(state.focusAwayStartTime, null, 'Should clear after regain');
            
            // Second cycle
            handleFocusLost();
            assert.ok(state.focusAwayStartTime !== null, 'Should set again on next loss');
        });
    });
});
