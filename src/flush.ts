// Module: flush.ts
// Purpose: Provide a function to flush the in-memory session buffer to
// persistent storage via the StorageManager. Ensures only one concurrent
// flush runs and restores the buffer on error.
import { state, storageManager, CONSTANTS } from './state';
import { StorageManager } from './storageManager';

// Function: flushBuffer
// Purpose: Coordinate a single flush of the in-memory `state.sessionBuffer`
// to persistent storage via `storageManager.flush`. Ensures only one
// concurrent flush runs and restores the buffer on failure.
export async function flushBuffer(): Promise<void> {
    if (state.isFlushing || state.sessionBuffer.length === 0) return;
    state.isFlushing = true;
    const toSave = state.sessionBuffer.splice(0, state.sessionBuffer.length);
    try {
        await storageManager.flush(toSave);
    } catch (err) {
        console.error('[TBD Logger] Flush error:', err);
        state.sessionBuffer.unshift(...toSave);
    } finally {
        state.isFlushing = false;
    }
}
