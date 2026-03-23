// Module: flush.ts
// Purpose: Provide a function to flush the in-memory session buffer to
// persistent storage via the StorageManager. Ensures only one concurrent
// flush runs and restores the buffer on error.
import * as vscode from 'vscode'; 
import { getWorkspaceAuthSession } from './auth';
import { state, storageManager } from './state';

// Function: flushBuffer
// Purpose: Coordinate a single flush of the in-memory `state.sessionBuffer`
// to persistent storage via `storageManager.flush`. Ensures only one
// concurrent flush runs and restores the buffer on failure.
// Intercepts and discards logs if the user is a Teacher or Admin.

export async function flushBuffer(context?: vscode.ExtensionContext): Promise<void> {
    if (state.isFlushing || state.sessionBuffer.length === 0) {return;}
    
    if (context) {
        const session = getWorkspaceAuthSession(context);
        
        // If logged in, and NOT a student, silently discard logs
        if (session && session.authenticated && session.role !== 'Student') {
            // Clear the buffer so it doesn't grow infinitely in memory
            state.sessionBuffer.splice(0, state.sessionBuffer.length);
            return; 
        }
    } else {
        // Fallback: If context wasn't passed, we assume we should log just in case,
        // or you can adjust this behavior based on how you call flushBuffer.
        console.warn("[TBD Logger] flushBuffer called without context. Cannot verify user role.");
    }
    
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