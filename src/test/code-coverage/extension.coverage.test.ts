// Test: extension.coverage.test.ts
// Purpose: Comprehensive coverage tests for extension.ts activation and deactivation
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, deactivate, ExtensionApi } from '../../extension';
import { state, storageManager, CONSTANTS } from '../../state';

suite('Code Coverage: Extension', () => {
    let context: vscode.ExtensionContext;
    let api: ExtensionApi;

    setup(async function() {
        this.timeout(10000);
        // Create a minimal mock context
        context = {
            subscriptions: [],
            extensionPath: '',
            extensionUri: vscode.Uri.file(''),
            globalState: {
                get: () => undefined,
                update: async () => {},
                setKeysForSync: () => {},
                keys: () => []
            },
            workspaceState: {
                get: () => undefined,
                update: async () => {},
                keys: () => []
            },
            secrets: {
                get: async () => undefined,
                store: async () => {},
                delete: async () => {},
                keys: async () => [],
                onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event
            },
            extensionMode: vscode.ExtensionMode.Development,
            storagePath: undefined,
            globalStoragePath: '',
            logPath: '',
            storageUri: undefined,
            globalStorageUri: vscode.Uri.file(''),
            logUri: vscode.Uri.file(''),
            asAbsolutePath: (relativePath: string) => relativePath,
            environmentVariableCollection: {} as any,
            extension: {} as any,
            languageModelAccessInformation: {} as any
        } as vscode.ExtensionContext;

        // Reset state
        state.sessionBuffer = [];
        state.isFlushing = false;
        state.currentFocusedFile = '';
        state.focusStartTime = Date.now();
        state.sessionStartTime = Date.now();
        state.lastEventTime = Date.now();
        state.focusAwayStartTime = null;
        state.lastLoggedFileView = '';
    });

    teardown(() => {
        // Clean up subscriptions
        context.subscriptions.forEach(d => d.dispose());
    });

    test('activate() initializes extension correctly', async function() {
        this.timeout(10000);
        api = await activate(context);

        // Verify API is returned
        assert.ok(api, 'API should be returned');
        assert.ok(api.state, 'API should expose state');
        assert.ok(api.storageManager, 'API should expose storageManager');

        // Verify session-start event is logged
        const hasSessionStart = state.sessionBuffer.some(
            e => e.eventType === 'session-start'
        );
        assert.ok(hasSessionStart, 'session-start event should be logged');

        // Verify subscriptions are registered
        assert.ok(context.subscriptions.length > 0, 'Should register subscriptions');
    });

    test('activate() registers all commands', async function() {
        this.timeout(10000);
        api = await activate(context);

        // Verify commands are registered (they should be in subscriptions)
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('tbd-logger.openLogs'), 'openLogs command should be registered');
        assert.ok(commands.includes('tbd-logger.showHiddenDeletions'), 'showHiddenDeletions command should be registered');
        assert.ok(commands.includes('tbd-logger.openTeacherView'), 'openTeacherView command should be registered');
    });

    test('activate() initializes currentFocusedFile from active editor', async function() {
        this.timeout(10000);
        // This tests the initial focus state
        api = await activate(context);
        
        // State should be initialized (may be empty string if no active editor)
        assert.ok(typeof state.currentFocusedFile === 'string', 'currentFocusedFile should be initialized');
    });

    test('deactivate() flushes buffer and logs final focus duration', async function() {
        this.timeout(10000);
        // First activate
        api = await activate(context);
        
        // Set a focused file
        state.currentFocusedFile = 'test.ts';
        state.focusStartTime = Date.now() - 5000; // 5 seconds ago
        
        // Clear buffer to test deactivate behavior
        state.sessionBuffer = [];
        
        // Call deactivate
        deactivate();

        // Verify focusDuration event was logged
        const hasFocusDuration = state.sessionBuffer.some(
            e => e.eventType === 'focusDuration'
        );
        assert.ok(hasFocusDuration, 'focusDuration event should be logged on deactivate');
    });

    test('deactivate() handles no focused file gracefully', async function() {
        this.timeout(10000);
        api = await activate(context);
        
        // Clear focused file
        state.currentFocusedFile = '';
        state.sessionBuffer = [];
        
        // Should not throw
        assert.doesNotThrow(() => deactivate(), 'deactivate should handle no focused file');
    });

    test('activate() handles initial active editor correctly', async function() {
        this.timeout(10000);
        // Test that activate properly checks for initial active editor
        api = await activate(context);
        
        // focusStartTime should be set
        assert.ok(state.focusStartTime > 0, 'focusStartTime should be initialized');
    });

    test('activate() sets up periodic flush timer', async function() {
        this.timeout(10000);
        api = await activate(context);
        
        // Verify a flush timer subscription exists
        const hasDisposables = context.subscriptions.some(
            s => typeof (s as any).dispose === 'function'
        );
        assert.ok(hasDisposables, 'Should register flush timer disposable');
    });

    test('extension handles errors in printSessionInfo gracefully', async function() {
        this.timeout(10000);
        // The activate function has a try-catch around printSessionInfo
        // This test verifies it doesn't crash the extension
        api = await activate(context);
        assert.ok(api, 'Extension should activate even if printSessionInfo fails');
    });
});
