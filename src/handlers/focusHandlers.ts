// Module: handlers/focusHandlers.ts
import * as vscode from 'vscode';
import { state, CONSTANTS } from '../state';
import { formatTimestamp } from '../utils';
import { updateTrackingUI } from '../statusBar'; // 👉 NEW: Import the UI Manager

export function handleFocusLost() {
    if (!state.focusAwayStartTime) {
        state.focusAwayStartTime = Date.now();
        updateTrackingUI(); // 👈 Let the gate handle the visual!
    }
}

export function handleFocusRegained() {
    if (state.focusAwayStartTime) {
        const currentTime = Date.now();
        const timeAway = currentTime - state.focusAwayStartTime;
        state.focusAwayStartTime = null;

        if (timeAway >= CONSTANTS.FOCUS_THRESHOLD_MS) {
            state.sessionBuffer.push({
                time: formatTimestamp(currentTime),
                flightTime: String(timeAway),
                eventType: 'focusChange',
                fileEdit: '',
                fileView: 'Focus Away (Major)'
            });
        }
        updateTrackingUI(); // Instantly clear the away state visually!
    }
}