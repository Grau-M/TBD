// Test: state.test.ts
// Purpose: Basic assertions about the exported `state` object and
// `CONSTANTS` to guard against accidental shape regressions.
import * as assert from 'assert';
import { state, CONSTANTS } from '../state';

suite('Unit Tests: State', () => {
    // Checks core `state` shape and field types to guard against regressions
    test('default state keys exist and types are correct', () => {
        assert.ok(Array.isArray(state.sessionBuffer));
        assert.ok(typeof state.lastEventTime === 'number');
        assert.ok(typeof state.sessionStartTime === 'number');
        assert.ok(typeof state.isFlushing === 'boolean');
    });

    // Ensures exported `CONSTANTS` values are numeric and present
    test('CONSTANTS contains expected numeric values', () => {
        assert.ok(typeof CONSTANTS.FOCUS_THRESHOLD_MS === 'number');
        assert.ok(typeof CONSTANTS.FLUSH_INTERVAL_MS === 'number');
        assert.ok(typeof CONSTANTS.FLUSH_THRESHOLD === 'number');
    });
});
