export interface StandardEvent {
    time: string;
    flightTime: string;
    eventType: 'input' | 'paste' | 'delete' | 'replace' | 'undo' | 'focusChange' | 'focusDuration' | 'save' | 'ai-paste' | 'ai-delete' | 'ai-replace';
    fileEdit: string;
    fileView: string;
    possibleAiDetection?: string;
    fileFocusCount?: string;
}
