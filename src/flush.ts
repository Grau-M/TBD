import { state, storageManager, CONSTANTS } from './state';
import { StorageManager } from './storageManager';

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
