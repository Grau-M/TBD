// Module: flush.ts
// Purpose: Provide a function to flush the in-memory session buffer to
// persistent storage via the StorageManager. Ensures only one concurrent
// flush runs and restores the buffer on error.
import * as vscode from 'vscode'; 
import { state, storageManager } from './state';

// Function: flushBuffer
// Purpose: Coordinate a single flush of the in-memory `state.sessionBuffer`
// to persistent storage via `storageManager.flush`. Ensures only one
// concurrent flush runs and restores the buffer on failure.
// Intercepts and discards logs if the user is not an authenticated Student.

export async function flushBuffer(context?: vscode.ExtensionContext): Promise<void> {
    // 👉 The Ultimate Safeguard: Block non-students AND unauthenticated users
    if (state.currentUserRole !== 'Student') {
        if (state.sessionBuffer.length > 0) {
            console.log(`[TBD Logger] Flush aborted: User role is '${state.currentUserRole}'. Emptying buffer.`);
            // Clear the buffer so it doesn't grow infinitely in memory
            state.sessionBuffer.splice(0, state.sessionBuffer.length);
        }
        return; // Abort the upload!
    }

    if (state.isFlushing || state.sessionBuffer.length === 0) {
        return;
    }
    
    state.isFlushing = true;
    
    // Safely extract the events currently sitting in the queue
    const toSave = state.sessionBuffer.splice(0, state.sessionBuffer.length);
    
    try {
        await storageManager.flush(toSave);
    } catch (err) {
        console.error('[TBD Logger] Flush error:', err);
        // Rainy Day Recovery: Restore the buffer on failure so we can try again next time
        state.sessionBuffer.unshift(...toSave);
    } finally {
        state.isFlushing = false;
    }
}