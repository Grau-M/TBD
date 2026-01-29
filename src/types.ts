// Module: types.ts
// Purpose: Type and interface definitions used by the extension's
// telemetry and logging system. `StandardEvent` represents a single
// recorded user interaction including timing, event classification,
// and optional metadata for AI detection and paste counts.
// Type: StandardEvent
// Purpose: Represents a single recorded interaction event. Fields
// include timing, event classification, file context, and optional
// metadata used for AI detection heuristics and paste counting.
export interface StandardEvent {
    time: string;
    flightTime: string;
    eventType: 'input' | 'paste' | 'delete' | 'replace' | 'undo' | 'focusChange' | 'focusDuration' | 'save' | 'ai-paste' | 'ai-delete' | 'ai-replace' | 'session-start';
    fileEdit: string;
    fileView: string;
    possibleAiDetection?: string;
    fileFocusCount?: string;
    pasteCharCount?: number;
}
