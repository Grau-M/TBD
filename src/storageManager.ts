// Module: storageManager.ts
// Purpose: Manage secure, encrypted on-disk session logs and an internal
// hidden deletion activity log. Responsibilities include creating and
// validating per-session encrypted log files, archiving copies on changes,
// recreating logs if deleted, and exposing APIs to retrieve decrypted
// contents after password validation. This module intentionally performs
// file operations via the VS Code workspace FS and handles encryption.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getSessionInfo } from './sessionInfo';
import { formatTimestamp } from './utils';

// SECURITY CONFIGURATION
// The fixed password stored in the code, as requested.
const SECRET_PASSPHRASE = 'password';
const SALT = 'salty_buffer_tbd';
// We derive the actual encryption key from the fixed password
const KEY = crypto.scryptSync(SECRET_PASSPHRASE, SALT, 32);
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;


export class StorageManager {
    private context!: vscode.ExtensionContext;
    private sessionFileUri: vscode.Uri | null = null;
    private storageDir: vscode.Uri | null = null;
    private hiddenDir: vscode.Uri | null = null;
    private hiddenLogUri: vscode.Uri | null = null;
    private archiveDir: vscode.Uri | null = null;
    private settingsWatcher: vscode.FileSystemWatcher | null = null;
    private fileIndex: Map<string, { size: number; mtime: number }> = new Map();
    private watcher: vscode.FileSystemWatcher | null = null;
    private hiddenWatcher: vscode.FileSystemWatcher | null = null;
    private initialized = false;

    // --- ENCRYPTION HELPERS ---
    // Function: encrypt
    // Purpose: Encrypt a UTF-8 string using AES-256-CBC and return a
    // Buffer that contains the IV followed by the ciphertext. The IV is
    // required for decryption and is stored in clear at the start.
    private encrypt(text: string): Buffer {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
        const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
        // Store IV + Encrypted Data (IV is needed for decryption)
        return Buffer.concat([iv, encrypted]);
    }

    // Function: decrypt
    // Purpose: Reverse the `encrypt` operation. Expects a Buffer/Uint8Array
    // containing the IV (first 16 bytes) followed by ciphertext; returns
    // the decrypted UTF-8 string. Throws if decryption fails.
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
        // Function: init
        // Purpose: Initialize storage locations, create hidden/archive
        // directories, create or verify the per-session encrypted log
        // file, and set up any file watchers. This prepares the manager
        // for subsequent read/write operations.
        this.context = context;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let storageDir: vscode.Uri;

        // 1. Determine Storage Location
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri;
            // Put integrity logs under .vscode/logs
            storageDir = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'logs');
            await vscode.workspace.fs.createDirectory(storageDir);
            console.log('[TBD Logger] Using workspace .vscode/logs for logs:', storageDir.fsPath);
            // Create an encrypted project-level settings file that lists the hide rules
            try {
                const settingsUri = vscode.Uri.joinPath(workspaceRoot, 'logger_settings.json');
                // If workspace .vscode/settings.json exists, migrate its contents into logger_settings.json
                let settingsObj: any = { filesExclude: { '.vscode/logs': true, '.vscode/logs/**': true, '.vscode/settings.json': true } };
                try {
                    const workspaceSettingsUri = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'settings.json');
                    let stat = null;
                    try {
                        stat = await vscode.workspace.fs.stat(workspaceSettingsUri);
                    } catch {
                        stat = null;
                    }
                    if (stat) {
                        const raw = await vscode.workspace.fs.readFile(workspaceSettingsUri);
                        try { settingsObj = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { /* keep defaults */ }
                        // after migrating, try to delete the workspace settings.json so it's not visible
                        try { await vscode.workspace.fs.delete(workspaceSettingsUri); } catch (_) {}
                    }
                } catch (_) {}

                const enc = this.encrypt(JSON.stringify(settingsObj, null, 2));
                await vscode.workspace.fs.writeFile(settingsUri, enc);
                // keep an encrypted backup of the logger settings in hidden dir for restoration
                try {
                    const backupUri = vscode.Uri.joinPath(this.hiddenDir!, 'logger_settings.bak');
                    await vscode.workspace.fs.writeFile(backupUri, enc);
                } catch (_) {}
                // Also apply the files.exclude to the workspace so Explorer hides the logs
                try {
                    const config = vscode.workspace.getConfiguration();
                    const filesExclude = config.get<any>('files.exclude') || {};
                    filesExclude['.vscode/logs'] = true;
                    filesExclude['.vscode/logs/**'] = true;
                    filesExclude['.vscode/settings.json'] = true;
                    await config.update('files.exclude', filesExclude, vscode.ConfigurationTarget.Workspace);
                } catch (_) {
                    // ignore inability to change workspace settings
                }
                // Watch logger_settings.json and restore if deleted
                try {
                    this.settingsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot.fsPath, 'logger_settings.json'));
                    this.settingsWatcher.onDidDelete(() => this.handleLoggerSettingsDeleted(settingsUri));
                    context.subscriptions.push(this.settingsWatcher);
                } catch (_) {}
            } catch (_) {
                // ignore settings write errors
            }
        } else {
            storageDir = vscode.Uri.joinPath(context.globalStorageUri, 'logs');
            await vscode.workspace.fs.createDirectory(storageDir);
            console.log('[TBD Logger] No workspace open — using global storage logs:', storageDir.fsPath);
        }

        // remember storage dir for later listing operations
        this.storageDir = storageDir;

        // Prepare hidden directory inside the logs folder and log which record deletions
        this.hiddenDir = vscode.Uri.joinPath(storageDir, '.tbd_hidden');
        try {
            await vscode.workspace.fs.createDirectory(this.hiddenDir);
        } catch (e) {
            // ignore
        }
        this.hiddenLogUri = vscode.Uri.joinPath(this.hiddenDir, '.undeletable_deletions.log');
        this.archiveDir = vscode.Uri.joinPath(this.hiddenDir, 'archive');
        try {
            await vscode.workspace.fs.createDirectory(this.archiveDir);
        } catch (e) {
            // ignore
        }
        // Ensure the hidden log exists and is valid
        await this.ensureHiddenLog();

        // Ensure we have a backup of logger_settings.json in the hidden dir (copy it now that hiddenDir exists)
        try {
            if (workspaceFolders && workspaceFolders.length > 0 && this.hiddenDir) {
                const workspaceRoot = workspaceFolders[0].uri;
                const settingsUri = vscode.Uri.joinPath(workspaceRoot, 'logger_settings.json');
                try {
                    const data = await vscode.workspace.fs.readFile(settingsUri);
                    const backupUri = vscode.Uri.joinPath(this.hiddenDir, 'logger_settings.bak');
                    await vscode.workspace.fs.writeFile(backupUri, data);
                } catch (_) {}
            }
        } catch (_) {}

        // NOTE: we do NOT create workspace settings here. If older runs previously added
        // files.exclude entries to hide the folder, remove only those keys now so
        // `settings.json` won't persist with our entries.
        try {
            if (workspaceFolders && workspaceFolders.length > 0) {
                const config = vscode.workspace.getConfiguration();
                const filesExclude = config.get<any>('files.exclude') || {};
                const keysToRemove = ['.vscode/.tbd_hidden', '.vscode/.tbd_hidden/**', '.vscode/.tbd_hidden/.undeletable_deletions.log'];
                let changed = false;
                for (const k of keysToRemove) {
                    if (Object.prototype.hasOwnProperty.call(filesExclude, k)) {
                        delete filesExclude[k];
                        changed = true;
                    }
                }
                if (changed) {
                    // If there are no remaining keys, clear the setting entirely so VS Code can remove it
                    if (Object.keys(filesExclude).length === 0) {
                        await config.update('files.exclude', undefined, vscode.ConfigurationTarget.Workspace);
                    } else {
                        await config.update('files.exclude', filesExclude, vscode.ConfigurationTarget.Workspace);
                    }
                }
            }
        } catch (e) {
            // ignore inability to update workspace settings
        }

        // Build a per-session filename: {user}-{project}-Session{n}-integrity.log
        const info = getSessionInfo();

        // Ensure storage directory exists and list files to find previous sessions
        const files = await vscode.workspace.fs.readDirectory(storageDir);
        const fileNames = files.map(f => f[0]);

        // Build an index of existing session logs (size + mtime) for deletion info
        for (const name of fileNames) {
            if (/Session\d+-integrity\.log$/.test(name)) {
                try {
                    const uri = vscode.Uri.joinPath(storageDir, name);
                    const stat = await vscode.workspace.fs.stat(uri);
                    this.fileIndex.set(name, { size: stat.size, mtime: stat.mtime });
                } catch (e) {
                    // ignore unreadable files
                }
            }
        }

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
            // update index for this new file
            try {
                const stat = await vscode.workspace.fs.stat(this.sessionFileUri);
                this.fileIndex.set(filename, { size: stat.size, mtime: stat.mtime });
            } catch (e) {
                // ignore
            }
            console.log('[TBD Logger] Created new encrypted per-session log file:', filename);
        }

        // Watch for deletions/changes in the storage dir for session logs
        try {
            if (this.storageDir) {
                this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.storageDir.fsPath, '*-integrity.log'));
                this.watcher.onDidDelete(uri => this.handleLogDeleted(uri));
                this.watcher.onDidCreate(uri => this.handleLogCreated(uri));
                this.watcher.onDidChange(uri => this.handleLogChanged(uri));
                context.subscriptions.push(this.watcher);

                // Watch hidden log itself so we can recreate if deleted
                if (this.hiddenDir) {
                    this.hiddenWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.hiddenDir.fsPath, '*'));
                    this.hiddenWatcher.onDidDelete(uri => this.handleHiddenLogDeleted(uri));
                    context.subscriptions.push(this.hiddenWatcher);
                }
            }
        } catch (e) {
            // some environments may not allow watchers; ignore
        }

        this.initialized = true;
    }

    // Ensure the hidden log exists and contains a JSON array
    private async ensureHiddenLog(): Promise<void> {
        // Function: ensureHiddenLog
        // Purpose: Ensure the hidden deletion activity log exists and is a
        // valid JSON structure. If the hidden log is missing or corrupt,
        // create or recreate it with an initial header and empty deletions
        // array.
        if (!this.hiddenLogUri) return;
        let exists = true;
        try {
            await vscode.workspace.fs.stat(this.hiddenLogUri);
        } catch {
            exists = false;
        }

        if (exists) {
            try {
                const data = await vscode.workspace.fs.readFile(this.hiddenLogUri);
                // try decrypt if encrypted, else parse plain
                let text = '';
                try {
                    text = this.decrypt(data);
                } catch (e) {
                    text = Buffer.from(data).toString('utf8');
                }
                // validate structure { header: {...}, deletions: [] }
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && Array.isArray(parsed.deletions)) return;
                // malformed -> backup
                throw new Error('Malformed hidden log');
            } catch (e) {
                try {
                    const backup = vscode.Uri.joinPath(this.hiddenDir!, `hidden_corrupt_${Date.now()}.bak`);
                    await vscode.workspace.fs.rename(this.hiddenLogUri, backup);
                } catch (_) {}
                exists = false;
            }
        }

        if (!exists) {
            const initial = {
                header: { createdAt: formatTimestamp(Date.now()), note: 'Deletion activity log' },
                deletions: [] as any[]
            };
            const buf = this.encrypt(JSON.stringify(initial, null, 2));
            await vscode.workspace.fs.writeFile(this.hiddenLogUri, buf);
        }
    }

    // Restore logger_settings.json from backup in hidden dir (or recreate defaults)
    private async handleLoggerSettingsDeleted(settingsUri: vscode.Uri) {
        // Function: handleLoggerSettingsDeleted
        // Purpose: Attempt to restore `logger_settings.json` from a
        // backup stored in the hidden directory; if no backup exists,
        // recreate a sensible default and reapply files.exclude.
        try {
            const backupUri = vscode.Uri.joinPath(this.hiddenDir!, 'logger_settings.bak');
            let written = false;
            try {
                const data = await vscode.workspace.fs.readFile(backupUri);
                await vscode.workspace.fs.writeFile(settingsUri, data);
                written = true;
            } catch (_) {
                // backup missing or unreadable
            }

            if (!written) {
                // recreate a default settings file (encrypted)
                const defaultObj = { filesExclude: { '.vscode/logs': true, '.vscode/logs/**': true, '.vscode/settings.json': true } };
                const enc = this.encrypt(JSON.stringify(defaultObj, null, 2));
                try { await vscode.workspace.fs.writeFile(settingsUri, enc); } catch (_) {}
            }
            // reapply files.exclude in workspace settings
            try {
                const config = vscode.workspace.getConfiguration();
                const filesExclude = config.get<any>('files.exclude') || {};
                filesExclude['.vscode/logs'] = true;
                filesExclude['.vscode/logs/**'] = true;
                filesExclude['.vscode/settings.json'] = true;
                await config.update('files.exclude', filesExclude, vscode.ConfigurationTarget.Workspace);
            } catch (_) {}
        } catch (e) {
            // ignore
        }
    }

    private async appendToHiddenLog(entry: any): Promise<void> {
        // Function: appendToHiddenLog
        // Purpose: Read the hidden log, append an entry to its
        // `deletions` array, and write the file back encrypted. If the
        // file is missing or append fails, recreate it with the single
        // provided entry.
        if (!this.hiddenLogUri) return;
        try {
            let data = await vscode.workspace.fs.readFile(this.hiddenLogUri);
            let text = '';
            try { text = this.decrypt(data); } catch { text = Buffer.from(data).toString('utf8'); }
            let obj: any = { header: { createdAt: formatTimestamp(Date.now()), note: 'Deletion activity log' }, deletions: [] };
            try { obj = JSON.parse(text); } catch { obj = obj; }
            if (!Array.isArray(obj.deletions)) obj.deletions = [];
            obj.deletions.push(entry);
            const buf = this.encrypt(JSON.stringify(obj, null, 2));
            await vscode.workspace.fs.writeFile(this.hiddenLogUri, buf);
        } catch (e) {
            // If append fails because file missing, recreate with a single entry
            const obj = { header: { createdAt: formatTimestamp(Date.now()), note: 'Deletion activity log' }, deletions: [entry] };
            const buf = this.encrypt(JSON.stringify(obj, null, 2));
            await vscode.workspace.fs.writeFile(this.hiddenLogUri, buf);
        }
    }

    // Format bytes into human readable using KB/MB/GB with KB as smallest unit
    private formatSize(bytes: number): string {
        // Function: formatSize
        // Purpose: Convert a numeric byte count into a human-readable
        // string using KB/MB/GB units, rounding to two decimals.
        const KB = 1024;
        if (!bytes || bytes <= 0) return '0 KB';
        if (bytes < KB) return '1 KB';
        const mb = KB * KB;
        const gb = mb * KB;
        if (bytes < mb) return `${(bytes / KB).toFixed(2)} KB`;
        if (bytes < gb) return `${(bytes / mb).toFixed(2)} MB`;
        return `${(bytes / gb).toFixed(2)} GB`;
    }

    private async handleLogCreated(uri: vscode.Uri) {
        // Function: handleLogCreated
        // Purpose: Track metadata for a newly created log file and store
        // an archived copy in the archive directory for later recovery.
        try {
            const name = uri.path.split('/').pop() || '';
            const stat = await vscode.workspace.fs.stat(uri);
            this.fileIndex.set(name, { size: stat.size, mtime: stat.mtime });
            // Archive a copy of the file so we can recover contents on deletion
            try {
                if (this.archiveDir) {
                    const data = await vscode.workspace.fs.readFile(uri);
                    const archiveUri = vscode.Uri.joinPath(this.archiveDir, name);
                    await vscode.workspace.fs.writeFile(archiveUri, data);
                }
            } catch (e) {
                // ignore archive failures
            }
        } catch (e) {}
    }

    private async handleLogChanged(uri: vscode.Uri) {
        // Function: handleLogChanged
        // Purpose: Update the internal index when a log file changes and
        // refresh the archived copy to keep a recent backup.
        try {
            const name = uri.path.split('/').pop() || '';
            const stat = await vscode.workspace.fs.stat(uri);
            this.fileIndex.set(name, { size: stat.size, mtime: stat.mtime });
            // Update archived copy when file changes
            try {
                if (this.archiveDir) {
                    const data = await vscode.workspace.fs.readFile(uri);
                    const archiveUri = vscode.Uri.joinPath(this.archiveDir, name);
                    await vscode.workspace.fs.writeFile(archiveUri, data);
                }
            } catch (e) {
                // ignore
            }
        } catch (e) {}
    }

    private async handleLogDeleted(uri: vscode.Uri) {
        // Function: handleLogDeleted
        // Purpose: When a per-session integrity log is deleted, record a
        // deletion entry in the hidden log, attempt to recreate a minimal
        // file at the same path (to preserve session continuity), and
        // remove it from the internal index.
        const name = uri.path.split('/').pop() || uri.fsPath;
        const recorded = this.fileIndex.get(name) || { size: 0, mtime: 0 };
        const entry = {
            deletedFile: name,
            deletedAt: formatTimestamp(Date.now()),
            // lastKnownSize: recorded.size,
            lastKnownSize: this.formatSize(recorded.size)
            // lastKnownSizeHuman: this.formatSize(recorded.size),
            // lastKnownMtime: recorded.mtime
        };

        try {
            await this.appendToHiddenLog(entry);
        } catch (e) {
            // ignore
        }
        // Recreate a minimal file at same name containing a header that notes the file
        // was previously deleted and then the standard session header. New events
        // will be appended to this file later by normal flush logic.
        try {
            if (this.storageDir) {
                const recreateUri = vscode.Uri.joinPath(this.storageDir, name);
                // Build a header similar to initial creation
                const info = getSessionInfo();
                const startTs = Date.now();
                const formattedStart = formatTimestamp(startTs);
                // try to read extension version
                let extensionVersion = 'unknown';
                try {
                    const pkgUri = vscode.Uri.joinPath(this.context.extensionUri, 'package.json');
                    const raw = await vscode.workspace.fs.readFile(pkgUri);
                    const pkg = JSON.parse(Buffer.from(raw).toString('utf8'));
                    extensionVersion = pkg.version || extensionVersion;
                } catch (_) {}

                // Try to extract session number from filename
                let sessionNumber = 0;
                try {
                    const m = name.match(/Session(\d+)-/);
                    if (m && m[1]) sessionNumber = parseInt(m[1], 10);
                } catch (_) {}

                const initialData = {
                    recreationNotice: `This file was previously deleted on ${entry.deletedAt}. New data for this session will be appended below.`,
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
                    events: [] as any[]
                };

                const enc = this.encrypt(JSON.stringify(initialData, null, 2));
                await vscode.workspace.fs.writeFile(recreateUri, enc);
                try { const stat = await vscode.workspace.fs.stat(recreateUri); this.fileIndex.set(name, { size: stat.size, mtime: stat.mtime }); } catch {}
            }
        } catch (e) {
            // ignore
        }

        // Remove from index
        try { this.fileIndex.delete(name); } catch (_) {}
    }

    private async handleHiddenLogDeleted(uri: vscode.Uri) {
        // Function: handleHiddenLogDeleted
        // Purpose: Ensure that deletion of the hidden log itself is
        // recorded — try to append a record, and if append fails create a
        // new hidden log containing the deletion entry.
        // The hidden log was deleted — recreate with a record of that deletion
        const name = uri.path.split('/').pop() || 'hidden_log';
        const entry = { note: 'Hidden log file deleted', file: name, deletedAt: formatTimestamp(Date.now()) };
        try {
            await this.appendToHiddenLog(entry);
        } catch (e) {
            // If append fails because file missing, create a new file with the entry
            if (this.hiddenLogUri) {
                const obj = { header: { createdAt: formatTimestamp(Date.now()), note: 'Deletion activity log' }, deletions: [entry] };
                const buf = this.encrypt(JSON.stringify(obj, null, 2));
                try { await vscode.workspace.fs.writeFile(this.hiddenLogUri, buf); } catch (_) {}
            }
        }
    }

    // Public: retrieve decrypted array of hidden deletion entries (validates password)
    async retrieveHiddenEntries(passwordAttempt: string): Promise<any[]> {
        // Function: retrieveHiddenEntries
        // Purpose: Validate the supplied password and return the parsed
        // array of deletion entries from the hidden deletion activity log.
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }
        if (!this.hiddenLogUri) return [];
        try {
            const data = await vscode.workspace.fs.readFile(this.hiddenLogUri);
            const json = this.decrypt(data);
            const obj = JSON.parse(json);
            return Array.isArray(obj.deletions) ? obj.deletions : [];
        } catch (e) {
            throw new Error('Failed to read hidden log');
        }
    }

    // Public: retrieve decrypted full deletion activity log JSON string (validates password)
    async retrieveHiddenLogContent(passwordAttempt: string): Promise<string> {
        // Function: retrieveHiddenLogContent
        // Purpose: Return the full decrypted JSON string of the hidden
        // deletion activity log after validating the provided password.
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }
        if (!this.hiddenLogUri) return '';
        try {
            const data = await vscode.workspace.fs.readFile(this.hiddenLogUri);
            const json = this.decrypt(data);
            return json;
        } catch (e) {
            throw new Error('Failed to read hidden log');
        }
    }

    // Used by background timer (automated)
    async flush(newEvents: any[]): Promise<void> {
        // Function: flush
        // Purpose: Append `newEvents` to the on-disk per-session encrypted
        // file. No-op if the manager is not initialized. Errors are logged
        // but do not throw to callers.
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
        // Function: retrieveLogContent
        // Purpose: Return decrypted content of the current session file
        // after validating the administrator password.
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
        // Function: retrieveLogContentForUri
        // Purpose: Decrypt and return the contents of the provided file
        // URI after successful password validation. Throws descriptive
        // errors on failure.
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
        // Function: listLogFiles
        // Purpose: Return an ordered list of per-session integrity log
        // files located in the configured storage directory. Each item
        // contains a label and the corresponding `vscode.Uri`.
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