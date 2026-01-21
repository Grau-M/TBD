import * as vscode from 'vscode';

export class StorageManager {
    private context!: vscode.ExtensionContext;
    private sessionFileUri: vscode.Uri | null = null;
    private initialized = false;

    async init(context: vscode.ExtensionContext) {
        this.context = context;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        try {
            let storageDir: vscode.Uri;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspaceRoot = workspaceFolders[0].uri;
                const vscodeDir = vscode.Uri.joinPath(workspaceRoot, '.vscode');
                // ensure .vscode exists
                await vscode.workspace.fs.createDirectory(vscodeDir);
                storageDir = vscodeDir;
                console.log('[TBD Logger] Using workspace .vscode for logs:', storageDir.fsPath);
            } else {
                storageDir = context.globalStorageUri;
                await vscode.workspace.fs.createDirectory(storageDir);
                console.log('[TBD Logger] No workspace open — using global storage for logs:', storageDir.fsPath);
            }

            const ts = Date.now();
            const filename = `tbd-session-${ts}.log`;
            this.sessionFileUri = vscode.Uri.joinPath(storageDir, filename);

            // initialize file with JSON structure if missing
            let exists = true;
            try {
                await vscode.workspace.fs.stat(this.sessionFileUri);
            } catch (e) {
                exists = false;
            }

            if (!exists) {
                const header: any = { vscodeVersion: vscode.version, startTimestamp: ts };
                try {
                    const pkgUri = vscode.Uri.joinPath(context.extensionUri, 'package.json');
                    const pkgData = await vscode.workspace.fs.readFile(pkgUri);
                    const pkgText = new TextDecoder().decode(pkgData);
                    const pkg = JSON.parse(pkgText);
                    header.extensionVersion = pkg.version || 'unknown';
                } catch (err) {
                    header.extensionVersion = 'unknown';
                }

                const initial = { header, events: [] as any[] };
                const enc = new TextEncoder();
                await vscode.workspace.fs.writeFile(this.sessionFileUri, enc.encode(JSON.stringify(initial, null, 2)));
            }

            this.initialized = true;
            console.log('[TBD Logger] StorageManager initialized at', this.sessionFileUri.fsPath);
        } catch (err) {
            console.error('[TBD Logger] StorageManager init error:', err);
        }
    }

    // Append events into the `events` array of the session JSON file
    async flush(events: any[]): Promise<number> {
        if (!this.initialized || !this.sessionFileUri) {
            console.error('[TBD Logger] StorageManager not initialized; skipping flush');
            return 0;
        }
        if (!events || events.length === 0) return 0;

        try {
            // Read existing JSON file
            const data = await vscode.workspace.fs.readFile(this.sessionFileUri);
            const text = new TextDecoder().decode(data);
            let parsed: any;
            try {
                parsed = JSON.parse(text);
            } catch (err) {
                // If parsing fails, reinitialize structure
                parsed = { header: { corrupted: true, recoveredAt: Date.now() }, events: [] };
            }

            if (!Array.isArray(parsed.events)) parsed.events = [];
            parsed.events.push(...events);

            const enc = new TextEncoder();
            await vscode.workspace.fs.writeFile(this.sessionFileUri, enc.encode(JSON.stringify(parsed, null, 2)));

            console.log('[TBD Logger] Appended', events.length, 'events to', this.sessionFileUri.fsPath);
            return events.length;
        } catch (err) {
            console.error('[TBD Logger] Error flushing events:', err);
            return 0;
        }
    }
}

export default StorageManager;
