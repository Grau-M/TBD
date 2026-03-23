// Module: state.ts
// Purpose: Central in-memory state and constants used across the extension.
// Exports a shared `state` object used by listeners and handlers, a
// `storageManager` singleton instance responsible for API-backed persistence,
// and configuration `CONSTANTS` for thresholds and intervals.
import { StandardEvent } from './types';
import { ApiStorageManager } from './apiStorageManager';

export const storageManager = new ApiStorageManager();

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
    isConsentGiven: false,
    currentUserRole: 'None' as 'Student' | 'Teacher' | 'Admin' | 'None', // track the current user's role 
};

export const CONSTANTS = {
    FOCUS_THRESHOLD_MS: 15000,
    FLUSH_INTERVAL_MS: 10000,
    FLUSH_THRESHOLD: 50,
};
