// Module: state.ts
// Purpose: Central in-memory state and constants used across the extension.
// Exports a shared `state` object used by listeners and handlers, a
// `storageManager` singleton instance responsible for database persistence,
// and configuration `CONSTANTS` for thresholds and intervals.
import { StandardEvent } from './types';
import { DbStorageManager } from './dbStorageManager';

export const storageManager = new DbStorageManager();

export const state = {
    sessionBuffer: [] as StandardEvent[],
    lastEventTime: Date.now(),
    focusAwayStartTime: null as number | null,
    lastLoggedFileView: '',
    sessionStartTime: Date.now(),
    currentFocusedFile: '',
    focusStartTime: Date.now(),
    isFlushing: false,
    clipboardOnBlur: '', 
    externalCopiedText: '',
};

export const CONSTANTS = {
    FOCUS_THRESHOLD_MS: 15000,
    FLUSH_INTERVAL_MS: 10000,
    FLUSH_THRESHOLD: 50,
};
