import { StandardEvent } from './types';
import { StorageManager } from './storageManager';

export const storageManager = new StorageManager();

export const state = {
    sessionBuffer: [] as StandardEvent[],
    lastEventTime: Date.now(),
    focusAwayStartTime: null as number | null,
    lastLoggedFileView: '',
    sessionStartTime: Date.now(),
    currentFocusedFile: '',
    focusStartTime: Date.now(),
    isFlushing: false,
};

export const CONSTANTS = {
    FOCUS_THRESHOLD_MS: 15000,
    FLUSH_INTERVAL_MS: 10000,
    FLUSH_THRESHOLD: 50,
};
