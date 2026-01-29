import * as vscode from 'vscode';
import { state } from './state';
import { formatTimestamp } from './utils';
import { flushBuffer } from './flush';

/**
 * Detect Session Interruptions
 *
 * What it records:
 * - session_start marker (when extension activates)
 * - inactivity pause marker (after threshold)
 * - resume marker (first activity after pause)
 * - clean shutdown marker (when deactivate runs)
 * - abnormal end marker (on next startup if last run didn't cleanly shutdown)
 *
 * Rainy day support:
 * - sleep/crash/force-close => deactivate usually won't run => next startup logs abnormal end
 */
export class SessionInterruptionTracker {
    private static instance: SessionInterruptionTracker | null = null;

    private context!: vscode.ExtensionContext;
    private inactivityThresholdMs: number;
    private checkEveryMs: number;

    private lastActivityMs: number = Date.now();
    private paused: boolean = false;
    private timer: NodeJS.Timeout | null = null;

    // tiny state file (not encrypted) so we can detect abnormal ends reliably
    private readonly STATE_FILENAME = 'integrity_state.json';

    private constructor(inactivityThresholdMs: number, checkEveryMs: number) {
        this.inactivityThresholdMs = inactivityThresholdMs;
        this.checkEveryMs = checkEveryMs;
    }

    /**
     * Install the tracker. Safe to call once.
     * You will call this from extension.ts (added lines only).
     */
    static async install(
        context: vscode.ExtensionContext,
        opts?: { inactivityThresholdMs?: number; checkEveryMs?: number }
    ): Promise<void> {
        if (SessionInterruptionTracker.instance) return;

        const inactivity = opts?.inactivityThresholdMs ?? 5 * 60 * 1000; // default 5 min
        const checkEvery = opts?.checkEveryMs ?? 10_000;                 // default 10 sec

        const tracker = new SessionInterruptionTracker(inactivity, checkEvery);
        tracker.context = context;

        // 1) On startup: detect abnormal end from previous run
        await tracker.detectAbnormalEndOnStartup();

        // 2) Mark session started + set cleanShutdown=false
        tracker.logMarker('Session Started', 'Session started normally');
        await tracker.writeState({ cleanShutdown: false, lastSeenMs: Date.now() });
        void flushBuffer();

        // 3) Install "activity" listeners (lightweight)
        tracker.installActivityListeners();

        // 4) Start inactivity monitor timer
        tracker.startInactivityMonitor();

        // 5) Ensure timer is cleaned up
        context.subscriptions.push({ dispose: () => tracker.dispose() });

        SessionInterruptionTracker.instance = tracker;
    }

    /**
     * Call on deactivate to mark a clean shutdown.
     * You will call this from extension.ts (added lines only).
     */
    static markCleanShutdown(): void {
        const tracker = SessionInterruptionTracker.instance;
        if (!tracker) return;

        tracker.logMarker('Session Ended (Clean Shutdown)', 'Session shutdown cleanly.');
        void flushBuffer();
        void tracker.writeState({ cleanShutdown: true, lastSeenMs: Date.now() });
    }

    private dispose() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // --------------------------
    // Implementation details
    // --------------------------

    private logMarker(message: string, kind: string) {
        state.sessionBuffer.push({
            time: formatTimestamp(Date.now()),
            flightTime: '0',
            eventType: 'focusChange',
            fileEdit: '',
            fileView: `[INTERRUPTION] ${message}`,
            possibleAiDetection: `interruptionKind= ${kind}`
        });
    }

    private recordActivitySignal(source: string) {
        const now = Date.now();
        this.lastActivityMs = now;

        // If we were paused, first activity becomes "resume"
        if (this.paused) {
            this.paused = false;
            this.logMarker(`Session Resumed (${source})`, 'Session resumed after inactivity');
            void flushBuffer();
        }

        // best-effort update
        void this.writeState({ cleanShutdown: false, lastSeenMs: now });
    }

    private startInactivityMonitor() {
        if (this.timer) return;

        this.timer = setInterval(() => {
            const now = Date.now();
            const inactiveFor = now - this.lastActivityMs;

            if (!this.paused && inactiveFor >= this.inactivityThresholdMs) {
                this.paused = true;
                this.logMarker(
                    `Session Paused (Inactivity ${this.formatDuration(inactiveFor)})`,
                    'Session paused due to inactivity'
                );
                void flushBuffer();
                void this.writeState({ cleanShutdown: false, lastSeenMs: now });
            }
        }, this.checkEveryMs);
    }

    private installActivityListeners() {
        // Typing/editing anywhere
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(() => {
                this.recordActivitySignal('Edit');
            })
        );

        // Save events
        this.context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(() => {
                this.recordActivitySignal('Save');
            })
        );

        // Editor focus changes
        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.recordActivitySignal('Editor Focus');
            })
        );

        // Window focus changes (alt-tab)
        this.context.subscriptions.push(
            vscode.window.onDidChangeWindowState((s) => {
                if (s.focused) this.recordActivitySignal('Window Focus');
            })
        );
    }

    private async detectAbnormalEndOnStartup(): Promise<void> {
        const st = await this.readState();
        if (st && st.cleanShutdown === false) {
            // Previous session likely crashed / force-closed / sleep
            this.logMarker(
                'Session End Detected (Previous session has shutdown)',
                'The User has ended the Session'
            );
            void flushBuffer();
        }
    }

    private async getStateUri(): Promise<vscode.Uri> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (workspaceFolders && workspaceFolders.length > 0) {
            const root = workspaceFolders[0].uri;
            const vscodeDir = vscode.Uri.joinPath(root, '.vscode');
            try { await vscode.workspace.fs.createDirectory(vscodeDir); } catch { /* ignore */ }
            return vscode.Uri.joinPath(vscodeDir, this.STATE_FILENAME);
        }

        // fallback if no project folder (not portable)
        const dir = this.context.globalStorageUri;
        await vscode.workspace.fs.createDirectory(dir);
        return vscode.Uri.joinPath(dir, this.STATE_FILENAME);
    }

    private async readState(): Promise<{ cleanShutdown: boolean; lastSeenMs: number } | null> {
        try {
            const uri = await this.getStateUri();
            const data = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(data);
            const parsed = JSON.parse(text);

            if (typeof parsed?.cleanShutdown !== 'boolean') return null;
            if (typeof parsed?.lastSeenMs !== 'number') return null;

            return parsed;
        } catch {
            return null;
        }
    }

    private async writeState(stateObj: { cleanShutdown: boolean; lastSeenMs: number }): Promise<void> {
        try {
            const uri = await this.getStateUri();
            const enc = new TextEncoder();
            await vscode.workspace.fs.writeFile(uri, enc.encode(JSON.stringify(stateObj)));
        } catch {
            // ignore permissions errors; we still log interruptions best-effort
        }
    }

    private formatDuration(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
}
