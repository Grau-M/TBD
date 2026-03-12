import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension'; 

suite('Extension Integration Tests', function () {
    this.timeout(20000);

    vscode.window.showInformationMessage('Start all tests.');

    test('Edit Listener captures typing events', async () => {
        const extension = vscode.extensions.getExtension('MarcusGrau.tbd-logger');
        assert.ok(extension, 'Extension not found');

        const api = await extension.activate() as ExtensionApi;
        assert.ok(api, 'Extension API not returned');

        const doc = await vscode.workspace.openTextDocument({ content: '' });
        await vscode.window.showTextDocument(doc);

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'No active editor');
        
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), 'Hello');
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        const events = api.state.sessionBuffer;
        const editEvent = events.find(e => e.eventType === 'input' || e.eventType === 'paste' || e.eventType === 'ai-paste');
        
        assert.ok(editEvent, `Event should be buffered. Buffer length: ${events.length}`);
    });

    test('Paste Listener captures character count', async () => {
        const extension = vscode.extensions.getExtension('MarcusGrau.tbd-logger');
        const api = await extension!.activate() as ExtensionApi;
        
        const doc = await vscode.workspace.openTextDocument({ content: '' });
        await vscode.window.showTextDocument(doc);
        const editor = vscode.window.activeTextEditor!;

        const pasteContent = 'const a = 10;'; 
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), pasteContent);
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        const events = api.state.sessionBuffer;
        const pasteEvent = events.find(e => 
            (e.eventType === 'paste' || e.eventType === 'ai-paste') && 
            e.pasteCharCount === pasteContent.length
        );
        
        assert.ok(pasteEvent, 'Paste event with correct length not found');
    });
});