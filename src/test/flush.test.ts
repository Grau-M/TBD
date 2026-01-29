// Test: flush.test.ts
// Purpose: Basic tests for the flush logic to ensure the buffer state
// transitions correctly when a flush occurs.
import * as assert from 'assert';
import { state } from '../state';
import { flushBuffer } from '../flush';

suite('Unit Tests: Flush', () => {
    setup(() => {
        state.sessionBuffer = [];
        state.isFlushing = false;
    });

    // Pushes a dummy event and verifies flushBuffer clears the buffer and resets the flushing flag
    test('flushBuffer empties buffer when storageManager is uninitialized', async () => {
        // push some dummy events
        state.sessionBuffer.push({ time: 't', flightTime: '0', eventType: 'input', fileEdit: '', fileView: '' });
        assert.ok(state.sessionBuffer.length > 0);
        await flushBuffer();
        // even though storageManager.flush is a no-op when uninitialized, flushBuffer should clear buffer
        assert.strictEqual(state.sessionBuffer.length, 0);
        assert.strictEqual(state.isFlushing, false);
    });
});
