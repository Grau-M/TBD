import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { StandardEvent } from './types';
import { API_BASE, ApiHttpError, apiGet, apiPatch, apiPost, apiPut } from './api';

interface ApiSyncStatus {
    state: 'synced' | 'syncing' | 'offline' | 'queue-warning' | 'conflict' | 'idle';
    pendingQueueCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
    lastConflictAt: string | null;
}

export type UserRole = 'Student' | 'Teacher' | 'Admin';

interface StudentWorkspaceLinkRecord {
    studentId: number | null;
    studentWorkspaceFullPath: string | null;
    studentWorkspaceName: string | null;
    classId: number | null;
    classAssignmentId: number | null;
    className: string | null;
    classAssignmentName: string | null;
    recordIdentifier: string | null;
}

export class ApiStorageManager {
    private context: vscode.ExtensionContext | null = null;
    private syncStatus: ApiSyncStatus = {
        state: 'idle',
        pendingQueueCount: 0,
        lastSyncedAt: null,
        lastError: null,
        lastConflictAt: null
    };

    // --- ENCRYPTED OFFLINE QUEUE CONFIGURATION ---
    private readonly SECRET_PASSPHRASE = 'password';
    private readonly SALT = 'salty_buffer_tbd';
    private readonly ALGORITHM = 'aes-256-cbc';
    private readonly IV_LENGTH = 16;
    
    private get KEY() { 
        return crypto.scryptSync(this.SECRET_PASSPHRASE, this.SALT, 32); 
    }

    private getQueueUri(): vscode.Uri | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (!workspaceFolders || workspaceFolders.length === 0) {
            // Fallback to global storage if no workspace is active
            return this.context ? vscode.Uri.joinPath(this.context.globalStorageUri, 'tbd_offline_queue.enc') : null;
        }
        
        // Target the active workspace's .vscode/logs directory
        const workspaceRoot = workspaceFolders[0].uri;
        return vscode.Uri.joinPath(workspaceRoot, '.vscode', 'logs', 'tbd_offline_queue.enc');
    }

    private encrypt(text: string): Buffer {
        const iv = crypto.randomBytes(this.IV_LENGTH);
        const cipher = crypto.createCipheriv(this.ALGORITHM, this.KEY, iv);
        const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, encrypted]);
    }

    private decrypt(buffer: Uint8Array): string {
        const buf = Buffer.from(buffer);
        if (buf.length < this.IV_LENGTH) {
            return '[]';
        }
        const iv = buf.subarray(0, this.IV_LENGTH);
        const content = buf.subarray(this.IV_LENGTH);
        const decipher = crypto.createDecipheriv(this.ALGORITHM, this.KEY, iv);
        const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
        return decrypted.toString('utf8');
    }

    private async readQueue(): Promise<any[]> {
        const uri = this.getQueueUri();
        if (!uri) {
            return [];
        }
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const jsonStr = this.decrypt(data);
            const parsed = JSON.parse(jsonStr);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

   private async writeQueue(events: any[]): Promise<void> {
        const uri = this.getQueueUri();
        if (!uri) {
            return;
        }
        
        try {
            // Ensure the .vscode/logs directory exists before attempting to write
            const logsDir = vscode.Uri.joinPath(uri, '..');
            await vscode.workspace.fs.createDirectory(logsDir);
        } catch (e) {
            console.warn('[TBD Logger] Could not create .vscode/logs directory', e);
        }

        if (events.length === 0) {
            // Clear file if the queue successfully emptied (synced to cloud)
            try {
                await vscode.workspace.fs.delete(uri);
            } catch (e) {
                // ignore delete errors
            }
            return;
        }

        // Encrypt and write the offline events to the workspace logs folder
        const data = this.encrypt(JSON.stringify(events));
        await vscode.workspace.fs.writeFile(uri, data);
    }
    // ---------------------------------------------

    private normalizeRole(value: unknown): UserRole {
        const v = String(value || '').trim().toLowerCase();
        if (v === 'teacher') { return 'Teacher'; }
        if (v === 'admin') { return 'Admin'; }
        return 'Student';
    }

    private normalizeEmail(value: unknown): string {
        return String(value || '').trim().toLowerCase();
    }

    private titleCaseName(value: unknown): string {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\b([a-z])/g, (_match, letter: string) => letter.toUpperCase())
            .replace(/\s+/g, ' ');
    }

    private pick(obj: any, keys: string[]): any {
        if (!obj || typeof obj !== 'object') {
            return undefined;
        }
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null) {
                return obj[key];
            }
        }

        const lowerKeyMap = new Map<string, string>();
        for (const key of Object.keys(obj)) {
            if (!lowerKeyMap.has(key.toLowerCase())) {
                lowerKeyMap.set(key.toLowerCase(), key);
            }
        }

        for (const key of keys) {
            const matchedKey = lowerKeyMap.get(key.toLowerCase());
            if (matchedKey && obj[matchedKey] !== undefined && obj[matchedKey] !== null) {
                return obj[matchedKey];
            }
        }

        return undefined;
    }

    private generateJoinCode(): string {
        const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let suffix = '';
        for (let i = 0; i < 6; i++) {
            suffix += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return `TBD-${suffix}`;
    }

    private generateWorkspaceId(classAssignmentId: number, workspaceRootPath: string, workspaceName: string): number {
        const source = `${classAssignmentId}|${workspaceRootPath}|${workspaceName}`;
        let hash = 2166136261;
        for (let index = 0; index < source.length; index++) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        const workspaceId = hash >>> 0;
        return workspaceId > 0 ? workspaceId : 1;
    }

    private parsePositiveInteger(value: unknown): number | undefined {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }

    private getStudentWorkspaceLinkContainerUri(): vscode.Uri | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }

        return vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'workspace');
    }

    private getStudentWorkspaceLinkFileUri(): vscode.Uri | undefined {
        const containerUri = this.getStudentWorkspaceLinkContainerUri();
        if (!containerUri) {
            return undefined;
        }

        return vscode.Uri.joinPath(containerUri, 'studentWorkspaceLink.json');
    }

    private createEmptyStudentWorkspaceLinkRecord(): StudentWorkspaceLinkRecord {
        return {
            studentId: null,
            studentWorkspaceFullPath: null,
            studentWorkspaceName: null,
            classId: null,
            classAssignmentId: null,
            className: null,
            classAssignmentName: null,
            recordIdentifier: null
        };
    }

    private normalizeStudentWorkspaceLinkRecord(input: {
        studentId?: number;
        studentWorkspaceFullPath?: string;
        studentWorkspaceName?: string;
        classId?: number;
        classAssignmentId?: number;
        className?: string;
        classAssignmentName?: string;
        recordIdentifier?: string;
    }): StudentWorkspaceLinkRecord {
        const studentId = this.parsePositiveInteger(input.studentId) ?? null;
        const studentWorkspaceFullPath = String(input.studentWorkspaceFullPath || '').trim() || null;
        const studentWorkspaceName = String(input.studentWorkspaceName || '').trim() || null;
        const classId = this.parsePositiveInteger(input.classId) ?? null;
        const classAssignmentId = this.parsePositiveInteger(input.classAssignmentId) ?? null;
        const className = String(input.className || '').trim() || null;
        const classAssignmentName = String(input.classAssignmentName || '').trim() || null;
        const recordIdentifier = String(input.recordIdentifier || '').trim() || (
            studentId !== null &&
            studentWorkspaceFullPath !== null &&
            studentWorkspaceName !== null &&
            classId !== null &&
            classAssignmentId !== null &&
            className !== null &&
            classAssignmentName !== null
        )
            ? `${studentId}|${studentWorkspaceFullPath}|${studentWorkspaceName}|${classId}|${classAssignmentId}|${className}|${classAssignmentName}`
            : null;

        return {
            studentId,
            studentWorkspaceFullPath,
            studentWorkspaceName,
            classId,
            classAssignmentId,
            className,
            classAssignmentName,
            recordIdentifier
        };
    }

    private isCompleteStudentWorkspaceLinkRecord(record: StudentWorkspaceLinkRecord): boolean {
        return [
            record.studentId,
            record.studentWorkspaceFullPath,
            record.studentWorkspaceName,
            record.classId,
            record.classAssignmentId,
            record.className,
            record.classAssignmentName,
            record.recordIdentifier
        ].every((value) => value !== null && String(value).trim().length > 0);
    }

    private async readStudentWorkspaceLinkRecord(): Promise<StudentWorkspaceLinkRecord | null> {
        const fileUri = this.getStudentWorkspaceLinkFileUri();
        if (!fileUri) {
            return null;
        }

        try {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
            if (!parsed || typeof parsed !== 'object') {
                return null;
            }

            return this.normalizeStudentWorkspaceLinkRecord({
                studentId: parsed.studentId,
                studentWorkspaceFullPath: parsed.studentWorkspaceFullPath,
                studentWorkspaceName: parsed.studentWorkspaceName,
                classId: parsed.classId,
                classAssignmentId: parsed.classAssignmentId,
                className: parsed.className,
                classAssignmentName: parsed.classAssignmentName,
                recordIdentifier: parsed.recordIdentifier
            });
        } catch {
            return null;
        }
    }

    private async ensureStudentWorkspaceLinkFile(): Promise<void> {
        const fileUri = this.getStudentWorkspaceLinkFileUri();
        const containerUri = this.getStudentWorkspaceLinkContainerUri();
        if (!fileUri || !containerUri) {
            return;
        }

        await vscode.workspace.fs.createDirectory(containerUri);

        try {
            await vscode.workspace.fs.stat(fileUri);
        } catch {
            const initialRecord = this.createEmptyStudentWorkspaceLinkRecord();
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(initialRecord, null, 2), 'utf8'));
        }
    }

    private async writeStudentWorkspaceLinkFile(record: StudentWorkspaceLinkRecord, showNotification = false): Promise<void> {
        const fileUri = this.getStudentWorkspaceLinkFileUri();
        const containerUri = this.getStudentWorkspaceLinkContainerUri();
        if (!fileUri || !containerUri) {
            return;
        }

        const existingRecord = await this.readStudentWorkspaceLinkRecord();
        if (
            existingRecord &&
            existingRecord.recordIdentifier &&
            record.recordIdentifier &&
            existingRecord.recordIdentifier === record.recordIdentifier &&
            this.isCompleteStudentWorkspaceLinkRecord(existingRecord) &&
            this.isCompleteStudentWorkspaceLinkRecord(record)
        ) {
            return;
        }

        await vscode.workspace.fs.createDirectory(containerUri);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(record, null, 2), 'utf8'));
    }

    async syncStudentWorkspaceLinkRecord(input: {
        studentId?: number;
        studentWorkspaceFullPath?: string;
        studentWorkspaceName?: string;
        classId?: number;
        classAssignmentId?: number;
        className?: string;
        classAssignmentName?: string;
        showNotification?: boolean;
    }): Promise<void> {
        const record = this.normalizeStudentWorkspaceLinkRecord({
            studentId: input.studentId,
            studentWorkspaceFullPath: input.studentWorkspaceFullPath,
            studentWorkspaceName: input.studentWorkspaceName,
            classId: input.classId,
            classAssignmentId: input.classAssignmentId,
            className: input.className,
            classAssignmentName: input.classAssignmentName
        });

        await this.writeStudentWorkspaceLinkFile(record, false);
    }

    private async getStudentWorkspaceLinkRecord(): Promise<StudentWorkspaceLinkRecord | null> {
        const record = await this.readStudentWorkspaceLinkRecord();
        if (!record || !this.isCompleteStudentWorkspaceLinkRecord(record)) {
            return null;
        }

        return record;
    }

    private async apiGetFirst(paths: string[]): Promise<any> {
        let lastError: unknown;
        const tried: string[] = [];
        for (const path of paths) {
            tried.push(path);
            try {
                return await apiGet(path, { silent: true });
            } catch (error) {
                if (error instanceof ApiHttpError && error.status === 404) {
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }
        if (lastError instanceof ApiHttpError) {
            throw new Error(`API GET 404. Tried routes: ${tried.join(', ')}. Last response: ${lastError.responseBody || 'Not Found'}`);
        }
        throw lastError || new Error('No matching API GET route found.');
    }

    private async apiPostFirst(paths: string[], body: any): Promise<any> {
        let lastError: unknown;
        const tried: string[] = [];
        for (const path of paths) {
            tried.push(path);
            try {
                return await apiPost(path, body, { silent: true });
            } catch (error) {
                if (error instanceof ApiHttpError && error.status === 404) {
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }
        if (lastError instanceof ApiHttpError) {
            throw new Error(`API POST 404. Tried routes: ${tried.join(', ')}. Last response: ${lastError.responseBody || 'Not Found'}`);
        }
        throw lastError || new Error('No matching API POST route found.');
    }

    private async apiPutFirst(paths: string[], body: any): Promise<any> {
        let lastError: unknown;
        const tried: string[] = [];
        for (const path of paths) {
            tried.push(path);
            try {
                return await apiPut(path, body, { silent: true });
            } catch (error) {
                if (error instanceof ApiHttpError && error.status === 404) {
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }
        if (lastError instanceof ApiHttpError) {
            throw new Error(`API PUT 404. Tried routes: ${tried.join(', ')}. Last response: ${lastError.responseBody || 'Not Found'}`);
        }
        throw lastError || new Error('No matching API PUT route found.');
    }

    async init(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        this.syncStatus.state = 'synced';
        this.syncStatus.lastError = null;
        
        // Restore the last synced time from permanent storage
        const savedSyncTime = context.workspaceState.get<string>('tbd.lastSyncedAt');
        if (savedSyncTime) {
            this.syncStatus.lastSyncedAt = savedSyncTime;
        }
           
        try {
            await this.ensureStudentWorkspaceLinkFile();
        } catch {
            // Ignore hidden file bootstrap failures.
        }

        try {
            const config = vscode.workspace.getConfiguration();
            const filesExclude = config.get<any>('files.exclude') || {};
            filesExclude['.vscode/workspace'] = true;
            filesExclude['.vscode/workspace/**'] = true;
            await config.update('files.exclude', filesExclude, vscode.ConfigurationTarget.Workspace);
        } catch {
            // Ignore inability to update workspace explorer rules.
        }
         // Automatically trigger a sync on startup to check for offline files
        void this.flush([]);
    }

async flush(_newEvents: StandardEvent[]): Promise<void> {
        if (!this.context) {
            throw new Error('Storage manager is not initialized.');
        }
        const session = this.context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const userId = Number(session?.authUserId ?? 0);
        const role = String(session?.role ?? '').toLowerCase();

        if (!userId || userId === 0 || role === 'teacher' || role === 'admin') {
            return; 
        }
        
        let currentSessionId = this.context.workspaceState.get<number>('sessionId') || null;
        
        const studentWorkspaceAssignmentId = Number(session?.studentWorkspaceAssignmentId ?? 0);
        const projectId = Number(session?.workspaceLinkedClassId ?? 0);
        const linkRecord = await this.getStudentWorkspaceLinkRecord();

        // 2. Format new events AND forcefully filter out 'file_edit' before upload
        const newPayloads = _newEvents
            .filter(event => String(event.eventType || '').toLowerCase() !== 'file_edit')
            .map(event => ({
                sessionId: currentSessionId, 
                eventType: event.eventType,
                occurredAt: event.time || new Date().toISOString(),
                flightTimeMs: event.flightTime ? Number(event.flightTime) : null,
                //fileEdit: event.fileEdit || null,
                fileView: event.fileView || null,
                fileFocusCount: event.fileFocusCount || null,
                charsAdded: event.charsAdded || null,
                pasteCharCount: event.pasteCharCount || null,
                windowFocused: event.windowFocused !== undefined ? event.windowFocused : true,
                workspaceName: vscode.workspace.name || null,
                studentWorkspaceAssignmentId: studentWorkspaceAssignmentId > 0 ? studentWorkspaceAssignmentId : null,
                possibleAiDetection: event.possibleAiDetection || null,
                eventData: {
                    studentId: linkRecord?.studentId ?? undefined,
                    studentWorkspaceFullPath: linkRecord?.studentWorkspaceFullPath ?? undefined,
                    studentWorkspaceName: linkRecord?.studentWorkspaceName ?? undefined,
                    classId: linkRecord?.classId ?? undefined,
                    classAssignmentId: linkRecord?.classAssignmentId ?? undefined,
                    className: linkRecord?.className ?? undefined,
                    classAssignmentName: linkRecord?.classAssignmentName ?? undefined,
                    recordIdentifier: linkRecord?.recordIdentifier ?? undefined
                }
            }));

        // 3. Load the existing offline queue from .vscode/logs/tbd_offline_queue.enc
        let offlineQueue = await this.readQueue();
        
        // 4. Add new events to the back of the queue
        offlineQueue.push(...newPayloads);
        this.syncStatus.pendingQueueCount = offlineQueue.length;

        // 5. Try to push everything in the queue to the API
        const remainingQueue: any[] = [];
        const flushedEvents: Array<{ // Array to hold teammate's UI logs
            eventType: string;
            occurredAt: string;
            eventId: number | undefined;
            eventData: Record<string, unknown>;
        }> = [];

        let isOffline = false;
        //Keep track of the session we generate so we don't spam the API
        let generatedOfflineSessionId: number | null = null;

        for (const payload of offlineQueue) {
            
            // If the API drops mid-upload, stop making network calls and cache the rest
            if (isOffline) {
                remainingQueue.push(payload);
                continue;
            }

            try {
                // SCENARIO 1: They started offline and need a new Session ID generated
                if (!payload.sessionId) {
                    
                    // If we ALREADY generated a session for this batch, reuse it!
                    if (generatedOfflineSessionId) {
                        payload.sessionId = generatedOfflineSessionId;
                    } else {
                      // Otherwise, create a new one natively
                        let newSession;
                        const randSessionNum = Math.floor(Math.random() * 900000) + 100000; // Safe 6-digit number
                        const sessionPayload: any = {
                            userId: userId,
                            UserId: userId,
                            projectId: projectId,
                            ProjectId: projectId,
                            sessionNumber: randSessionNum,
                            SessionNumber: randSessionNum,
                            startedAt: payload.occurredAt,
                            StartedAt: payload.occurredAt,
                            studentWorkspaceAssignmentId: studentWorkspaceAssignmentId,
                            StudentWorkspaceAssignmentId: studentWorkspaceAssignmentId
                        };

                       try {
                            newSession = await apiPost('/api/sessions', sessionPayload);
                        } catch (err: any) {
                            // If the 6-digit number randomly collides (extremely rare) or it hits a local sequential clash, reroll once
                            if (err?.responseBody?.includes('23505') || err?.responseBody?.includes('UQ_')) {
                                const newRand = Math.floor(Math.random() * 900000) + 100000;
                                sessionPayload.sessionNumber = newRand;
                                sessionPayload.SessionNumber = newRand; // <-- Fix: ensure both cases are updated for the retry!
                                newSession = await apiPost('/api/sessions', sessionPayload);
                            } else {
                                throw err; // Not a duplicate error, throw normally
                            }
                        }
                        // Save the new session ID
                        currentSessionId = newSession.Id || newSession.id || newSession.SessionId;
                        generatedOfflineSessionId = currentSessionId;
                        await this.context.workspaceState.update('sessionId', currentSessionId);
                        
                        payload.sessionId = currentSessionId;
                        console.log(`[TBD Logger] Recovered from offline start. Generated new Session ID: ${currentSessionId}`);
                    }
                }

                // SCENARIO 2: Upload the event
                const response = await apiPost('/api/events', payload, { silent: true });
                
                const eventId = response?.event?.Id ?? response?.event?.id ?? response?.id ?? response?.Id;
                flushedEvents.push({
                    eventType: payload.eventType,
                    occurredAt: payload.occurredAt,
                    eventId: Number.isFinite(Number(eventId)) ? Number(eventId) : undefined,
                    eventData: payload
                });

            } catch (error) {
                console.warn('[TBD Logger] API is offline or database rejected event. Queuing event locally.', error);
                isOffline = true;
                remainingQueue.push(payload);
                this.syncStatus.state = 'offline';
                this.syncStatus.lastError = String(error);
            }
        }

        // 6. Save the remaining queue back to the encrypted file
        try {
            await this.writeQueue(remainingQueue);
            this.syncStatus.pendingQueueCount = remainingQueue.length;
        } catch (error) {
            console.error('[TBD Logger] Failed to write offline queue to disk!', error);
            throw error; 
        }

       // 7. Resolve status
        if (!isOffline) {
            const nowIso = new Date().toISOString();
            this.syncStatus.lastSyncedAt = nowIso;
            this.syncStatus.state = 'synced';
            this.syncStatus.lastError = null;
            
            // Save the timestamp to permanent storage so it survives a reload
            await this.context.workspaceState.update('tbd.lastSyncedAt', nowIso);
        }

        // 8. Teammate's Beautiful Console Output Grouping
        if (flushedEvents.length > 0) {
            console.groupCollapsed(`[TBD Logger] Logs pushed to /api/events: ${flushedEvents.length} event(s)`);
            for (const event of flushedEvents) {
                console.groupCollapsed(
                    `${event.eventType} @ ${event.occurredAt}` +
                    (event.eventId ? ` (event id: ${event.eventId})` : '')
                );
                console.log('payload', event.eventData);
                console.groupEnd();
            }
            console.groupEnd();
        }
    }

    isOnline(): boolean {
        return true;
    }

    isConnecting(): boolean {
        return false;
    }

    getBackgroundSyncStatus(): ApiSyncStatus {
        return { ...this.syncStatus };
    }

    async dispose(): Promise<void> {
        this.syncStatus.state = 'idle';
    }

    async checkUserConsent(policyVersion: string): Promise<boolean> {
        if (!this.context) {
            return false;
        }
        const key = `tbd.logger.localConsent.${policyVersion}`;
        return this.context.workspaceState.get<boolean>(key) === true;
    }

    async recordUserConsent(policyVersion: string): Promise<void> {
        if (!this.context) {
            return;
        }
        const key = `tbd.logger.localConsent.${policyVersion}`;
        await this.context.workspaceState.update(key, true);
    }

   async listLogFiles(): Promise<Array<{ label: string; uri: vscode.Uri }>> {
        if (!this.context) {
            return [];
        }
        const session = this.context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const teacherId = Number(session?.authUserId || 0);
        if (!teacherId) {
            return [];
        }

        const classes = await this.listTeacherClasses(teacherId);
        const logs: Array<{ label: string; uri: vscode.Uri }> = [];

        for (const c of classes) {
            const assignments = await this.listClassAssignments(c.id, teacherId);
            for (const a of assignments) {
                const students = await this.listAssignmentStudentWork(c.id, a.id, teacherId);
                for (const s of students) {
                    if (Number(s.sessionCount) > 0) {
                        try {
                            const sessionsAndEvents = await this.listAssignmentStudentSessions(c.id, a.id, s.authUserId, teacherId);
                            const uniqueSessionIds = new Set<number>();
                            const sortedSids = Array.from(uniqueSessionIds).sort((a, b) => a - b);
                            for (let i = 0; i < sortedSids.length; i++) {
                                const sid = sortedSids[i];
                                const localSessionNum = i + 1; // Sandboxed session number (1, 2, 3...)
                                
                                const safeCourse = String(c.courseName || 'Class').replace(/[^a-zA-Z0-9]/g, '');
                                const safeAssign = String(a.name || 'Assign').replace(/[^a-zA-Z0-9]/g, '');
                                const safeStudent = String(s.studentName || 'Student').replace(/[^a-zA-Z0-9]/g, '');
                                
                                // UI will now show each session incremented
                                const label = `${safeCourse}_${safeAssign}_${safeStudent}_Session${localSessionNum}.log`;
                                
                                const uri = vscode.Uri.parse(`tbd-cloud:${sid}?classId=${c.id}&assignId=${a.id}&studentId=${s.authUserId}&localNum=${localSessionNum}`);
                                logs.push({ label, uri });
                            }
                        } catch(e) {
                            console.warn('Failed to fetch sessions for virtual log', e);
                        }
                    }
                }
            }
        }
        return logs;
    }

    async retrieveLogContentForUri(_passwordAttempt: string, fileUri: vscode.Uri): Promise<string> {
        if (fileUri.scheme !== 'tbd-cloud') {
            return 'No cloud data found for this URI.';
        }

        const session = this.context?.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const teacherId = Number(session?.authUserId || 0);

        // Parse custom query string
        const queryParts = fileUri.query.split('&');
        const params: Record<string, string> = {};
        for (const part of queryParts) {
            const [k, v] = part.split('=');
            params[k] = v;
        }

        const classId = Number(params['classId']);
        const assignId = Number(params['assignId']);
        const studentId = Number(params['studentId']);
        const targetSessionId = Number(fileUri.path);

        const rows = await this.listAssignmentStudentSessions(classId, assignId, studentId, teacherId);
        const sessionEvents = rows.filter((r: any) => Number(r?.SessionId ?? r?.sessionId) === targetSessionId);

        if (sessionEvents.length === 0) {
            return '';
        }

        // 1. Generate the Legacy "sessionHeader" so the Logs tab triggers the beautiful UI
        const firstEvent = sessionEvents[0];
        const studentName = String(firstEvent?.StudentName || 'Student');
        const startTime = firstEvent?.StartedAt || firstEvent?.OccurredAt || firstEvent?.occurredAt || new Date().toISOString();
        const localSessionNum = Number(params['localNum']) || targetSessionId;
        
        // Find workspace name from event data if possible
        let workspaceName = 'Unknown Workspace';
        for (const row of sessionEvents) {
            let ed = row?.EventData ?? row?.eventData ?? {};
            if (typeof ed === 'string') { try { ed = JSON.parse(ed); } catch(e) {} }
            if (ed.workspaceName) {
                workspaceName = ed.workspaceName;
                break;
            }
        }

        const header = {
            sessionHeader: {
                sessionNumber: localSessionNum, // Now uses the sandboxed number
        databaseSessionId: targetSessionId, // Kept for debugging
                startedBy: studentName,
                project: workspaceName,
                startTime: startTime,
                metadata: {
                    vscodeVersion: "Cloud Sync",
                    extensionVersion: "Live API"
                }
            }
        };

        // Add the header as the first line
        let logText = JSON.stringify(header) + '\n';

        // 2. Output each event as a flat JSON string, exactly like local logs did
        for (const row of sessionEvents) {
            const eventType = row?.EventType || row?.eventType;

            // REMOVE HISTORICAL FILE_EDIT EVENTS FROM TEACHER VIEW
            if (eventType === 'file_edit') {
                continue; 
            }

            let eventData = row?.EventData ?? row?.eventData ?? {};
            if (typeof eventData === 'string') {
                try { eventData = JSON.parse(eventData); } catch(e) {}
            }
            
           const merged = {
  ...eventData,
  time: eventData.time || row?.OccurredAt || row?.occurredAt,
  eventType: eventType,
  flightTime: eventData.flightTime ?? row?.FlightTimeMs ?? row?.flightTimeMs ?? row?.flightTime ?? null,
  fileView: eventData.fileView ?? row?.FileView ?? row?.fileView ?? null,
  fileEdit: eventData.fileEdit ?? row?.FileEdit ?? row?.fileEdit ?? null,
  pasteCharCount: eventData.pasteCharCount ?? row?.PasteCharCount ?? row?.pasteCharCount ?? null,
  charsAdded: eventData.charsAdded ?? row?.CharsAdded ?? row?.charsAdded ?? null,
  workspaceName: eventData.workspaceName ?? row?.WorkspaceName ?? row?.workspaceName ?? null,
  possibleAiDetection: eventData.possibleAiDetection ?? row?.PossibleAiDetection ?? row?.possibleAiDetection ?? null,
};
            
            logText += JSON.stringify(merged) + '\n';
        }
        
        return logText.trim();
    }

   async retrieveHiddenLogContent(_passwordAttempt: string): Promise<string> {
        if (!this.context) {
            return '{"deletions":[]}';
        }
        const session = this.context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const teacherId = Number(session?.authUserId || 0);
        if (!teacherId) {
            return '{"deletions":[]}';
        }

        const classes = await this.listTeacherClasses(teacherId);
        const deletions: any[] = [];

        for (const c of classes) {
            const assignments = await this.listClassAssignments(c.id, teacherId);
            for (const a of assignments) {
                const students = await this.listAssignmentStudentWork(c.id, a.id, teacherId);
                for (const s of students) {
                    if (Number(s.sessionCount) > 0) {
                        try {
                            const sessionsAndEvents = await this.listAssignmentStudentSessions(c.id, a.id, s.authUserId, teacherId);
                            for (const row of sessionsAndEvents) {
                                const eventType = String(row?.EventType ?? row?.eventType ?? '').toLowerCase();
                                if (eventType === 'delete' || eventType === 'paste') {
                                    let eventData = row?.EventData ?? row?.eventData ?? {};
                                    if (typeof eventData === 'string') {
                                        try { eventData = JSON.parse(eventData); } catch(e) {}
                                    }

                                    deletions.push({
                                        activityType: eventType,
                                        actor: s.studentName,
                                        file: eventData.file || eventData.fileEdit || 'Unknown',
                                        time: eventData.time || row?.OccurredAt || row?.occurredAt,
                                        note: eventType === 'paste' 
                                            ? `Pasted ${eventData.pasteCharCount || eventData.charsAdded || 0} chars` 
                                            : `Deleted text`,
                                        ...eventData
                                    });
                                }
                            }
                        } catch (e) {
                            console.warn('Failed to fetch deletions', e);
                        }
                    }
                }
            }
        }

        return JSON.stringify({
            header: { note: "Cloud Deletions & Pastes Log", createdAt: new Date().toISOString() },
            deletions: deletions
        }, null, 2);
    }

   async retrieveLogContentWithPassword(passwordAttempt: string, fileUri: vscode.Uri): Promise<{ text: string; partial: boolean }> {
        const text = await this.retrieveLogContentForUri(passwordAttempt, fileUri);
        return { text, partial: false };
    }

    async saveLogNotes(_passwordAttempt: string, _filename: string, _notes: Array<{ timestamp: string; text: string }>): Promise<void> {
        throw new Error('Saving log notes is not available in API-only mode.');
    }

    async loadLogNotes(_passwordAttempt: string, _filename: string): Promise<Array<{ timestamp: string; text: string }>> {
        return [];
    }

    async recordUnmonitoredWorkAlert(_payload: {
        ideUser: string;
        workspaceName: string;
        workspacePath: string;
        reason: string;
    }): Promise<void> {
        // Intentionally no-op in API-only compatibility mode.
    }

    async listRecentUnmonitoredWorkAlerts(_limit: number): Promise<any[]> {
        return [];
    }

    async runAutomatedDataPurge(_daysToKeep: number): Promise<void> {
        // Intentionally no-op in API-only mode.
    }

    async upsertAuthUser(identity: { email: string; displayName: string; trackingConsent?: boolean; [key: string]: any }): Promise<{ authUserId: number; role: UserRole; isNew: boolean; trackingConsent: boolean }> {
        const email = this.normalizeEmail(identity.email);
        const displayName = this.titleCaseName(identity.displayName);
        const provider = String(identity.provider || 'email').toLowerCase();
        const subjectId = String(identity.subjectId || email).trim();
        const username = String(identity.username || email).trim();
        const password = identity.password ? String(identity.password) : undefined;
        const role = identity.role ? this.normalizeRole(identity.role) : undefined;
        
        // Ensure it's a native boolean type
        const trackingConsent = identity.trackingConsent === true;

        const payload = {
            provider, Provider: provider,
            subjectId, SubjectId: subjectId,
            email, Email: email,
            username, Username: username,
            displayName, DisplayName: displayName,
            password, Password: password,
            role, Role: role,
            trackingConsent, TrackingConsent: trackingConsent // Native boolean in JSON
        };
        console.log('[DEBUG] Sending Registration Payload to Server:', JSON.stringify(payload, null, 2));
        const result = await apiPost('/api/auth/upsert-user', payload);
        const user = result?.user ?? result;
        return {
            authUserId: Number(this.pick(result, ['authUserId', 'AuthUserId']) ?? this.pick(user, ['id', 'Id', 'authUserId', 'AuthUserId']) ?? 0),
            role: this.normalizeRole(this.pick(result, ['role', 'Role']) ?? this.pick(user, ['role', 'Role'])),
            isNew: Boolean(this.pick(result, ['isNew', 'IsNew']) ?? false),
            
            // Extract the returned boolean
            trackingConsent: Boolean(this.pick(result, ['trackingConsent', 'TrackingConsent']) ?? this.pick(user, ['trackingConsent', 'TrackingConsent']) ?? false)
        };
    }
    
    async updateAuthUserProfile(email: string, changes: { displayName?: string; trackingConsent?: boolean }): Promise<void> {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!normalizedEmail) {
            throw new Error('Email is required to update account information.');
        }

        const payload: Record<string, any> = {
            email: normalizedEmail
        };

        if (typeof changes.displayName === 'string') {
            const displayName = this.titleCaseName(changes.displayName);
            if (displayName) {
                payload.displayName = displayName;
            }
        }

        if (typeof changes.trackingConsent === 'boolean') {
            payload.TrackingConsent = changes.trackingConsent;
        }

        await apiPatch('/api/auth/update-account-information', payload);
    }

    async updateAuthUserRole(authUserId: number, role: UserRole): Promise<void> {
        await apiPost('/api/auth/update-role', {
            authUserId,
            AuthUserId: authUserId,
            role,
            Role: role
        });
    }

    async findAuthUserByEmail(email: string): Promise<{ authUserId: number; role: UserRole; displayName: string; trackingConsent: boolean } | null> {
        const result = await apiGet(`/api/auth/user-by-email?email=${encodeURIComponent(email.toLowerCase())}`);
        const user = result?.user ?? result;
        const authUserId = Number(this.pick(user, ['authUserId', 'AuthUserId', 'id', 'Id']) ?? 0);
        if (!authUserId) {
            return null;
        }
        return {
            authUserId,
            role: this.normalizeRole(this.pick(user, ['role', 'Role'])),
            displayName: String(this.pick(user, ['displayName', 'DisplayName', 'username', 'Username', 'email', 'Email']) || 'user'),
            trackingConsent: Boolean(this.pick(user, ['trackingConsent', 'TrackingConsent']) ?? false)
        };
    }

    async authenticateEmailPassword(email: string, password: string): Promise<{ authUserId: number; role: UserRole; displayName: string; trackingConsent: boolean } | null> {
        const normalizedEmail = this.normalizeEmail(email);
        const result = await apiPost('/api/auth/login', {
            email: normalizedEmail,
            Email: normalizedEmail,
            password,
            Password: password
        });

        const user = result?.user ?? result;
        const authUserId = Number(this.pick(user, ['authUserId', 'AuthUserId', 'id', 'Id']) ?? 0);
        if (!authUserId) {
            return null;
        }

        return {
            authUserId,
            role: this.normalizeRole(this.pick(user, ['role', 'Role'])),
            displayName: String(this.pick(user, ['displayName', 'DisplayName', 'username', 'Username']) || normalizedEmail),
            trackingConsent: Boolean(this.pick(user, ['trackingConsent', 'TrackingConsent']) ?? false)
        };
    }

    async findClassByJoinCode(joinCode: string): Promise<any | undefined> {
        if (!joinCode.trim()) {
            return undefined;
        }

        const encoded = encodeURIComponent(joinCode.trim());
        
        const result = await this.apiGetFirst([
            `/api/classes/join-code/${encoded}`,
            `/api/class/join-code/${encoded}`
        ]);
        const cls = result?.class ?? result?.data ?? result;
        if (!cls) {
            return undefined;
        }
        const id = Number(this.pick(cls, ['id', 'Id', 'classId', 'ClassId']) ?? 0);
        if (!id) {
            return undefined;
        }
        return {
            id,
            teacherAuthUserId: Number(this.pick(cls, ['teacherAuthUserId', 'TeacherAuthUserId']) ?? 0),
            teacherName: String(this.pick(cls, ['teacherName', 'TeacherName']) || ''),
            courseName: String(this.pick(cls, ['courseName', 'CourseName', 'name', 'Name']) || ''),
            courseCode: String(this.pick(cls, ['courseCode', 'CourseCode']) || ''),
            joinCode: String(this.pick(cls, ['joinCode', 'JoinCode']) || joinCode)
        };
    }

    async enrollStudentInClass(studentAuthUserId: number, linkedClass: any): Promise<boolean> {
        const classId = Number(this.pick(linkedClass, ['id', 'Id', 'classId', 'ClassId']) ?? 0);
        if (!classId) {
            throw new Error('Class id is required to enroll student.');
        }
        const result = await this.apiPostFirst([
            '/api/classes/enroll-student',
            '/api/student/enroll-class'
        ], {
            studentId: studentAuthUserId,
            StudentId: studentAuthUserId,
            studentAuthUserId,
            StudentAuthUserId: studentAuthUserId,
            classId,
            ClassId: classId,
            teacherId: Number(this.pick(linkedClass, ['teacherId', 'TeacherId', 'teacherAuthUserId', 'TeacherAuthUserId']) ?? 0),
            TeacherId: Number(this.pick(linkedClass, ['teacherId', 'TeacherId', 'teacherAuthUserId', 'TeacherAuthUserId']) ?? 0),
            teacherAuthUserId: Number(this.pick(linkedClass, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0),
            TeacherAuthUserId: Number(this.pick(linkedClass, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0)
        });
        return Boolean(this.pick(result, ['isNewEnrollment', 'IsNewEnrollment', 'enrolled', 'Enrolled']) ?? true);
    }

    async listAssignmentsForClass(classId: number): Promise<Array<{ id: number; name: string; dueDate?: string }>> {
        const result = await this.apiGetFirst([
            `/api/classes/${classId}/assignments`,
            `/api/class-assignments?classId=${classId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.assignments) ? result.assignments : (Array.isArray(result?.data) ? result.data : []));
        return rows.map((row: any) => ({
            id: Number(this.pick(row, ['id', 'Id', 'assignmentId', 'AssignmentId']) ?? 0),
            name: String(this.pick(row, ['name', 'Name', 'assignmentName', 'AssignmentName']) || 'Assignment'),
            dueDate: String(this.pick(row, ['dueDate', 'DueDate']) || '')
        })).filter((row: any) => row.id > 0);
    }

    async linkStudentWorkspaceToAssignment(input: any): Promise<any> {
        const classId = Number(input?.classId ?? input?.ClassId ?? 0);
        const classAssignmentId = Number(input?.classAssignmentId ?? input?.ClassAssignmentId ?? input?.assignmentId ?? input?.AssignmentId ?? 0);
        const workspaceRootPath = String(input?.workspaceRootPath ?? input?.WorkspaceRootPath ?? '');
        const workspaceName = String(input?.workspaceName ?? input?.WorkspaceName ?? '');
        const workspaceIdValue = this.parsePositiveInteger(input?.workspaceId ?? input?.WorkspaceId)
            ?? this.generateWorkspaceId(classAssignmentId, workspaceRootPath, workspaceName);
        const result = await this.apiPostFirst([
            '/api/classes/link-student-assignment-workspace',
            '/api/classes/link-workspace',
            '/api/classes/assignments/link-workspace',
            `/api/classes/${classId}/assignments/${classAssignmentId}/link-workspace`,
            `/api/classes/${classId}/assignments/${classAssignmentId}/workspace`,
            '/api/student-assignments/link-workspace',
            '/api/student-assignment/link-workspace',
            `/api/student/classes/${classId}/assignments/${classAssignmentId}/link-workspace`,
            `/api/student/classes/${classId}/assignments/${classAssignmentId}/workspace`
        ], {
            studentAuthUserId: Number(input?.studentAuthUserId ?? input?.StudentAuthUserId ?? 0),
            StudentAuthUserId: Number(input?.studentAuthUserId ?? input?.StudentAuthUserId ?? 0),
            teacherId: Number(input?.teacherId ?? input?.TeacherId ?? input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            TeacherId: Number(input?.teacherId ?? input?.TeacherId ?? input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            teacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? input?.teacherId ?? input?.TeacherId ?? 0),
            TeacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? input?.teacherId ?? input?.TeacherId ?? 0),
            classId,
            ClassId: classId,
            classAssignmentId,
            ClassAssignmentId: classAssignmentId,
            assignmentId: classAssignmentId,
            AssignmentId: classAssignmentId,
            workspaceId: workspaceIdValue,
            WorkspaceId: workspaceIdValue,
            workspaceName: String(input?.workspaceName ?? input?.WorkspaceName ?? ''),
            WorkspaceName: String(input?.workspaceName ?? input?.WorkspaceName ?? ''),
            workspaceRootPath: String(input?.workspaceRootPath ?? input?.WorkspaceRootPath ?? ''),
            WorkspaceRootPath: String(input?.workspaceRootPath ?? input?.WorkspaceRootPath ?? ''),
            workspaceFoldersJson: String(input?.workspaceFoldersJson ?? input?.WorkspaceFoldersJson ?? '[]'),
            WorkspaceFoldersJson: String(input?.workspaceFoldersJson ?? input?.WorkspaceFoldersJson ?? '[]')
        });

        await this.writeStudentWorkspaceLinkFile(
            this.normalizeStudentWorkspaceLinkRecord({
                studentId: Number(input?.studentAuthUserId ?? input?.StudentAuthUserId ?? 0),
                studentWorkspaceFullPath: workspaceRootPath,
                studentWorkspaceName: workspaceName || vscode.workspace.workspaceFolders?.[0]?.name || undefined,
                classId,
                classAssignmentId
            }),
            true
        );

        return result?.link ?? result?.data ?? result;
    }

    async validateAssignmentLink(_authUserId: number, workspaceRoot: string): Promise<{
        classId: number;
        assignmentId: number;
        assignmentName: string;
        workspaceRootPath: string;
        studentWorkspaceAssignmentId?: number;
    } | null> {
        if (!workspaceRoot || !this.context) {
            return null;
        }

        try {
            const result = await this.apiPostFirst([
                '/api/workspace/validate',
                '/api/student-assignment/validate-workspace',
                '/api/classes/validate-workspace-link'
            ], {
                studentAuthUserId: _authUserId,
                workspaceRootPath: workspaceRoot
            });

            if (result && (result.classId || result.ClassId)) {
                await this.writeStudentWorkspaceLinkFile(
                    this.normalizeStudentWorkspaceLinkRecord({
                        studentId: _authUserId,
                        studentWorkspaceFullPath: workspaceRoot,
                        studentWorkspaceName: vscode.workspace.workspaceFolders?.[0]?.name || undefined,
                        classId: Number(result.classId || result.ClassId),
                        classAssignmentId: Number(result.assignmentId || result.AssignmentId)
                    }),
                    false
                );

                return {
                    classId: Number(result.classId || result.ClassId),
                    assignmentId: Number(result.assignmentId || result.AssignmentId),
                    assignmentName: String(result.assignmentName || result.AssignmentName || result.WorkplaceName || result.workplaceName || 'Linked Assignment'),
                    workspaceRootPath: workspaceRoot,
                    studentWorkspaceAssignmentId: Number(result.id || result.Id || result.workspaceId || result.WorkspaceId || 0)
                };
            }
        } catch (err) {
            console.log("[TBD Logger] Backend validation route unavailable. Attempting auto-recovery.");
        }

        const session = this.context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        let classId = Number(session?.workspaceLinkedClassId ?? 0);
        let assignmentId = Number(session?.workspaceLinkedAssignmentId ?? 0);
        let swaId = Number(session?.studentWorkspaceAssignmentId ?? 0);
        let assignmentName = String(session?.assignmentName || session?.AssignmentName || 'Current Assignment');

        // Aggressively hunt for the real ID to prevent null constraints
        try {
            const classes = await this.listStudentClasses(_authUserId);
            for (const c of classes) {
                const assignments = await this.listStudentAssignmentsForClass(_authUserId, c.id);
                for (const a of assignments) {
                    if (a.workspaceRootPath && vscode.Uri.file(a.workspaceRootPath).fsPath === vscode.Uri.file(workspaceRoot).fsPath) {
                        swaId = Number(a.workspaceId || a.id || a.studentWorkspaceAssignmentId || a.assignmentId);
                        classId = c.id;
                        assignmentId = a.assignmentId;
                        assignmentName = String(a.assignmentName || a.name || 'Current Assignment');
                        break;
                    }
                }
                if (swaId > 0) { break; }
            }
        } catch(e) { /* ignore network errors */ }

        if (!classId || !assignmentId) {
            return null;
        }

        // If the API failed to give us a real ID, calculate the mathematical fallback hash
        if (!swaId || swaId <= 0) {
            swaId = this.generateWorkspaceId(assignmentId, workspaceRoot, vscode.workspace.workspaceFolders?.[0]?.name || '');
        }

        // Ensure the ID is permanently saved to the session state so Session 1 doesn't crash
        if (swaId > 0 && session) {
            session.studentWorkspaceAssignmentId = swaId;
            await this.context.workspaceState.update('tbd.auth.workspaceSession.v1', session);
        }

        await this.writeStudentWorkspaceLinkFile(
            this.normalizeStudentWorkspaceLinkRecord({
                studentId: _authUserId,
                studentWorkspaceFullPath: workspaceRoot,
                studentWorkspaceName: vscode.workspace.workspaceFolders?.[0]?.name || undefined,
                classId,
                classAssignmentId: assignmentId
            }),
            false
        );

        return {
            classId,
            assignmentId,
            assignmentName,
            workspaceRootPath: workspaceRoot,
            studentWorkspaceAssignmentId: swaId || this.generateWorkspaceId(assignmentId, workspaceRoot, vscode.workspace.workspaceFolders?.[0]?.name || '')
        };
    }

    async listClassActivities(): Promise<any[]> {
        return [];
    }

    async createClassActivity(_teacherAuthUserId: number, _name: string, _description: string): Promise<number> {
        return Date.now();
    }

    async listTeacherClasses(teacherAuthUserId: number): Promise<any[]> {
        let rows: any[] = [];

        try {
            const result = await this.apiGetFirst([
                `/api/classes/teacher/${teacherAuthUserId}`,
                `/api/class/teacher/${teacherAuthUserId}`,
                `/api/classes?teacherAuthUserId=${teacherAuthUserId}`,
                `/api/classes?teacherId=${teacherAuthUserId}`,
                '/api/classes',
                `/api/class-activities?teacherAuthUserId=${teacherAuthUserId}`,
                '/api/class-activities'
            ]);

            rows = Array.isArray(result)
                ? result
                : (Array.isArray(result?.classes) ? result.classes : (Array.isArray(result?.data) ? result.data : []));
        } catch (_getError) {
            try {
                const postResult = await this.apiPostFirst([
                    '/api/classes/list',
                    '/api/class/list',
                    '/api/class-activities/list',
                    '/api/classes/search',
                    '/api/class-activities/search'
                ], {
                    teacherAuthUserId,
                    TeacherAuthUserId: teacherAuthUserId,
                    teacherId: teacherAuthUserId,
                    TeacherId: teacherAuthUserId
                });

                rows = Array.isArray(postResult)
                    ? postResult
                    : (Array.isArray(postResult?.classes) ? postResult.classes : (Array.isArray(postResult?.data) ? postResult.data : []));
            } catch (postError: any) {
                console.warn('Unable to list teacher classes from API:', String(postError?.message || postError));
                return [];
            }
        }

        return rows
            .filter((row: any) => {
                const rowTeacherId = Number(this.pick(row, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0);
                return !rowTeacherId || rowTeacherId === teacherAuthUserId;
            })
            .map((row: any) => ({
            id: Number(this.pick(row, ['id', 'Id', 'classId', 'ClassId']) ?? 0),
            courseName: String(this.pick(row, ['courseName', 'CourseName', 'name', 'Name']) || ''),
            courseCode: String(this.pick(row, ['courseCode', 'CourseCode']) || ''),
            teacherName: String(this.pick(row, ['teacherName', 'TeacherName']) || ''),
            meetingTime: String(this.pick(row, ['meetingTime', 'MeetingTime']) || ''),
            startDate: String(this.pick(row, ['startDate', 'StartDate']) || ''),
            endDate: String(this.pick(row, ['endDate', 'EndDate']) || ''),
            joinCode: String(this.pick(row, ['joinCode', 'JoinCode']) || ''),
            teacherAuthUserId: Number(this.pick(row, ['teacherAuthUserId', 'TeacherAuthUserId']) ?? teacherAuthUserId)
        })).filter((row: any) => row.id > 0);
    }

    async createClass(input: any): Promise<any> {
        const joinCode = String(input?.joinCode ?? input?.JoinCode ?? '').trim() || this.generateJoinCode();
        const payload = {
            teacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            TeacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            courseName: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            CourseName: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            courseCode: String(input?.courseCode ?? input?.CourseCode ?? ''),
            CourseCode: String(input?.courseCode ?? input?.CourseCode ?? ''),
            teacherName: String(input?.teacherName ?? input?.TeacherName ?? ''),
            TeacherName: String(input?.teacherName ?? input?.TeacherName ?? ''),
            meetingTime: String(input?.meetingTime ?? input?.MeetingTime ?? ''),
            MeetingTime: String(input?.meetingTime ?? input?.MeetingTime ?? ''),
            startDate: input?.startDate ?? input?.StartDate ?? null,
            StartDate: input?.startDate ?? input?.StartDate ?? null,
            endDate: input?.endDate ?? input?.EndDate ?? null,
            EndDate: input?.endDate ?? input?.EndDate ?? null,
            joinCode,
            JoinCode: joinCode,
            name: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            Name: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            description: String(input?.description ?? input?.Description ?? ''),
            Description: String(input?.description ?? input?.Description ?? '')
        };

        const result = await this.apiPostFirst([
            '/api/classes',
            '/api/classes/create',
            '/api/class/create',
            '/api/class-activities',
            '/api/class-activities/create'
        ], payload);
        return result?.class ?? result?.data ?? result;
    }

    async updateClass(input: any): Promise<void> {
        const classId = Number(input?.classId ?? input?.ClassId ?? input?.id ?? input?.Id ?? 0);
        const payload = {
            classId,
            ClassId: classId,
            id: classId,
            Id: classId,
            teacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            TeacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            courseName: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            CourseName: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            courseCode: String(input?.courseCode ?? input?.CourseCode ?? ''),
            CourseCode: String(input?.courseCode ?? input?.CourseCode ?? ''),
            teacherName: String(input?.teacherName ?? input?.TeacherName ?? ''),
            TeacherName: String(input?.teacherName ?? input?.TeacherName ?? ''),
            meetingTime: String(input?.meetingTime ?? input?.MeetingTime ?? ''),
            MeetingTime: String(input?.meetingTime ?? input?.MeetingTime ?? ''),
            startDate: String(input?.startDate ?? input?.StartDate ?? ''),
            StartDate: String(input?.startDate ?? input?.StartDate ?? ''),
            endDate: String(input?.endDate ?? input?.EndDate ?? ''),
            EndDate: String(input?.endDate ?? input?.EndDate ?? ''),
            name: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            Name: String(input?.courseName ?? input?.CourseName ?? input?.name ?? input?.Name ?? ''),
            description: String(input?.description ?? input?.Description ?? ''),
            Description: String(input?.description ?? input?.Description ?? '')
        };

        await this.apiPutFirst([
            `/api/classes/${classId}`,
            `/api/class/${classId}`,
            `/api/class-activities/${classId}`,
            '/api/classes/update',
            '/api/class/update',
            '/api/class-activities/update'
        ], payload);
    }

    async getTeacherClassById(classId: number, teacherAuthUserId: number): Promise<any> {
        const result = await this.apiGetFirst([
            `/api/classes/${classId}?teacherAuthUserId=${teacherAuthUserId}`,
            `/api/classes/class-by-id?classId=${classId}&teacherAuthUserId=${teacherAuthUserId}`,
            `/api/class-activities/${classId}?teacherAuthUserId=${teacherAuthUserId}`
        ]);
        const cls = result?.class ?? result?.data ?? result;
        if (!cls) {
            return undefined;
        }
        const id = Number(this.pick(cls, ['id', 'Id', 'classId', 'ClassId']) ?? 0);
        if (!id) {
            return undefined;
        }
        return {
            id,
            courseName: String(this.pick(cls, ['courseName', 'CourseName', 'name', 'Name']) || ''),
            courseCode: String(this.pick(cls, ['courseCode', 'CourseCode']) || ''),
            teacherName: String(this.pick(cls, ['teacherName', 'TeacherName']) || ''),
            meetingTime: String(this.pick(cls, ['meetingTime', 'MeetingTime']) || ''),
            startDate: String(this.pick(cls, ['startDate', 'StartDate']) || ''),
            endDate: String(this.pick(cls, ['endDate', 'EndDate']) || ''),
            joinCode: String(this.pick(cls, ['joinCode', 'JoinCode']) || ''),
            teacherAuthUserId: Number(this.pick(cls, ['teacherAuthUserId', 'TeacherAuthUserId']) ?? teacherAuthUserId)
        };
    }

    async listClassStudentsSummary(classId: number, teacherAuthUserId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/classes/${classId}/students?teacherAuthUserId=${teacherAuthUserId}`,
            `/api/class-students?classId=${classId}&teacherAuthUserId=${teacherAuthUserId}`,
            `/api/class-students/${classId}?teacherAuthUserId=${teacherAuthUserId}`,
            `/api/classes/${classId}/students-summary?teacherAuthUserId=${teacherAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.students) ? result.students : (Array.isArray(result?.data) ? result.data : []));
        return rows.map((row: any) => ({
            authUserId: Number(this.pick(row, ['authUserId', 'AuthUserId', 'studentAuthUserId', 'StudentAuthUserId', 'id', 'Id']) ?? 0),
            studentName: String(this.pick(row, ['studentName', 'StudentName', 'displayName', 'DisplayName']) || ''),
            studentEmail: String(this.pick(row, ['studentEmail', 'StudentEmail', 'email', 'Email']) || ''),
            role: this.normalizeRole(this.pick(row, ['role', 'Role', 'assignedRole', 'AssignedRole'])),
            linkedAt: String(this.pick(row, ['linkedAt', 'LinkedAt']) || '')
        })).filter((row: any) => row.authUserId > 0);
    }

    async listClassAssignments(classId: number, teacherAuthUserId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/classes/${classId}/assignments?teacherAuthUserId=${teacherAuthUserId}`,
            `/api/class-assignments?classId=${classId}&teacherAuthUserId=${teacherAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.assignments) ? result.assignments : (Array.isArray(result?.data) ? result.data : []));
        return rows.map((row: any) => ({
            id: Number(this.pick(row, ['id', 'Id', 'assignmentId', 'AssignmentId']) ?? 0),
            classId: Number(this.pick(row, ['classId', 'ClassId']) ?? classId),
            name: String(this.pick(row, ['name', 'Name', 'assignmentName', 'AssignmentName']) || ''),
            description: String(this.pick(row, ['description', 'Description']) || ''),
            dueDate: String(this.pick(row, ['dueDate', 'DueDate']) || ''),
            createdAt: String(this.pick(row, ['createdAt', 'CreatedAt']) || '')
        })).filter((row: any) => row.id > 0);
    }

    async createClassAssignment(input: any): Promise<any> {
        const payload = {
            classId: Number(input?.classId ?? input?.ClassId ?? 0),
            ClassId: Number(input?.classId ?? input?.ClassId ?? 0),
            teacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            TeacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            name: String(input?.name ?? input?.Name ?? ''),
            Name: String(input?.name ?? input?.Name ?? ''),
            description: String(input?.description ?? input?.Description ?? ''),
            Description: String(input?.description ?? input?.Description ?? ''),
            dueDate: String(input?.dueDate ?? input?.DueDate ?? ''),
            DueDate: String(input?.dueDate ?? input?.DueDate ?? '')
        };
        const result = await this.apiPostFirst([
            '/api/classes/assignments',
            '/api/class-assignments'
        ], payload);
        return result?.assignment ?? result?.data ?? result;
    }

    async listAssignmentStudentWork(classId: number, assignmentId: number, teacherAuthUserId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/classes/${classId}/assignments/${assignmentId}/students-work?teacherAuthUserId=${teacherAuthUserId}`,
            `/api/classes/${classId}/assignments/${assignmentId}/students?teacherAuthUserId=${teacherAuthUserId}`,
            `/api/class-assignments/${assignmentId}/students`,
            `/api/assignments/${assignmentId}/work`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.students) ? result.students : (Array.isArray(result?.data) ? result.data : []));
        const normalizedRows = rows.map((row: any) => ({
            ...row,
            authUserId: Number(row.UserId || row.userId || row.authUserId || 0),
            studentName: String(row.StudentName || row.studentName || row.displayName || 'Unknown Student'),
            studentEmail: String(row.StudentEmail || row.studentEmail || row.email || ''),
            role: this.normalizeRole(row.Role || row.role || row.assignedRole || row.AssignedRole),
            sessionCount: Number(this.pick(row, ['SessionCount', 'sessionCount', 'totalSessions', 'TotalSessions']) ?? 0),
            totalEvents: Number(this.pick(row, ['TotalEvents', 'totalEvents', 'eventCount', 'EventCount']) ?? 0),
            lastActive: String(this.pick(row, ['LastActive', 'lastActive']) || ''),
            workspaceName: String(row.WorkspaceName || row.workspaceName || ''),
            workspaceRootPath: String(row.WorkspaceRootPath || row.workspaceRootPath || ''),
            linkedAt: String(this.pick(row, ['LinkedAt', 'linkedAt']) || ''),
            synced: Boolean(row.synced ?? row.Synced ?? false),
            aiEventCount: Number(row.AiEventCount || row.aiEventCount || 0),
            totalPasteEvents: Number(row.TotalPasteEvents || row.totalPasteEvents || 0),
            suspiciousPasteCount: Number(row.SuspiciousPasteCount || row.suspiciousPasteCount || 0)
        }));
        (normalizedRows as any).rawResponse = result;
        return normalizedRows;
    }

    async listAssignmentStudentSessions(
        classId: number,
        assignmentId: number,
        studentAuthUserId: number,
        teacherAuthUserId?: number
    ): Promise<any[]> {
        const teacherId = Number(teacherAuthUserId ?? 0);
        const primaryPath = `/api/classes/assignment-student-sessions?classId=${classId}&assignmentId=${assignmentId}&studentAuthUserId=${studentAuthUserId}`;
        const fallbackPath = `/api/classes/${classId}/assignments/${assignmentId}/students/${studentAuthUserId}/sessions?teacherAuthUserId=${teacherId}`;

        let result: any;
        try {
            result = await this.apiGetFirst([
                primaryPath,
                fallbackPath
            ]);
        } catch (error) {
            throw error;
        }

        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.sessions) ? result.sessions : (Array.isArray(result?.data) ? result.data : []));
        return rows;
    }

    async listStudentClasses(studentAuthUserId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/student/classes?studentAuthUserId=${studentAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.classes) ? result.classes : (Array.isArray(result?.data) ? result.data : []));
        return rows
            .map((row: any) => ({
                id: Number(this.pick(row, ['id', 'Id', 'classId', 'ClassId']) ?? 0),
                courseName: String(this.pick(row, ['courseName', 'CourseName', 'className', 'ClassName', 'courseTitle', 'CourseTitle', 'name', 'Name', 'title', 'Title']) || ''),
                courseCode: String(this.pick(row, ['courseCode', 'CourseCode', 'code', 'Code']) || ''),
                teacherName: String(this.pick(row, ['teacherName', 'TeacherName', 'teacherDisplayName', 'TeacherDisplayName', 'teacher', 'Teacher']) || ''),
                meetingTime: String(this.pick(row, ['meetingTime', 'MeetingTime']) || ''),
                startDate: this.pick(row, ['startDate', 'StartDate']) ?? null,
                endDate: this.pick(row, ['endDate', 'EndDate']) ?? null,
                joinCode: String(this.pick(row, ['joinCode', 'JoinCode']) || ''),
                teacherAuthUserId: Number(this.pick(row, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0)
            }))
            .filter((row: any) => row.id > 0);
    }

    async listStudentAssignmentsForClass(studentAuthUserId: number, classId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/student/classes/${classId}/assignments?studentAuthUserId=${studentAuthUserId}`,
            `/api/student/classes/${classId}/assignments?studentId=${studentAuthUserId}`,
            `/api/classes/${classId}/assignments?studentAuthUserId=${studentAuthUserId}`,
            `/api/classes/${classId}/assignments?studentId=${studentAuthUserId}`,
            `/api/classes/${classId}/student-assignments?studentAuthUserId=${studentAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.assignments) ? result.assignments : (Array.isArray(result?.data) ? result.data : []));
        const normalized = rows
            .map((row: any) => ({
                assignmentId: Number(this.pick(row, ['assignmentId', 'AssignmentId', 'id', 'Id']) ?? 0),
                id: Number(this.pick(row, ['assignmentId', 'AssignmentId', 'id', 'Id']) ?? 0),
                assignmentName: String(this.pick(row, ['assignmentName', 'AssignmentName', 'name', 'Name', 'title', 'Title']) || 'Untitled Assignment'),
                name: String(this.pick(row, ['assignmentName', 'AssignmentName', 'name', 'Name', 'title', 'Title']) || 'Untitled Assignment'),
                description: String(this.pick(row, ['description', 'Description', 'details', 'Details']) || 'No assignment description was provided.'),
                dueDate: String(this.pick(row, ['dueDate', 'DueDate']) || ''),
                sessionCount: Number(this.pick(row, ['SessionCount', 'sessionCount', 'totalSessions', 'TotalSessions']) ?? 0),
                totalEvents: Number(this.pick(row, ['TotalEvents', 'totalEvents', 'eventCount', 'EventCount']) ?? 0),
                lastActive: String(this.pick(row, ['LastActive', 'lastActive']) || ''),
                workspaceName: String(this.pick(row, ['workspaceName', 'WorkspaceName']) || ''),
                workspaceRootPath: String(this.pick(row, ['workspaceRootPath', 'WorkspaceRootPath']) || ''),
                linkedAt: String(this.pick(row, ['LinkedAt', 'linkedAt']) || ''),
                classId: Number(this.pick(row, ['classId', 'ClassId']) ?? classId),
                teacherAuthUserId: Number(this.pick(row, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0),
                studentAuthUserId: Number(this.pick(row, ['studentAuthUserId', 'StudentAuthUserId']) ?? studentAuthUserId)
            }))
            .filter((row: any) => row.assignmentId > 0);

        const hydrated = await Promise.all(normalized.map(async (row: any) => {
            const workspace = await this.getStudentAssignmentWorkspace(studentAuthUserId, classId, row.assignmentId);
            if (!workspace) {
                return row;
            }

            return {
                ...row,
                workspaceId: Number(this.pick(workspace, ['workspaceId', 'WorkspaceId']) ?? row.workspaceId ?? 0),
                workspaceName: String(this.pick(workspace, ['workspaceName', 'WorkspaceName']) || row.workspaceName || ''),
                workspaceRootPath: String(this.pick(workspace, ['workspaceRootPath', 'WorkspaceRootPath']) || row.workspaceRootPath || ''),
                workspaceFoldersJson: String(this.pick(workspace, ['workspaceFoldersJson', 'WorkspaceFoldersJson']) || row.workspaceFoldersJson || '[]'),
                linkedAt: String(this.pick(workspace, ['LinkedAt', 'linkedAt']) || row.linkedAt || ''),
                updatedAt: String(this.pick(workspace, ['UpdatedAt', 'updatedAt']) || row.updatedAt || ''),
                teacherAuthUserId: Number(this.pick(workspace, ['teacherAuthUserId', 'TeacherAuthUserId']) ?? row.teacherAuthUserId ?? 0)
            };
        }));

        return hydrated;
    }

    async getStudentAssignmentWorkspace(studentAuthUserId: number, classId: number, assignmentId: number): Promise<any | null> {
        try {
            const result = await this.apiGetFirst([
                // Added the correct paths without the duplicate "classes" routing
                `/api/student/classes/${classId}/assignments/${assignmentId}/workspace?studentAuthUserId=${studentAuthUserId}`,
                `/api/classes/${classId}/assignments/${assignmentId}/workspace?studentAuthUserId=${studentAuthUserId}`,
                `/api/student-assignments/workspace?studentId=${studentAuthUserId}&assignmentId=${assignmentId}`,
                // Keep original paths as fallbacks
                `/api/classes/student/classes/${classId}/assignments/${assignmentId}/workspace?studentAuthUserId=${studentAuthUserId}`,
                `/api/classes/student/classes/${classId}/assignments/${assignmentId}/workspace?studentId=${studentAuthUserId}`
            ]);
            
            const workspace = result?.workspace ?? result?.data ?? result;
            if (!workspace) {
                return null;
            }

            return {
                studentAuthUserId: Number(this.pick(workspace, ['studentAuthUserId', 'StudentAuthUserId']) ?? studentAuthUserId),
                teacherAuthUserId: Number(this.pick(workspace, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0),
                classId: Number(this.pick(workspace, ['classId', 'ClassId']) ?? classId),
                classAssignmentId: Number(this.pick(workspace, ['classAssignmentId', 'ClassAssignmentId', 'assignmentId', 'AssignmentId']) ?? assignmentId),
                workspaceId: Number(this.pick(workspace, ['workspaceId', 'WorkspaceId', 'Id', 'id', 'studentWorkspaceAssignmentId']) ?? 0),
                workspaceName: String(this.pick(workspace, ['workspaceName', 'WorkspaceName']) || ''),
                workspaceRootPath: String(this.pick(workspace, ['workspaceRootPath', 'WorkspaceRootPath']) || ''),
                workspaceFoldersJson: String(this.pick(workspace, ['workspaceFoldersJson', 'WorkspaceFoldersJson']) || '[]'),
                linkedAt: String(this.pick(workspace, ['LinkedAt', 'linkedAt']) || ''),
                updatedAt: String(this.pick(workspace, ['UpdatedAt', 'updatedAt']) || '')
            };
        } catch (e) {
            return null;
        }
    }
}