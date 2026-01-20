// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
// Define the shape of a single keystroke event
interface KeystrokeEvent {
    timestamp: number;       // Unix timestamp (when it happened)
    flightTime: number;      // Time (ms) since the last keypress
    eventType: 'input' | 'paste' | 'delete' | 'undo'; // What kind of action?
    documentName: string;    // Which file are they working on?
    changeLength: number;    // How many chars changed?
}

// Create a buffer to hold data in memory before saving
let sessionBuffer: KeystrokeEvent[] = [];
let lastKeystrokeTime: number = Date.now();
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    console.log('Keystroke Tracker is active!');

    // 1. Register the Event Listener
    // This fires every time the user types, pastes, or deletes
    let listener = vscode.workspace.onDidChangeTextDocument((event) => {
        
        // Ignore changes that aren't user interactions (e.g., output window updates)
        if (event.contentChanges.length === 0) { return; }

        const currentTime = Date.now();
        const timeDiff = currentTime - lastKeystrokeTime;

        // update the last time for the next event
        lastKeystrokeTime = currentTime;

        // 2. Analyze the Change
        // contentChanges is an array, but usually has 1 item for typing
        event.contentChanges.forEach((change) => {
            
            let eventType: 'input' | 'paste' | 'delete' | 'undo';

            // Heuristics to determine event type
            if (change.text === '' && change.rangeLength > 0) {
                eventType = 'delete';
            } else if (change.text.length > 1) {
                // If more than 1 char is added at once, it's likely a paste or autocomplete
                eventType = 'paste';
            } else {
                eventType = 'input';
            }

            // 3. Create the Log Object
            const logEntry: KeystrokeEvent = {
                timestamp: currentTime,
                flightTime: timeDiff,
                eventType: eventType,
                documentName: event.document.fileName,
                changeLength: change.text.length || change.rangeLength // Length of add or delete
            };

            // 4. Push to Buffer (and print for debugging)
            sessionBuffer.push(logEntry);
            console.log(`[${eventType.toUpperCase()}] Flight Time: ${timeDiff}ms`);
        });
    });

    // 5. Add to subscriptions so it gets cleaned up when VS Code closes
    context.subscriptions.push(listener);
}

// This method is called when your extension is deactivated
export function deactivate() {
	// for the further development: save sessionBuffer to a file or remote server
	console.log("Session ended. Total events captured: " + sessionBuffer.length);
}
