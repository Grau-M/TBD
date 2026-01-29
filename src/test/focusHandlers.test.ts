// Test: focusHandlers.test.ts
// Purpose: Verify that focus handler helpers update `state` correctly
// and push expected events into the session buffer when focus is
// lost and regained.
import * as assert from 'assert';
import { state, CONSTANTS } from '../state';
import { handleFocusLost, handleFocusRegained } from '../handlers/focusHandlers';

suite('Unit Tests: Focus Handlers', () => {
    setup(() => {
        // reset relevant state
        state.focusAwayStartTime = null;
        state.sessionBuffer = [];
    });

    // Ensures the first call sets `focusAwayStartTime` and subsequent calls don't overwrite it
    test('handleFocusLost sets focusAwayStartTime when previously null', () => {
        assert.strictEqual(state.focusAwayStartTime, null);
        handleFocusLost();
        assert.notStrictEqual(state.focusAwayStartTime, null);
        // subsequent call does not overwrite
        const first = state.focusAwayStartTime;
        handleFocusLost();
        assert.strictEqual(state.focusAwayStartTime, first);
    });

    // Simulates an away period longer than the threshold and verifies a "Focus Away (Major)" event is logged
    test('handleFocusRegained clears focusAwayStartTime and logs major away events', () => {
        // simulate being away longer than threshold
        state.focusAwayStartTime = Date.now() - (CONSTANTS.FOCUS_THRESHOLD_MS + 1000);
        const beforeLen = state.sessionBuffer.length;
        handleFocusRegained();
        assert.strictEqual(state.focusAwayStartTime, null);
        assert.ok(state.sessionBuffer.length >= beforeLen + 1);
        const last = state.sessionBuffer[state.sessionBuffer.length - 1];
        assert.strictEqual(last.eventType, 'focusChange');
        assert.strictEqual(last.fileView, 'Focus Away (Major)');
    });
});
