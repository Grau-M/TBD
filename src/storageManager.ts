import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getSessionInfo } from './sessionInfo';
import { formatTimestamp } from './utils';

// SECURITY CONFIGURATION
// The fixed password stored in the code, as requested.
const SECRET_PASSPHRASE = 'TBD_CAPSTONE_MASTER_KEY_2026';
const SALT = 'salty_buffer_tbd';
// We derive the actual encryption key from the fixed password
const KEY = crypto.scryptSync(SECRET_PASSPHRASE, SALT, 32); 
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;


export class StorageManager {
    private context!: vscode.ExtensionContext;
    private sessionFileUri: vscode.Uri | null = null;
    private storageDir: vscode.Uri | null = null;
    private initialized = false;

    // --- ENCRYPTION HELPERS ---
    private encrypt(text: string): Buffer {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
        const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
        // Store IV + Encrypted Data (IV is needed for decryption)
        return Buffer.concat([iv, encrypted]);
    }

    private decrypt(buffer: Uint8Array): string {
        const buf = Buffer.from(buffer);
        // Extract IV (first 16 bytes) and Content
        const iv = buf.subarray(0, IV_LENGTH);
        const content = buf.subarray(IV_LENGTH);
        
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
        const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
        return decrypted.toString();
    }

    async init(context: vscode.ExtensionContext) {
        this.context = context;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let storageDir: vscode.Uri;

        // 1. Determine Storage Location
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri;
            storageDir = vscode.Uri.joinPath(workspaceRoot, '.vscode');
            await vscode.workspace.fs.createDirectory(storageDir);
            console.log('[TBD Logger] Using workspace .vscode for logs:', storageDir.fsPath);
        } else {
            storageDir = context.globalStorageUri;
            await vscode.workspace.fs.createDirectory(storageDir);
            console.log('[TBD Logger] No workspace open — using global storage:', storageDir.fsPath);
        }

        // remember storage dir for later listing operations
        this.storageDir = storageDir;

        // Build a per-session filename: {user}-{project}-Session{n}-integrity.log
        const info = getSessionInfo();

        // Ensure storage directory exists and list files to find previous sessions
        const files = await vscode.workspace.fs.readDirectory(storageDir);
        const fileNames = files.map(f => f[0]);

        // Pattern: `${user}-${project}-Session{number}-integrity.log`
        const safeUser = info.user.replace(/[^a-zA-Z0-9-_]/g, '_');
        const safeProject = info.project.replace(/[^a-zA-Z0-9-_]/g, '_');
        const prefix = `${safeUser}-${safeProject}-Session`;
        const re = new RegExp(`^${prefix}(\\d+)-integrity\\.log$`);

        let maxSession = 0;
        for (const name of fileNames) {
            const m = name.match(new RegExp(`^${prefix}(\\d+)-integrity\\.log$`));
            if (m && m[1]) {
                const n = parseInt(m[1], 10);
                if (!isNaN(n) && n > maxSession) maxSession = n;
            }
        }

        const sessionNumber = maxSession + 1;
        const filename = `${safeUser}-${safeProject}-Session${sessionNumber}-integrity.log`;
        this.sessionFileUri = vscode.Uri.joinPath(storageDir, filename);

        // 2. Integrity Check & File Creation
        let exists = true;
        try {
            await vscode.workspace.fs.stat(this.sessionFileUri);
        } catch {
            exists = false;
        }

        if (exists) {
            try {
                // Verify we can decrypt it
                const data = await vscode.workspace.fs.readFile(this.sessionFileUri);
                const jsonStr = this.decrypt(data);
                JSON.parse(jsonStr);
                console.log('[TBD Logger] Log integrity verified.');
            } catch (err) {
                console.error('[TBD Logger] Log corruption detected! Archiving...');
                const backupUri = vscode.Uri.joinPath(storageDir, `log_corrupt_${Date.now()}.bak`);
                await vscode.workspace.fs.rename(this.sessionFileUri, backupUri);
                exists = false;
            }
        }

        if (!exists) {
            // Try to read extension version from the extension's package.json
            let extensionVersion = 'unknown';
            try {
                const pkgUri = vscode.Uri.joinPath(context.extensionUri, 'package.json');
                const raw = await vscode.workspace.fs.readFile(pkgUri);
                const pkg = JSON.parse(Buffer.from(raw).toString('utf8'));
                extensionVersion = pkg.version || extensionVersion;
            } catch (e) {
                // ignore
            }

            const startTs = Date.now();
            const formattedStart = formatTimestamp(startTs);
            const initialData = {
                sessionHeader: {
                    sessionNumber,
                    startedBy: info.user,
                    project: info.project,
                    startTime: formattedStart,
                    metadata: {
                        vscodeVersion: vscode.version,
                        startTimestamp: formattedStart,
                        extensionVersion
                    }
                },
                events: []
            };

            const encryptedData = this.encrypt(JSON.stringify(initialData, null, 2));
            await vscode.workspace.fs.writeFile(this.sessionFileUri, encryptedData);
            console.log('[TBD Logger] Created new encrypted per-session log file:', filename);
        }

        this.initialized = true;
    }

    // Used by background timer (automated)
    async flush(newEvents: any[]): Promise<void> {
        if (!this.initialized || !this.sessionFileUri) return;
        if (newEvents.length === 0) return;

        try {
            const fileData = await vscode.workspace.fs.readFile(this.sessionFileUri);
            const jsonStr = this.decrypt(fileData);
            const history = JSON.parse(jsonStr);

            if (!Array.isArray(history.events)) history.events = [];
            history.events.push(...newEvents);

            const updatedJsonStr = JSON.stringify(history, null, 2);
            const encryptedData = this.encrypt(updatedJsonStr);

            await vscode.workspace.fs.writeFile(this.sessionFileUri, encryptedData);
            console.log(`[TBD Logger] Securely appended ${newEvents.length} events.`);
        } catch (err) {
            console.error('[TBD Logger] Critical Error during flush:', err);
        }
    }

    // NEW: Used by "Open Logs" command (Manual)
    // Validates password before returning data
    async retrieveLogContent(passwordAttempt: string): Promise<string> {
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }

        if (!this.initialized || !this.sessionFileUri) {
            throw new Error('Logger not initialized');
        }

        try {
            const fileData = await vscode.workspace.fs.readFile(this.sessionFileUri);
            return this.decrypt(fileData);
        } catch (err) {
            throw new Error('Failed to read or decrypt file.');
        }
    }

    // Retrieve/decrypt a specific log file URI after validating password
    async retrieveLogContentForUri(passwordAttempt: string, fileUri: vscode.Uri): Promise<string> {
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }

        try {
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            return this.decrypt(fileData);
        } catch (err) {
            throw new Error('Failed to read or decrypt file.');
        }
    }

    // List available per-session integrity log files in storage directory
    async listLogFiles(): Promise<Array<{ label: string; uri: vscode.Uri }>> {
        if (!this.storageDir) return [];
        try {
            const files = await vscode.workspace.fs.readDirectory(this.storageDir);
            const matches: Array<{ label: string; uri: vscode.Uri }> = [];
            for (const [name] of files) {
                if (/Session\d+-integrity\.log$/.test(name)) {
                    matches.push({ label: name, uri: vscode.Uri.joinPath(this.storageDir, name) });
                }
            }
            // sort by session number ascending
            matches.sort((a, b) => {
                const na = (a.label.match(/Session(\d+)-/) || [])[1] || '0';
                const nb = (b.label.match(/Session(\d+)-/) || [])[1] || '0';
                return parseInt(na, 10) - parseInt(nb, 10);
            });
            return matches;
        } catch (e) {
            return [];
        }
    }
}