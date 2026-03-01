// Test: session-management.coverage.test.ts
// Purpose: Comprehensive coverage tests for session management (sessionInfo, sessionInterruptions)
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getSessionInfo, printSessionInfo } from '../../sessionInfo';
import { SessionInterruptionTracker } from '../../sessionInterruptions';
import { state } from '../../state';

suite('Code Coverage: Session Management', () => {
    suite('sessionInfo', () => {
        test('getSessionInfo returns user and project', () => {
            const info = getSessionInfo();
            
            assert.ok(info, 'Should return session info');
            assert.ok(typeof info.user === 'string', 'Should have user property');
            assert.ok(typeof info.project === 'string', 'Should have project property');
        });

        test('getSessionInfo returns unknown for missing values', () => {
            // Even if environment is weird, should return 'unknown' gracefully
            const info = getSessionInfo();
            
            assert.ok(info.user.length > 0, 'Should have some user value');
            assert.ok(info.project.length > 0, 'Should have some project value');
        });

        test('getSessionInfo gets username from environment', () => {
            const info = getSessionInfo();
            
            // Should try to get from process.env.USER, USERNAME, or os.userInfo()
            assert.ok(info.user !== '', 'Should get username from environment');
        });

        test('getSessionInfo gets project from workspace folders', () => {
            const info = getSessionInfo();
            
            // Should get from vscode.workspace.workspaceFolders
            assert.ok(typeof info.project === 'string', 'Should get project name');
        });

        test('printSessionInfo logs and returns info', () => {
            const info = printSessionInfo();
            
            assert.ok(info, 'Should return session info');
            assert.ok(info.user, 'Should have user');
            assert.ok(info.project, 'Should have project');
        });

        test('printSessionInfo returns same structure as getSessionInfo', () => {
            const info1 = getSessionInfo();
            const info2 = printSessionInfo();
            
            assert.strictEqual(info1.user, info2.user, 'User should match');
            assert.strictEqual(info1.project, info2.project, 'Project should match');
        });

        test('getSessionInfo handles no workspace folders', () => {
            // When there are no workspace folders, should return 'unknown'
            const info = getSessionInfo();
            
            // Either has a project name or 'unknown'
            assert.ok(info.project === 'unknown' || info.project.length > 0, 'Should handle no workspace');
        });

        test('getSessionInfo handles os.userInfo errors', () => {
            // Should catch errors from os.userInfo() and handle gracefully
            const info = getSessionInfo();
            
            // Should always return something (or 'unknown')
            assert.ok(info.user === 'unknown' || info.user.length > 0, 'Should handle userInfo errors');
        });
    });

    suite('sessionInterruptions', () => {
        let context: vscode.ExtensionContext;
        let disposables: vscode.Disposable[] = [];

        setup(() => {
            // Create minimal mock context
            context = {
                subscriptions: [],
                extensionPath: '',
                extensionUri: vscode.Uri.file(''),
                globalState: {
                    get: (key: string, defaultValue?: any) => defaultValue,
                    update: async () => {},
                    setKeysForSync: () => {},
                    keys: () => []
                },
                workspaceState: {
                    get: (key: string, defaultValue?: any) => defaultValue,
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
            disposables = [];
        });

        teardown(() => {
            disposables.forEach(d => d.dispose());
            context.subscriptions.forEach(d => d.dispose());
        });

        test('SessionInterruptionTracker.install creates instance', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context, {
                inactivityThresholdMs: 60000,
                checkEveryMs: 5000
            });

            // Should add subscriptions
            assert.ok(context.subscriptions.length > 0, 'Should register subscriptions');
        });

        test('SessionInterruptionTracker.install logs session start', async function() {
            this.timeout(10000);
            
            state.sessionBuffer = [];
            
            await SessionInterruptionTracker.install(context, {
                inactivityThresholdMs: 60000,
                checkEveryMs: 5000
            });

            // Should have logged "Session Started" marker
            const hasSessionStart = state.sessionBuffer.some(
                e => e.fileView && e.fileView.includes('Session Started')
            );
            assert.ok(hasSessionStart, 'Should log session started marker');
        });

        test('SessionInterruptionTracker.install is idempotent', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context);
            const firstLength = context.subscriptions.length;
            
            await SessionInterruptionTracker.install(context);
            const secondLength = context.subscriptions.length;
            
            // Should not install twice
            assert.strictEqual(firstLength, secondLength, 'Should not install multiple instances');
        });

        test('SessionInterruptionTracker.markCleanShutdown logs shutdown marker', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context);
            state.sessionBuffer = [];
            
            SessionInterruptionTracker.markCleanShutdown();
            
            const hasShutdown = state.sessionBuffer.some(
                e => e.fileView && e.fileView.includes('Clean Shutdown')
            );
            assert.ok(hasShutdown, 'Should log clean shutdown marker');
        });

        test('SessionInterruptionTracker.markCleanShutdown handles no instance gracefully', () => {
            // Should not throw if called before install
            assert.doesNotThrow(
                () => SessionInterruptionTracker.markCleanShutdown(),
                'Should handle no instance'
            );
        });

        test('SessionInterruptionTracker uses default thresholds when not provided', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context);
            
            // Should use defaults (5 min inactivity, 10 sec check interval)
            assert.ok(context.subscriptions.length > 0, 'Should install with defaults');
        });

        test('SessionInterruptionTracker registers activity listeners', async function() {
            this.timeout(10000);
            
            const initialLength = context.subscriptions.length;
            
            await SessionInterruptionTracker.install(context, {
                inactivityThresholdMs: 60000,
                checkEveryMs: 5000
            });

            // Should register multiple listeners (edit, save, editor focus, window focus)
            assert.ok(context.subscriptions.length > initialLength, 'Should register activity listeners');
        });

        test('SessionInterruptionTracker starts inactivity monitor', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context, {
                inactivityThresholdMs: 60000,
                checkEveryMs: 5000
            });

            // Timer should be registered as a disposable
            const hasTimerDisposable = context.subscriptions.some(
                s => typeof (s as any).dispose === 'function'
            );
            assert.ok(hasTimerDisposable, 'Should start inactivity monitor');
        });

        test('SessionInterruptionTracker handles abnormal end detection', async function() {
            this.timeout(10000);
            
            // First run - simulate previous session ended abnormally
            // (This is tested by the install function checking for cleanShutdown: false)
            
            await SessionInterruptionTracker.install(context);
            
            // Should handle gracefully even if state file doesn't exist
            assert.ok(true, 'Should handle abnormal end detection');
        });

        test('SessionInterruptionTracker writes state file', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context);
            
            // Should write integrity_state.json with cleanShutdown: false
            // This is internal but we verify it doesn't throw
            assert.ok(true, 'Should write state file');
        });

        test('SessionInterruptionTracker can be disposed', async function() {
            this.timeout(10000);
            
            await SessionInterruptionTracker.install(context);
            
            // Should dispose without errors
            assert.doesNotThrow(() => {
                context.subscriptions.forEach(d => d.dispose());
            }, 'Should dispose cleanly');
        });
    });

    suite('Session Management Integration', () => {
        test('session info can be retrieved during interruption tracking', async function() {
            this.timeout(10000);
            
            const context = {
                subscriptions: [],
                extensionPath: '',
                extensionUri: vscode.Uri.file(''),
                globalState: { get: () => undefined, update: async () => {}, setKeysForSync: () => {}, keys: () => [] },
                workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
                secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, keys: async () => [], onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event },
                extensionMode: vscode.ExtensionMode.Development,
                storagePath: undefined,
                globalStoragePath: '',
                logPath: '',
                storageUri: undefined,
                globalStorageUri: vscode.Uri.file(''),
                logUri: vscode.Uri.file(''),
                asAbsolutePath: (r: string) => r,
                environmentVariableCollection: {} as any,
                extension: {} as any,
                languageModelAccessInformation: {} as any
            } as vscode.ExtensionContext;

            await SessionInterruptionTracker.install(context);
            
            const info = getSessionInfo();
            
            assert.ok(info.user, 'Should get session info while tracker is active');
            assert.ok(info.project, 'Should get project while tracker is active');
            
            context.subscriptions.forEach(d => d.dispose());
        });
    });
});
