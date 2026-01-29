import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension'; 

suite('Extension Integration Tests', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Edit Listener captures typing events', async () => {
        // 1. GET THE REAL EXTENSION INSTANCE
        const extension = vscode.extensions.getExtension('MarcusGrau.tbd-logger');
        assert.ok(extension, 'Extension not found');

        // 2. ACTIVATE TO GET THE API
        const api = await extension.activate() as ExtensionApi;
        assert.ok(api, 'Extension API not returned');

        // 3. Create and open a new temporary file
        const doc = await vscode.workspace.openTextDocument({ content: '' });
        await vscode.window.showTextDocument(doc);

        // 4. Simulate typing "Hello"
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'No active editor');
        
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), 'Hello');
        });

        // 5. Wait for listener to process
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 6. CHECK THE REAL BUFFER
        const events = api.state.sessionBuffer;
        const editEvent = events.find(e => e.eventType === 'input' || e.eventType === 'paste' || e.eventType === 'ai-paste');
        
        assert.ok(editEvent, `Event should be buffered. Buffer length: ${events.length}`);
    });

    test('Paste Listener captures character count', async () => {
        // 1. Setup
        const extension = vscode.extensions.getExtension('MarcusGrau.tbd-logger');
        const api = await extension!.activate() as ExtensionApi;
        
        const doc = await vscode.workspace.openTextDocument({ content: '' });
        await vscode.window.showTextDocument(doc);
        const editor = vscode.window.activeTextEditor!;

        // 2. Simulate Paste
        const pasteContent = 'const a = 10;'; // 13 characters
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), pasteContent);
        });

        // 3. Wait
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 4. Verify via API
        const events = api.state.sessionBuffer;

        // FIX: Find the SPECIFIC event matching our content length
        // This ignores the "Hello" event (5 chars) from the previous test
        const pasteEvent = events.find(e => 
            (e.eventType === 'paste' || e.eventType === 'ai-paste') && 
            e.pasteCharCount === pasteContent.length
        );
        
        assert.ok(pasteEvent, 'Paste event with correct length not found');
        assert.strictEqual(pasteEvent?.pasteCharCount, pasteContent.length, 'Character count mismatch'); 
    });
});