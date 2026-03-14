// Module: dbStorageManager.ts
// Purpose: Database-backed storage manager for session logs, events, and notes.
// Replaces file-based storage with Azure SQL database persistence while maintaining
// the same API interface as the original StorageManager for compatibility.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getSessionInfo } from './sessionInfo';
import { formatTimestamp } from './utils';
import { executeQuery, getPool, closePool, isConnected } from './db';
import type { StandardEvent } from './types';

// SECURITY CONFIGURATION
const SECRET_PASSPHRASE = 'password';
const OFFLINE_QUEUE_SYNC_INTERVAL_MS = 30_000;
const OFFLINE_QUEUE_MAX_FILES = 500;
const OFFLINE_QUEUE_WARN_AT = 450;
const OFFLINE_QUEUE_ENCRYPTION_SALT = 'tbd-offline-queue-salt-v1';
const OFFLINE_QUEUE_FAILED_DIR = 'failed';
const UNMONITORED_ALERT_QUEUE_DIR = 'unmonitored-alert-queue';

interface QueuedBatch {
    version: 1;
    queuedAt: string;
    session: {
        sessionId: number | null;
        user: string;
        project: string;
    };
    events: StandardEvent[];
}

interface UnmonitoredWorkAlertPayload {
    observedAt: string;
    ideUser: string;
    workspaceName: string;
    workspacePath: string;
    reason: string;
}

export type SyncState = 'synced' | 'syncing' | 'offline' | 'queue-warning' | 'conflict' | 'idle';

export interface BackgroundSyncStatus {
    state: SyncState;
    pendingQueueCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
    lastConflictAt: string | null;
}

export interface SessionIntegrityVerification {
    sessionId: number;
    eventCount: number;
    verified: boolean;
    mismatchReason: string | null;
    expectedHash: string | null;
    computedHash: string | null;
}

export interface UnmonitoredWorkAlertRecord {
    id: number;
    observedAt: string;
    ideUser: string;
    workspaceName: string;
    workspacePath: string;
    reason: string;
}

interface SessionData {
    sessionHeader: {
        sessionNumber: number;
        startedBy: string;
        project: string;
        startTime: string;
        metadata: {
            vscodeVersion: string;
            startTimestamp: string;
            extensionVersion: string;
        };
    };
    events: StandardEvent[];
}

export type UserRole = 'Student' | 'Teacher' | 'Admin';

export interface AuthIdentityInput {
    provider: string;
    subjectId: string;
    email: string;
    displayName: string;
}

export interface UpsertAuthUserResult {
    authUserId: number;
    role: UserRole;
    isNew: boolean;
}

export interface ClassActivityRecord {
    id: number;
    name: string;
    description: string;
    teacherAuthUserId: number;
    teacherDisplayName: string;
}

export interface WorkspaceActivityLinkInput {
    studentAuthUserId: number;
    teacherAuthUserId: number;
    activityId: number;
    workspaceName: string;
    workspaceRootPath: string;
    workspaceFoldersJson: string;
}

export interface ClassRecord {
    id: number;
    courseName: string;
    courseCode: string;
    teacherName: string;
    meetingTime: string;
    startDate: string;
    endDate: string;
    joinCode: string;
    teacherAuthUserId: number;
    createdAt: string;
}

export interface CreateClassInput {
    teacherAuthUserId: number;
    courseName: string;
    courseCode: string;
    teacherName: string;
    meetingTime: string;
    startDate: string;
    endDate: string;
}

export interface UpdateClassInput {
    classId: number;
    teacherAuthUserId: number;
    courseName: string;
    courseCode: string;
    teacherName: string;
    meetingTime: string;
    startDate: string;
    endDate: string;
}

export interface ClassAssignmentRecord {
    id: number;
    classId: number;
    name: string;
    description: string;
    dueDate: string;
    createdAt: string;
}

export interface CreateClassAssignmentInput {
    classId: number;
    teacherAuthUserId: number;
    name: string;
    description: string;
    dueDate?: string;
}

export interface ClassStudentRecord {
    authUserId: number;
    studentName: string;
    studentEmail: string;
    role: UserRole;
    assignmentName: string;
    workspaceName: string;
    workspaceRootPath: string;
    linkedAt: string;
}

export interface ClassStudentSummaryRecord {
    authUserId: number;
    studentName: string;
    studentEmail: string;
    role: UserRole;
    linkedAt: string;
}

export interface AssignmentStudentWorkRecord {
    authUserId: number;
    studentName: string;
    studentEmail: string;
    role: UserRole;
    sessionCount: number;
}

export interface AssignmentStudentSessionRecord {
    sessionId: number;
    filename: string;
    startedAt: string;
    ideUser: string;
    workspaceName: string;
}

export interface StudentClassRecord {
    id: number;
    courseName: string;
    courseCode: string;
    teacherName: string;
    meetingTime: string;
    startDate: string;
    endDate: string;
    joinCode: string;
    linkedAt: string;
}

export interface StudentClassAssignmentRecord {
    assignmentId: number;
    classId: number;
    assignmentName: string;
    description: string;
    dueDate: string;
    workspaceName: string;
    workspaceRootPath: string;
    linkedAt: string;
}

export interface StudentAssignmentLinkInput {
    studentAuthUserId: number;
    teacherAuthUserId: number;
    classId: number;
    assignmentId: number;
    workspaceName: string;
    workspaceRootPath: string;
    workspaceFoldersJson: string;
}

export interface ClassLookupRecord {
    id: number;
    teacherAuthUserId: number;
    teacherName: string;
    courseName: string;
    courseCode: string;
    joinCode: string;
}

export class DbStorageManager {
    private context!: vscode.ExtensionContext;
    private initialized = false;
    private isConnectionInProgress = false;
    private sessionInitPromise: Promise<void> | null = null;
    private currentSessionId: number | null = null;
    private currentUserId: number | null = null;
    private currentProjectId: number | null = null;
    private currentUserName = '';
    private currentProjectName = '';
    private offlineQueueDir: vscode.Uri | null = null;
    private syncTimer: NodeJS.Timeout | null = null;
    private isSyncing = false;
    private isSyncingUnmonitoredAlerts = false;
    private authSchemaReady = false;
    private classesSchemaReady = false;
    private syncSchemaReady = false;
    private integritySchemaReady = false;
    private unmonitoredAlertQueueDir: vscode.Uri | null = null;
    private pendingQueueCount = 0;
    private lastSyncedAtMs: number | null = null;
    private lastSyncError: string | null = null;
    private lastConflictAtMs: number | null = null;
    private lastQueueWarningAtMs: number | null = null;
    private syncState: SyncState = 'idle';

   async init(context: vscode.ExtensionContext): Promise<void> {
    this.context = context;

    const info = getSessionInfo();
    this.currentUserName = info.user;
    this.currentProjectName = info.project;

        this.offlineQueueDir = vscode.Uri.joinPath(context.globalStorageUri, 'offline-queue');
        await vscode.workspace.fs.createDirectory(this.offlineQueueDir);
        await this.refreshOfflineQueueCount();

        this.unmonitoredAlertQueueDir = vscode.Uri.joinPath(context.globalStorageUri, UNMONITORED_ALERT_QUEUE_DIR);
        await vscode.workspace.fs.createDirectory(this.unmonitoredAlertQueueDir);

        // Start connection in the background (don't await - let it connect while extension operates)
        void this.initializeOnlineSessionInBackground();

        this.syncTimer = setInterval(() => {
            void this.syncOfflineQueue();
            void this.syncUnmonitoredWorkAlerts();
        }, OFFLINE_QUEUE_SYNC_INTERVAL_MS);
        context.subscriptions.push({
            dispose: () => {
                if (this.syncTimer) {
                    clearInterval(this.syncTimer);
                    this.syncTimer = null;
                }
            }
        });
    this.offlineQueueDir = vscode.Uri.joinPath(context.globalStorageUri, 'offline-queue');
    await vscode.workspace.fs.createDirectory(this.offlineQueueDir);
    await this.refreshOfflineQueueCount();

    if (process.env.CI === 'true') {
        console.log('[TBD Logger DB] Running in CI mode, skipping DB sync and timers');
        this.setSyncState('offline');
        this.initialized = true;
        void this.syncOfflineQueue();
        void this.syncUnmonitoredWorkAlerts();
        // Exit early to prevent background timers from starting in CI
        return;
    }

    // These only run if NOT in CI
    void this.initializeOnlineSessionInBackground();

    this.syncTimer = setInterval(() => {
        void this.syncOfflineQueue();
    }, OFFLINE_QUEUE_SYNC_INTERVAL_MS);

    context.subscriptions.push({
        dispose: () => {
            if (this.syncTimer) {
                clearInterval(this.syncTimer);
                this.syncTimer = null;
            }
        }
    });

    this.initialized = true;
    void this.syncOfflineQueue();
}

    /**
     * Initialize database connection in the background without blocking
     * Allows the extension to load while connection is being established
     */
    private async initializeOnlineSessionInBackground(): Promise<void> {
        if (this.isConnectionInProgress) {
            return; // Already connecting
        }

        try {
            console.log('[TBD Logger DB] Starting background database connection...');
            await this.initializeOnlineSession(this.currentUserName, this.currentProjectName);
            await this.ensureIntegritySchema();
            await this.ensureUnmonitoredWorkSchema();
            console.log('[TBD Logger DB] Database connection established successfully');
            if (this.pendingQueueCount === 0) {
                this.setSyncState('synced');
            }
        } catch (err) {
            console.warn('[TBD Logger DB] Operating in offline mode. Events will be queued locally.', err);
            this.setSyncState('offline', String((err as any)?.message || err));
        }
    }

    private async initializeOnlineSession(username: string, projectName: string): Promise<void> {
        if (this.currentSessionId && this.currentUserId && this.currentProjectId) {
            return;
        }

        if (this.sessionInitPromise) {
            await this.sessionInitPromise;
            return;
        }

        this.isConnectionInProgress = true;
        this.sessionInitPromise = (async () => {
            await getPool();
            this.currentUserId = await this.ensureUser(username);
            this.currentProjectId = await this.ensureProject(projectName, username);
            this.currentSessionId = await this.createSession(username, projectName);
            console.log(`[TBD Logger DB] Session initialized: User=${this.currentUserId}, Project=${this.currentProjectId}, Session=${this.currentSessionId}`);
        })();

        try {
            await this.sessionInitPromise;
        } finally {
            this.sessionInitPromise = null;
            this.isConnectionInProgress = false;
        }
    }

    /**
     * Ensure a user exists in the database, create if not
     */
    private async ensureUser(username: string): Promise<number> {
        try {
            // Check if user exists
            const result = await executeQuery(
                `SELECT Id FROM Users WHERE Username = @username`,
                { username }
            );

            if (result.recordset.length > 0) {
                return result.recordset[0].Id;
            }

            // Create new user
            const insertResult = await executeQuery(
                `INSERT INTO Users (Username, DisplayName) 
                 OUTPUT INSERTED.Id
                 VALUES (@username, @username)`,
                { username }
            );

            return insertResult.recordset[0].Id;
        } catch (err) {
            console.error('[TBD Logger DB] Error ensuring user:', err);
            throw err;
        }
    }

    /**
     * Ensure a project exists in the database, create if not
     */
    private async ensureProject(projectName: string, username: string): Promise<number> {
        try {
            const workspacePath = projectName;

            // Check if project exists
            const result = await executeQuery(
                `SELECT Id FROM Projects WHERE Name = @name AND WorkspacePath = @workspacePath`,
                { name: projectName, workspacePath }
            );

            if (result.recordset.length > 0) {
                return result.recordset[0].Id;
            }

            // Create new project (workspace path defaults to project name)
            const insertResult = await executeQuery(
                `INSERT INTO Projects (Name, WorkspacePath)
                 OUTPUT INSERTED.Id
                 VALUES (@name, @workspacePath)`,
                { name: projectName, workspacePath }
            );

            return insertResult.recordset[0].Id;
        } catch (err) {
            // Another initialization path may have inserted the same project first.
            // On duplicate key, re-read and return the existing project id.
            const sqlErr = err as { number?: number; originalError?: { number?: number } };
            const errNo = sqlErr.number ?? sqlErr.originalError?.number;
            if (errNo === 2627 || errNo === 2601) {
                const existing = await executeQuery(
                    `SELECT Id FROM Projects WHERE Name = @name AND WorkspacePath = @workspacePath`,
                    { name: projectName, workspacePath: projectName }
                );
                if (existing.recordset.length > 0) {
                    return existing.recordset[0].Id;
                }
            }

            console.error('[TBD Logger DB] Error ensuring project:', err);
            throw err;
        }
    }

    /**
     * Create a new session in the database
     */
    private async createSession(username: string, projectName: string): Promise<number> {
        try {
            if (!this.currentUserId || !this.currentProjectId) {
                throw new Error('User or Project not initialized');
            }

            // Get extension version
            let extensionVersion = 'unknown';
            try {
                const pkgUri = vscode.Uri.joinPath(this.context.extensionUri, 'package.json');
                const raw = await vscode.workspace.fs.readFile(pkgUri);
                const pkg = JSON.parse(Buffer.from(raw).toString('utf8'));
                extensionVersion = pkg.version || extensionVersion;
            } catch (e) {
                // ignore
            }

            const startTime = new Date();
            const startTimestampText = formatTimestamp(startTime.getTime());
            let sessionId: number | null = null;

            // Retry a few times in case another concurrent writer grabs the same session number.
            for (let attempt = 0; attempt < 3; attempt++) {
                const sessionNumberResult = await executeQuery(
                    `SELECT ISNULL(MAX(SessionNumber), 0) + 1 AS NextSessionNumber
                     FROM Sessions
                     WHERE UserId = @userId AND ProjectId = @projectId`,
                    { userId: this.currentUserId, projectId: this.currentProjectId }
                );
                const sessionNumber = sessionNumberResult.recordset[0].NextSessionNumber;

                try {
                    const insertResult = await executeQuery(
                        `INSERT INTO Sessions (
                            UserId, ProjectId, SessionNumber, StartedAt,
                            VscodeVersion, ExtensionVersion, RawStartTimestampText, RecreationNotice
                         )
                         OUTPUT INSERTED.Id
                         VALUES (
                            @userId, @projectId, @sessionNumber, @startedAt,
                            @vscodeVersion, @extensionVersion, @rawStartTimestampText, @recreationNotice
                         )`,
                        {
                            userId: this.currentUserId,
                            projectId: this.currentProjectId,
                            sessionNumber,
                            startedAt: startTime,
                            vscodeVersion: vscode.version,
                            extensionVersion,
                            rawStartTimestampText: startTimestampText,
                            recreationNotice: null
                        }
                    );
                    sessionId = insertResult.recordset[0].Id;
                    break;
                } catch (insertErr) {
                    const sqlErr = insertErr as { number?: number; originalError?: { number?: number } };
                    const errNo = sqlErr.number ?? sqlErr.originalError?.number;
                    if (errNo === 2627 || errNo === 2601) {
                        continue;
                    }
                    throw insertErr;
                }
            }

            if (!sessionId) {
                throw new Error('Failed to allocate a unique session number after retries');
            }

            // Create corresponding SessionLogFiles entry for compatibility
            const filename = `${username}-${projectName}-Session${sessionId}-integrity.log`;
            
            await executeQuery(
                `INSERT INTO SessionLogFiles (SessionId, OriginalFilename, StorageUri, IsActive)
                 VALUES (@sessionId, @originalFilename, @storageUri, @isActive)`,
                {
                    sessionId,
                    originalFilename: filename,
                    storageUri: null,
                    isActive: true
                }
            );

            return sessionId;
        } catch (err) {
            console.error('[TBD Logger DB] Error creating session:', err);
            throw err;
        }
    }

    /**
     * Flush events to the database
     */
    async flush(newEvents: StandardEvent[]): Promise<void> {
        if (!this.initialized || !this.currentSessionId) {
            if (!this.initialized) {
                console.warn('[TBD Logger DB] Flush called but not initialized');
                return;
            }
        }

        if (newEvents.length === 0) {
            return;
        }

        try {
            if (!this.currentSessionId) {
                await this.initializeOnlineSession(this.currentUserName, this.currentProjectName);
            }
            if (!this.currentSessionId) {
                throw new Error('No active database session');
            }

            await this.insertEventsForSession(this.currentSessionId, newEvents);
            console.log(`[TBD Logger DB] Flushed ${newEvents.length} events to database`);
            this.lastSyncedAtMs = Date.now();
            if (this.pendingQueueCount === 0) {
                this.setSyncState('synced');
            }
            void this.syncOfflineQueue();
        } catch (err) {
            console.warn('[TBD Logger DB] Database write failed, queueing events for offline sync:', err);
            this.setSyncState('offline', String((err as any)?.message || err));
            await this.enqueueOfflineBatch({
                version: 1,
                queuedAt: new Date().toISOString(),
                session: {
                    sessionId: this.currentSessionId,
                    user: this.currentUserName,
                    project: this.currentProjectName
                },
                events: newEvents
            });
        }
    }

    private hashSha256(input: string): string {
        return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
    }

    private normalizeForHash(value: unknown): unknown {
        if (value === null || value === undefined) {
            return null;
        }
        if (Array.isArray(value)) {
            return value.map(v => this.normalizeForHash(v));
        }
        if (typeof value !== 'object') {
            return value;
        }
        const obj = value as Record<string, unknown>;
        const sortedKeys = Object.keys(obj).sort();
        const out: Record<string, unknown> = {};
        for (const key of sortedKeys) {
            out[key] = this.normalizeForHash(obj[key]);
        }
        return out;
    }

    private buildEventCanonicalPayload(
        sessionId: number,
        occurredAt: Date,
        rawTimeText: string,
        eventType: string,
        flightTimeMs: number,
        fileEditPath: string,
        fileViewPath: string,
        fileFocusDurationText: string | null,
        possibleAiDetection: string | null,
        pasteCharCount: number | null,
        metadataJson: string
    ): string {
        const metadataObj = (() => {
            try {
                return JSON.parse(metadataJson || '{}');
            } catch {
                return {};
            }
        })();

        const normalized = this.normalizeForHash({
            sessionId,
            occurredAt: occurredAt.toISOString(),
            rawTimeText,
            eventType,
            flightTimeMs,
            fileEditPath,
            fileViewPath,
            fileFocusDurationText,
            possibleAiDetection,
            pasteCharCount,
            metadata: metadataObj
        });

        return JSON.stringify(normalized);
    }

    private computeSessionRootHash(sessionId: number, eventCount: number, lastChainHash: string): string {
        return this.hashSha256(`${sessionId}|${eventCount}|${lastChainHash}`);
    }

    private async insertEventsForSession(sessionId: number, events: StandardEvent[]): Promise<void> {
        await this.ensureIntegritySchema();
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            const prevChainReq = transaction.request();
            prevChainReq.input('sessionId', sessionId);
            const prevChainRes = await prevChainReq.query(`
                SELECT TOP 1 sei.ChainHash
                FROM dbo.SessionEventIntegrity sei
                INNER JOIN dbo.SessionEvents se ON se.Id = sei.EventId
                WHERE se.SessionId = @sessionId
                ORDER BY se.Id DESC
            `);
            let previousChainHash = prevChainRes.recordset[0]?.ChainHash || '';

            for (const event of events) {
                let eventTime: Date;
                try {
                    eventTime = new Date(event.time);
                    if (isNaN(eventTime.getTime())) {
                        eventTime = new Date();
                    }
                } catch {
                    eventTime = new Date();
                }

                const rawTimeText = event.time || formatTimestamp(Date.now());
                const eventType = event.eventType;
                const flightTimeMs = parseInt(event.flightTime || '0', 10) || 0;
                const fileEditPath = event.fileEdit || '';
                const fileViewPath = event.fileView || '';
                const fileFocusDurationText = event.fileFocusCount || null;
                const possibleAiDetection = event.possibleAiDetection || null;
                const pasteCharCount = event.pasteCharCount || null;

                const additionalData: Record<string, unknown> = {};
                for (const key in event) {
                    if (!['time', 'flightTime', 'eventType', 'fileEdit', 'fileView', 'possibleAiDetection', 'fileFocusCount', 'pasteCharCount'].includes(key)) {
                        additionalData[key] = (event as unknown as Record<string, unknown>)[key];
                    }
                }
                const additionalDataJson = Object.keys(additionalData).length > 0 ? JSON.stringify(additionalData) : '{}';

                const insertReq = transaction.request();
                insertReq.input('sessionId', sessionId);
                insertReq.input('occurredAt', eventTime);
                insertReq.input('rawTimeText', rawTimeText);
                insertReq.input('eventType', eventType);
                insertReq.input('flightTimeMs', flightTimeMs);
                insertReq.input('fileEditPath', fileEditPath);
                insertReq.input('fileViewPath', fileViewPath);
                insertReq.input('fileFocusDurationText', fileFocusDurationText);
                insertReq.input('possibleAiDetection', possibleAiDetection);
                insertReq.input('pasteCharCount', pasteCharCount);
                insertReq.input('metadataJson', additionalDataJson);

                const insertResult = await insertReq.query(`
                    INSERT INTO SessionEvents
                    (SessionId, OccurredAt, RawTimeText, FlightTimeMs, EventType,
                     FileEditPath, FileViewPath, FileFocusDurationText,
                     PossibleAiDetection, PasteCharCount, MetadataJson)
                    OUTPUT INSERTED.Id AS EventId
                    VALUES
                    (@sessionId, @occurredAt, @rawTimeText, @flightTimeMs, @eventType,
                     @fileEditPath, @fileViewPath, @fileFocusDurationText,
                     @possibleAiDetection, @pasteCharCount, @metadataJson)
                `);

                const insertedEventId = Number(insertResult.recordset[0]?.EventId);
                const eventCanonicalPayload = this.buildEventCanonicalPayload(
                    sessionId,
                    eventTime,
                    rawTimeText,
                    eventType,
                    flightTimeMs,
                    fileEditPath,
                    fileViewPath,
                    fileFocusDurationText,
                    possibleAiDetection,
                    pasteCharCount,
                    additionalDataJson
                );
                const eventHash = this.hashSha256(eventCanonicalPayload);
                const chainHash = this.hashSha256(`${previousChainHash}|${eventHash}`);

                const integrityReq = transaction.request();
                integrityReq.input('eventId', insertedEventId);
                integrityReq.input('eventHash', eventHash);
                integrityReq.input('prevEventHash', previousChainHash || null);
                integrityReq.input('chainHash', chainHash);
                await integrityReq.query(`
                    INSERT INTO dbo.SessionEventIntegrity (EventId, EventHash, PrevEventHash, ChainHash)
                    VALUES (@eventId, @eventHash, @prevEventHash, @chainHash)
                `);

                previousChainHash = chainHash;
            }

            const eventCountReq = transaction.request();
            eventCountReq.input('sessionId', sessionId);
            const eventCountRes = await eventCountReq.query(`
                SELECT COUNT(*) AS EventCount
                FROM dbo.SessionEvents
                WHERE SessionId = @sessionId
            `);

            const nextSeqReq = transaction.request();
            nextSeqReq.input('sessionId', sessionId);
            const nextSeqRes = await nextSeqReq.query(`
                SELECT ISNULL(MAX(SequenceNumber), 0) + 1 AS NextSequence
                FROM dbo.SessionIntegritySnapshots
                WHERE SessionId = @sessionId
            `);

            const eventCount = Number(eventCountRes.recordset[0]?.EventCount || 0);
            const nextSequence = Number(nextSeqRes.recordset[0]?.NextSequence || 1);
            const computedSnapshotHash = this.computeSessionRootHash(sessionId, eventCount, previousChainHash || '');

            const insertSnapshotReq = transaction.request();
            insertSnapshotReq.input('sessionId', sessionId);
            insertSnapshotReq.input('sequenceNumber', nextSequence);
            insertSnapshotReq.input('eventCount', eventCount);
            insertSnapshotReq.input('sessionHash', computedSnapshotHash);
            insertSnapshotReq.input('lastChainHash', previousChainHash || null);
            await insertSnapshotReq.query(`
                INSERT INTO dbo.SessionIntegritySnapshots (SessionId, SequenceNumber, EventCount, SessionHash, LastChainHash)
                VALUES (@sessionId, @sequenceNumber, @eventCount, @sessionHash, @lastChainHash)
            `);

            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }

    private deriveOfflineQueueKey(user: string, project: string): Buffer {
        return crypto.scryptSync(
            `${SECRET_PASSPHRASE}:${user}:${project}`,
            OFFLINE_QUEUE_ENCRYPTION_SALT,
            32
        );
    }

    private encryptQueuedBatch(batch: QueuedBatch): Buffer {
        const plaintext = Buffer.from(JSON.stringify(batch), 'utf8');
        const iv = crypto.randomBytes(12);
        const key = this.deriveOfflineQueueKey(batch.session.user, batch.session.project);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const envelope = {
            version: 1,
            algorithm: 'aes-256-gcm',
            user: batch.session.user,
            project: batch.session.project,
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            payload: ciphertext.toString('base64')
        };
        return Buffer.from(JSON.stringify(envelope), 'utf8');
    }

    private decryptQueuedBatch(raw: Uint8Array): QueuedBatch {
        const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as any;

        // Backward compatibility: older queue files were plaintext JSON batches.
        if (parsed && parsed.version === 1 && parsed.session && Array.isArray(parsed.events)) {
            return parsed as QueuedBatch;
        }

        if (!parsed || parsed.version !== 1 || parsed.algorithm !== 'aes-256-gcm') {
            throw new Error('Unsupported offline queue payload format');
        }

        const iv = Buffer.from(parsed.iv, 'base64');
        const tag = Buffer.from(parsed.tag, 'base64');
        const ciphertext = Buffer.from(parsed.payload, 'base64');
        const key = this.deriveOfflineQueueKey(
            parsed.user || this.currentUserName,
            parsed.project || this.currentProjectName
        );
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8')) as QueuedBatch;
    }

    private async readOfflineQueueFiles(): Promise<string[]> {
        if (!this.offlineQueueDir) {
            return [];
        }
        const files = await vscode.workspace.fs.readDirectory(this.offlineQueueDir);
        return files
            .map(([name]) => name)
            .filter(name => name.endsWith('.json'))
            .sort();
    }

    private async moveQueueFileToFailed(fileUri: vscode.Uri, fileName: string, reason: string): Promise<void> {
        if (!this.offlineQueueDir) {
            return;
        }

        const failedDir = vscode.Uri.joinPath(this.offlineQueueDir, OFFLINE_QUEUE_FAILED_DIR);
        await vscode.workspace.fs.createDirectory(failedDir);
        const failedName = `${Date.now()}-${fileName.replace(/\.json$/i, '')}.failed.json`;
        const failedUri = vscode.Uri.joinPath(failedDir, failedName);

        try {
            await vscode.workspace.fs.rename(fileUri, failedUri, { overwrite: false });
        } catch {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            const wrapped = {
                reason,
                movedAt: new Date().toISOString(),
                originalFileName: fileName,
                raw: Buffer.from(raw).toString('base64')
            };
            await vscode.workspace.fs.writeFile(failedUri, Buffer.from(JSON.stringify(wrapped), 'utf8'));
            await vscode.workspace.fs.delete(fileUri);
        }
    }

    private setSyncState(state: SyncState, error?: string | null): void {
        this.syncState = state;
        this.lastSyncError = error ?? null;
    }

    private formatMsIso(ms: number | null): string | null {
        return ms ? new Date(ms).toISOString() : null;
    }

    private isLikelyConnectivityError(error: unknown): boolean {
        const msg = String((error as any)?.message || error || '').toLowerCase();
        return msg.includes('connect')
            || msg.includes('timeout')
            || msg.includes('econn')
            || msg.includes('network')
            || msg.includes('socket')
            || msg.includes('closed');
    }

    private async refreshOfflineQueueCount(): Promise<void> {
        this.pendingQueueCount = (await this.readOfflineQueueFiles()).length;
    }

    private async warnIfQueueNearLimit(): Promise<void> {
        await this.refreshOfflineQueueCount();
        const now = Date.now();
        const shouldNotify = !this.lastQueueWarningAtMs || (now - this.lastQueueWarningAtMs) > 5 * 60 * 1000;
        if (this.pendingQueueCount > OFFLINE_QUEUE_MAX_FILES) {
            this.setSyncState('queue-warning', `Offline queue exceeded ${OFFLINE_QUEUE_MAX_FILES} items.`);
            if (shouldNotify) {
                this.lastQueueWarningAtMs = now;
                vscode.window.showWarningMessage(
                    `TBD Logger offline queue has exceeded ${OFFLINE_QUEUE_MAX_FILES} pending uploads. Reconnect soon to avoid delayed backups.`
                );
            }
            return;
        }

        if (this.pendingQueueCount >= OFFLINE_QUEUE_WARN_AT) {
            this.setSyncState('queue-warning', `Offline queue is near limit (${this.pendingQueueCount}/${OFFLINE_QUEUE_MAX_FILES}).`);
            if (shouldNotify) {
                this.lastQueueWarningAtMs = now;
                vscode.window.showWarningMessage(
                    `TBD Logger offline queue is at ${this.pendingQueueCount}/${OFFLINE_QUEUE_MAX_FILES}. Reconnect to sync pending session data.`
                );
            }
        }
    }

    private async ensureSyncSchema(): Promise<void> {
        if (this.syncSchemaReady) {
            return;
        }

        await executeQuery(`
            IF OBJECT_ID('dbo.SessionSyncConflicts', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.SessionSyncConflicts (
                    Id BIGINT IDENTITY(1,1) PRIMARY KEY,
                    SessionId BIGINT NOT NULL,
                    DetectedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    ResolutionStrategy NVARCHAR(100) NOT NULL,
                    DetailsJson NVARCHAR(MAX) NOT NULL,
                    IsResolved BIT NOT NULL DEFAULT 0
                );
            END
        `);

        this.syncSchemaReady = true;
    }

    private parseEventTimeMs(event: StandardEvent): number {
        const parsed = Date.parse(event.time || '');
        return Number.isFinite(parsed) ? parsed : Date.now();
    }

    private async recordSyncConflict(
        sessionId: number,
        cloudLatestAt: string | null,
        localLatestAt: string | null,
        droppedCount: number
    ): Promise<void> {
        await this.ensureSyncSchema();
        await executeQuery(
            `INSERT INTO dbo.SessionSyncConflicts (SessionId, ResolutionStrategy, DetailsJson)
             VALUES (@sessionId, @resolutionStrategy, @detailsJson)`,
            {
                sessionId,
                resolutionStrategy: 'LatestWinsTimestamp',
                detailsJson: JSON.stringify({
                    cloudLatestAt,
                    localLatestAt,
                    droppedCount
                })
            }
        );
    }

    private async insertEventsWithLatestWins(sessionId: number, events: StandardEvent[]): Promise<{ inserted: number; dropped: number }> {
        const latestCloudResult = await executeQuery(
            `SELECT MAX(OccurredAt) AS LatestOccurredAt FROM SessionEvents WHERE SessionId = @sessionId`,
            { sessionId }
        );

        const latestCloudRaw = latestCloudResult.recordset[0]?.LatestOccurredAt;
        const latestCloudMs = latestCloudRaw ? new Date(latestCloudRaw).getTime() : null;

        const sorted = [...events].sort((a, b) => this.parseEventTimeMs(a) - this.parseEventTimeMs(b));
        const allowed: StandardEvent[] = [];
        let dropped = 0;

        for (const event of sorted) {
            const eventMs = this.parseEventTimeMs(event);
            if (latestCloudMs !== null && eventMs <= latestCloudMs) {
                dropped += 1;
                continue;
            }
            allowed.push(event);
        }

        if (allowed.length > 0) {
            await this.insertEventsForSession(sessionId, allowed);
        }

        if (dropped > 0) {
            const latestLocalMs = sorted.length > 0 ? this.parseEventTimeMs(sorted[sorted.length - 1]) : null;
            await this.recordSyncConflict(
                sessionId,
                latestCloudMs ? new Date(latestCloudMs).toISOString() : null,
                latestLocalMs ? new Date(latestLocalMs).toISOString() : null,
                dropped
            );
            this.lastConflictAtMs = Date.now();
            this.setSyncState('conflict', `${dropped} queued events were older than cloud state and skipped.`);
        }

        return { inserted: allowed.length, dropped };
    }

    private async enqueueOfflineBatch(batch: QueuedBatch): Promise<void> {
        if (!this.offlineQueueDir) {
            return;
        }
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        const uri = vscode.Uri.joinPath(this.offlineQueueDir, name);
        await vscode.workspace.fs.writeFile(uri, this.encryptQueuedBatch(batch));
        await this.warnIfQueueNearLimit();
        if (!isConnected()) {
            this.setSyncState('offline');
        }
    }

    private async syncOfflineQueue(): Promise<void> {
        if (this.isSyncing || !this.offlineQueueDir) {
            return;
        }

        this.isSyncing = true;
        try {
            const queueFiles = await this.readOfflineQueueFiles();
            this.pendingQueueCount = queueFiles.length;

            if (queueFiles.length === 0) {
                if (isConnected()) {
                    this.setSyncState('synced');
                } else {
                    this.setSyncState('offline');
                }
                return;
            }

            this.setSyncState('syncing');

            try {
                await getPool();
            } catch (err) {
                this.setSyncState('offline', String((err as any)?.message || err));
                return;
            }

            for (const fileName of queueFiles) {
                const fileUri = vscode.Uri.joinPath(this.offlineQueueDir, fileName);
                try {
                    const raw = await vscode.workspace.fs.readFile(fileUri);
                    const batch = this.decryptQueuedBatch(raw);
                    if (!batch.events || batch.events.length === 0) {
                        await vscode.workspace.fs.delete(fileUri);
                        continue;
                    }

                    let targetSessionId = batch.session.sessionId;
                    if (!targetSessionId) {
                        const userId = await this.ensureUser(batch.session.user);
                        const projectId = await this.ensureProject(batch.session.project, batch.session.user);
                        this.currentUserId = userId;
                        this.currentProjectId = projectId;
                        targetSessionId = await this.createSession(batch.session.user, batch.session.project);
                    }

                    await this.insertEventsWithLatestWins(targetSessionId, batch.events);
                    await vscode.workspace.fs.delete(fileUri);
                } catch (err) {
                    if (this.isLikelyConnectivityError(err)) {
                        console.warn('[TBD Logger DB] Offline sync paused while network is unavailable:', err);
                        this.setSyncState('offline', String((err as any)?.message || err));
                        break;
                    }

                    console.warn('[TBD Logger DB] Skipping invalid offline queue batch and continuing sync:', err);
                    await this.moveQueueFileToFailed(fileUri, fileName, String((err as any)?.message || err));
                    this.setSyncState('conflict', 'One queued upload was invalid and moved to failed queue.');
                }
            }

            await this.refreshOfflineQueueCount();
            if (this.pendingQueueCount === 0) {
                this.lastSyncedAtMs = Date.now();
                if (this.syncState !== 'conflict') {
                    this.setSyncState('synced');
                }
            } else if (this.pendingQueueCount >= OFFLINE_QUEUE_WARN_AT) {
                this.setSyncState('queue-warning', `Offline queue is near limit (${this.pendingQueueCount}/${OFFLINE_QUEUE_MAX_FILES}).`);
            }
        } catch (err) {
            this.setSyncState('offline', String((err as any)?.message || err));
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * List available sessions (replaces listLogFiles)
     */
    async listLogFiles(): Promise<Array<{ label: string; uri: vscode.Uri }>> {
        try {
            const result = await executeQuery(`
                SELECT 
                    s.Id AS SessionId,
                    slf.OriginalFilename AS FileName,
                    u.Username,
                    p.Name as ProjectName,
                    s.StartedAt
                FROM Sessions s
                INNER JOIN SessionLogFiles slf ON s.Id = slf.SessionId
                INNER JOIN Users u ON s.UserId = u.Id
                INNER JOIN Projects p ON s.ProjectId = p.Id
                ORDER BY s.Id ASC
            `);

            return result.recordset.map((row: any) => ({
                label: row.FileName,
                // Use a custom scheme to indicate this is a database record
                uri: vscode.Uri.parse(`tbd-db://session/${row.SessionId}`)
            }));
        } catch (err) {
            console.error('[TBD Logger DB] Error listing sessions:', err);
            return [];
        }
    }

    /**
     * Retrieve session content with password validation
     */
    async retrieveLogContentWithPassword(passwordAttempt: string, fileUri: vscode.Uri): Promise<{ text: string; partial: boolean }> {
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }

        try {
            // Extract session ID from URI
            const sessionId = this.extractSessionIdFromUri(fileUri);

            // Get session header
            const headerResult = await executeQuery(`
                SELECT 
                    s.Id AS SessionId,
                    s.StartedAt,
                    s.VscodeVersion,
                    s.ExtensionVersion,
                    s.RawStartTimestampText,
                    u.Username,
                    p.Name as ProjectName
                FROM Sessions s
                INNER JOIN Users u ON s.UserId = u.Id
                INNER JOIN Projects p ON s.ProjectId = p.Id
                WHERE s.Id = @sessionId
            `, { sessionId });

            if (headerResult.recordset.length === 0) {
                throw new Error('Session not found');
            }

            const session = headerResult.recordset[0];
            const metadata: any = {
                vscodeVersion: session.VscodeVersion || '',
                extensionVersion: session.ExtensionVersion || '',
                startTimestamp: session.RawStartTimestampText || ''
            };

            // Get all events for this session
            const eventsResult = await executeQuery(`
                SELECT 
                    OccurredAt,
                    RawTimeText,
                    EventType,
                    FlightTimeMs,
                    FileEditPath,
                    FileViewPath,
                    PossibleAiDetection,
                    FileFocusDurationText,
                    PasteCharCount,
                    MetadataJson
                FROM SessionEvents
                WHERE SessionId = @sessionId
                ORDER BY Id ASC
            `, { sessionId });

            const events = eventsResult.recordset.map((row: any) => {
                const event: any = {
                    time: row.RawTimeText || formatTimestamp(new Date(row.OccurredAt).getTime()),
                    flightTime: String(row.FlightTimeMs || 0),
                    eventType: row.EventType,
                    fileEdit: row.FileEditPath || '',
                    fileView: row.FileViewPath || ''
                };

                if (row.PossibleAiDetection) {
                    event.possibleAiDetection = row.PossibleAiDetection;
                }
                if (row.FileFocusDurationText) {
                    event.fileFocusCount = row.FileFocusDurationText;
                }
                if (row.PasteCharCount !== null) {
                    event.pasteCharCount = row.PasteCharCount;
                }
                if (row.MetadataJson) {
                    try {
                        const additional = JSON.parse(row.MetadataJson);
                        Object.assign(event, additional);
                    } catch {
                        // ignore invalid JSON
                    }
                }

                return event;
            });

            const verification = await this.verifySessionIntegrity(sessionId);
            metadata.integrityVerification = {
                verified: verification.verified,
                mismatchReason: verification.mismatchReason,
                expectedHash: verification.expectedHash,
                computedHash: verification.computedHash,
                eventCount: verification.eventCount
            };

            if (!verification.verified) {
                await executeQuery(
                    `INSERT INTO dbo.IntegrityAuditTrail (ActionType, SessionId, Details)
                     VALUES (@actionType, @sessionId, @details)`,
                    {
                        actionType: 'TAMPER_ALERT',
                        sessionId,
                        details: verification.mismatchReason || 'Session integrity verification failed.'
                    }
                );
            }

            const sessionData: SessionData = {
                sessionHeader: {
                    sessionNumber: sessionId,
                    startedBy: session.Username,
                    project: session.ProjectName,
                    startTime: formatTimestamp(new Date(session.StartedAt).getTime()),
                    metadata
                },
                events
            };

            return {
                text: JSON.stringify(sessionData, null, 2),
                partial: false
            };
        } catch (err) {
            console.error('[TBD Logger DB] Error retrieving session:', err);
            throw new Error('Failed to retrieve session data');
        }
    }

    /**
     * Save instructor notes for a session
     */
    async saveLogNotes(passwordAttempt: string, filename: string, notes: Array<{ timestamp: string; text: string }>): Promise<void> {
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }

        try {
            // Extract session ID from filename
            const sessionId = this.extractSessionIdFromFilename(filename);

            // Delete existing notes for this session
            await executeQuery(`
                DELETE FROM InstructorNotes
                WHERE SessionId = @sessionId
            `, { sessionId });

            // Insert new notes
            if (notes && notes.length > 0) {
                const pool = await getPool();
                const transaction = pool.transaction();
                await transaction.begin();

                try {
                    for (const note of notes) {
                        const request = transaction.request();
                        
                        let noteTime: Date;
                        try {
                            noteTime = new Date(note.timestamp);
                            if (isNaN(noteTime.getTime())) {
                                noteTime = new Date();
                            }
                        } catch {
                            noteTime = new Date();
                        }

                        request.input('sessionId', sessionId);
                        request.input('eventTimestampText', note.timestamp || formatTimestamp(noteTime.getTime()));
                        request.input('noteText', note.text);

                        await request.query(`
                            INSERT INTO InstructorNotes (SessionId, EventTimestampText, NoteText)
                            VALUES (@sessionId, @eventTimestampText, @noteText)
                        `);
                    }

                    await transaction.commit();
                    console.log(`[TBD Logger DB] Saved ${notes.length} notes for session ${sessionId}`);
                } catch (err) {
                    await transaction.rollback();
                    throw err;
                }
            }
        } catch (err) {
            console.error('[TBD Logger DB] Error saving notes:', err);
            throw new Error('Failed to save notes');
        }
    }

    /**
     * Load instructor notes for a session
     */
    async loadLogNotes(passwordAttempt: string, filename: string): Promise<Array<{ timestamp: string; text: string }>> {
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }

        try {
            // Extract session ID from filename
            const sessionId = this.extractSessionIdFromFilename(filename);

            const result = await executeQuery(`
                SELECT EventTimestampText, NoteText
                FROM InstructorNotes
                WHERE SessionId = @sessionId
                ORDER BY Id ASC
            `, { sessionId });

            return result.recordset.map((row: any) => ({
                timestamp: row.EventTimestampText || '',
                text: row.NoteText
            }));
        } catch (err) {
            console.error('[TBD Logger DB] Error loading notes:', err);
            return [];
        }
    }

    /**
     * Extract session ID from URI (tbd-db://session/{id})
     */
    private extractSessionIdFromUri(uri: vscode.Uri): number {
        const parts = uri.path.split('/');
        const id = parseInt(parts[parts.length - 1], 10);
        if (isNaN(id)) {
            throw new Error('Invalid session URI');
        }
        return id;
    }

    /**
     * Extract session ID from filename pattern: {user}-{project}-Session{id}-integrity.log
     */
    private extractSessionIdFromFilename(filename: string): number {
        const match = filename.match(/Session(\d+)-/);
        if (!match) {
            throw new Error('Invalid filename pattern');
        }
        return parseInt(match[1], 10);
    }

    /**
     * Retrieve hidden log content (for deletion tracking)
     * This functionality may need to be implemented differently with the database
     */
    async retrieveHiddenLogContent(passwordAttempt: string): Promise<string> {
        if (passwordAttempt !== SECRET_PASSPHRASE) {
            throw new Error('Invalid Password');
        }

        try {
            // Query integrity incidents
            const result = await executeQuery(`
                SELECT 
                    ii.IncidentTime,
                    ii.IncidentType,
                    ii.Details,
                    p.Name as ProjectName
                FROM IntegrityIncidents ii
                INNER JOIN Projects p ON ii.ProjectId = p.Id
                ORDER BY ii.IncidentTime DESC
            `);

            const incidents = result.recordset.map((row: any) => ({
                timestamp: formatTimestamp(new Date(row.IncidentTime).getTime()),
                type: row.IncidentType,
                project: row.ProjectName,
                details: row.Details
            }));

            return JSON.stringify(incidents, null, 2);
        } catch (err) {
            console.error('[TBD Logger DB] Error retrieving integrity incidents:', err);
            return '[]';
        }
    }

    /**
     * Cleanup on extension deactivation
     */
    async dispose(): Promise<void> {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
        // Close database connection
        await closePool();
        this.initialized = false;
        console.log('[TBD Logger DB] Storage manager disposed');
    }

    /**
     * Retrieve log content for a specific URI (compatibility method)
     * This is an alias for retrieveLogContentWithPassword that returns just the text
     */
    async retrieveLogContentForUri(passwordAttempt: string, fileUri: vscode.Uri): Promise<string> {
        const result = await this.retrieveLogContentWithPassword(passwordAttempt, fileUri);
        return result.text;
    }

    /**
     * Get the current session file URI (returns a synthetic URI for database session)
     */
    getSessionFileUri(): vscode.Uri | null {
        if (!this.currentSessionId) {
            return null;
        }
        return vscode.Uri.parse(`tbd-db://session/${this.currentSessionId}`);
    }

    /**
     * Check if database connection is currently active
     */
    isOnline(): boolean {
        return isConnected();
    }

    getBackgroundSyncStatus(): BackgroundSyncStatus {
        return {
            state: this.syncState,
            pendingQueueCount: this.pendingQueueCount,
            lastSyncedAt: this.formatMsIso(this.lastSyncedAtMs),
            lastError: this.lastSyncError,
            lastConflictAt: this.formatMsIso(this.lastConflictAtMs)
        };
    }

    /**
     * Check if database connection is currently being established
     */
    isConnecting(): boolean {
        return this.isConnectionInProgress;
    }

    private async ensureIntegritySchema(): Promise<void> {
        if (this.integritySchemaReady) {
            return;
        }

        await executeQuery(`
            IF OBJECT_ID('dbo.SessionEventIntegrity', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.SessionEventIntegrity (
                    EventId BIGINT NOT NULL PRIMARY KEY,
                    EventHash CHAR(64) NOT NULL,
                    PrevEventHash CHAR(64) NULL,
                    ChainHash CHAR(64) NOT NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT FK_SessionEventIntegrity_Event FOREIGN KEY (EventId) REFERENCES dbo.SessionEvents(Id)
                );
            END

            IF OBJECT_ID('dbo.SessionIntegritySnapshots', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.SessionIntegritySnapshots (
                    Id BIGINT IDENTITY(1,1) PRIMARY KEY,
                    SessionId BIGINT NOT NULL,
                    SequenceNumber INT NOT NULL,
                    EventCount INT NOT NULL,
                    SessionHash CHAR(64) NOT NULL,
                    LastChainHash CHAR(64) NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT UQ_SessionIntegritySnapshots UNIQUE (SessionId, SequenceNumber)
                );
            END

            IF OBJECT_ID('dbo.IntegrityAuditTrail', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.IntegrityAuditTrail (
                    Id BIGINT IDENTITY(1,1) PRIMARY KEY,
                    OccurredAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    ActionType NVARCHAR(50) NOT NULL,
                    SessionId BIGINT NULL,
                    EventId BIGINT NULL,
                    Actor NVARCHAR(256) NULL,
                    Details NVARCHAR(MAX) NULL
                );
            END

            EXEC('CREATE OR ALTER TRIGGER dbo.TR_SessionEvents_WORM_BlockUpdateDelete
                ON dbo.SessionEvents
                AFTER UPDATE, DELETE
                AS
                BEGIN
                    SET NOCOUNT ON;

                    INSERT INTO dbo.IntegrityAuditTrail (ActionType, SessionId, EventId, Actor, Details)
                    SELECT
                        CASE
                            WHEN EXISTS(SELECT 1 FROM inserted) AND EXISTS(SELECT 1 FROM deleted) THEN ''UPDATE_BLOCKED''
                            ELSE ''DELETE_BLOCKED''
                        END,
                        d.SessionId,
                        d.Id,
                        ORIGINAL_LOGIN(),
                        ''Write-once policy blocked modification on SessionEvents''
                    FROM deleted d;

                    ROLLBACK TRANSACTION;
                    RAISERROR(''SessionEvents are immutable (WORM policy): UPDATE/DELETE blocked.'', 16, 1);
                END');

            EXEC('CREATE OR ALTER TRIGGER dbo.TR_SessionEventIntegrity_WORM_BlockUpdateDelete
                ON dbo.SessionEventIntegrity
                INSTEAD OF UPDATE, DELETE
                AS
                BEGIN
                    SET NOCOUNT ON;
                    INSERT INTO dbo.IntegrityAuditTrail (ActionType, EventId, Actor, Details)
                    SELECT
                        CASE
                            WHEN EXISTS(SELECT 1 FROM inserted) AND EXISTS(SELECT 1 FROM deleted) THEN ''INTEGRITY_UPDATE_BLOCKED''
                            ELSE ''INTEGRITY_DELETE_BLOCKED''
                        END,
                        d.EventId,
                        ORIGINAL_LOGIN(),
                        ''Write-once policy blocked modification on SessionEventIntegrity''
                    FROM deleted d;

                    RAISERROR(''SessionEventIntegrity is immutable (WORM policy): UPDATE/DELETE blocked.'', 16, 1);
                END');

            EXEC('CREATE OR ALTER TRIGGER dbo.TR_SessionIntegritySnapshots_WORM_BlockUpdateDelete
                ON dbo.SessionIntegritySnapshots
                INSTEAD OF UPDATE, DELETE
                AS
                BEGIN
                    SET NOCOUNT ON;
                    INSERT INTO dbo.IntegrityAuditTrail (ActionType, SessionId, Actor, Details)
                    SELECT
                        CASE
                            WHEN EXISTS(SELECT 1 FROM inserted) AND EXISTS(SELECT 1 FROM deleted) THEN ''SNAPSHOT_UPDATE_BLOCKED''
                            ELSE ''SNAPSHOT_DELETE_BLOCKED''
                        END,
                        d.SessionId,
                        ORIGINAL_LOGIN(),
                        ''Write-once policy blocked modification on SessionIntegritySnapshots''
                    FROM deleted d;

                    RAISERROR(''SessionIntegritySnapshots are immutable (WORM policy): UPDATE/DELETE blocked.'', 16, 1);
                END');
        `);

        this.integritySchemaReady = true;
    }

    private async ensureUnmonitoredWorkSchema(): Promise<void> {
        await this.ensureIntegritySchema();

        await executeQuery(`
            IF OBJECT_ID('dbo.UnmonitoredWorkAlerts', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.UnmonitoredWorkAlerts (
                    Id BIGINT IDENTITY(1,1) PRIMARY KEY,
                    ObservedAt DATETIME2 NOT NULL,
                    IdeUser NVARCHAR(255) NOT NULL,
                    WorkspaceName NVARCHAR(255) NOT NULL,
                    WorkspacePath NVARCHAR(1024) NOT NULL,
                    Reason NVARCHAR(255) NOT NULL,
                    IsAcknowledged BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
                );
            END
        `);
    }

    async listRecentUnmonitoredWorkAlerts(limit = 50): Promise<UnmonitoredWorkAlertRecord[]> {
        await this.ensureUnmonitoredWorkSchema();

        const safeLimit = Math.max(1, Math.min(limit, 500));
        const result = await executeQuery(
            `SELECT TOP (${safeLimit})
                Id,
                CONVERT(VARCHAR, ObservedAt, 126) AS ObservedAt,
                IdeUser,
                WorkspaceName,
                WorkspacePath,
                Reason
             FROM dbo.UnmonitoredWorkAlerts
             ORDER BY ObservedAt DESC`
        );

        return result.recordset.map((row: any) => ({
            id: Number(row.Id),
            observedAt: row.ObservedAt || '',
            ideUser: row.IdeUser || '',
            workspaceName: row.WorkspaceName || '',
            workspacePath: row.WorkspacePath || '',
            reason: row.Reason || ''
        }));
    }

    async recordUnmonitoredWorkAlert(input: {
        ideUser: string;
        workspaceName: string;
        workspacePath: string;
        reason?: string;
    }): Promise<void> {
        const payload: UnmonitoredWorkAlertPayload = {
            observedAt: new Date().toISOString(),
            ideUser: input.ideUser,
            workspaceName: input.workspaceName,
            workspacePath: input.workspacePath,
            reason: input.reason || 'Workspace activity occurred while user was not authenticated in monitoring extension.'
        };

        try {
            await this.ensureUnmonitoredWorkSchema();
            await executeQuery(
                `INSERT INTO dbo.UnmonitoredWorkAlerts (ObservedAt, IdeUser, WorkspaceName, WorkspacePath, Reason)
                 VALUES (@observedAt, @ideUser, @workspaceName, @workspacePath, @reason)`,
                payload
            );
        } catch (err) {
            if (!this.unmonitoredAlertQueueDir) {
                return;
            }
            const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
            const uri = vscode.Uri.joinPath(this.unmonitoredAlertQueueDir, name);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload), 'utf8'));
        }
    }

    private async syncUnmonitoredWorkAlerts(): Promise<void> {
        if (this.isSyncingUnmonitoredAlerts || !this.unmonitoredAlertQueueDir) {
            return;
        }

        this.isSyncingUnmonitoredAlerts = true;
        try {
            await this.ensureUnmonitoredWorkSchema();
            const files = await vscode.workspace.fs.readDirectory(this.unmonitoredAlertQueueDir);
            const queueFiles = files
                .map(([name]) => name)
                .filter(name => name.endsWith('.json'))
                .sort();

            for (const fileName of queueFiles) {
                const fileUri = vscode.Uri.joinPath(this.unmonitoredAlertQueueDir, fileName);
                try {
                    const raw = await vscode.workspace.fs.readFile(fileUri);
                    const payload = JSON.parse(Buffer.from(raw).toString('utf8')) as UnmonitoredWorkAlertPayload;
                    await executeQuery(
                        `INSERT INTO dbo.UnmonitoredWorkAlerts (ObservedAt, IdeUser, WorkspaceName, WorkspacePath, Reason)
                         VALUES (@observedAt, @ideUser, @workspaceName, @workspacePath, @reason)`,
                        payload
                    );
                    await vscode.workspace.fs.delete(fileUri);
                } catch (err) {
                    break;
                }
            }
        } catch {
            // Defer to next timer tick.
        } finally {
            this.isSyncingUnmonitoredAlerts = false;
        }
    }

    async verifySessionIntegrity(sessionId: number): Promise<SessionIntegrityVerification> {
        await this.ensureIntegritySchema();

        const rows = await executeQuery(
            `SELECT
                se.Id AS EventId,
                se.SessionId,
                se.OccurredAt,
                se.RawTimeText,
                se.EventType,
                se.FlightTimeMs,
                se.FileEditPath,
                se.FileViewPath,
                se.FileFocusDurationText,
                se.PossibleAiDetection,
                se.PasteCharCount,
                se.MetadataJson,
                sei.EventHash,
                sei.PrevEventHash,
                sei.ChainHash
             FROM dbo.SessionEvents se
             LEFT JOIN dbo.SessionEventIntegrity sei ON sei.EventId = se.Id
             WHERE se.SessionId = @sessionId
             ORDER BY se.Id ASC`,
            { sessionId }
        );

        let previousChainHash = '';
        let mismatchReason: string | null = null;
        let lastChainHash = '';

        for (const row of rows.recordset) {
            if (!row.EventHash || !row.ChainHash) {
                mismatchReason = 'Missing integrity hash rows for one or more events.';
                break;
            }

            const occurredAt = row.OccurredAt ? new Date(row.OccurredAt) : new Date();
            const canonical = this.buildEventCanonicalPayload(
                Number(row.SessionId),
                occurredAt,
                row.RawTimeText || '',
                row.EventType || '',
                Number(row.FlightTimeMs || 0),
                row.FileEditPath || '',
                row.FileViewPath || '',
                row.FileFocusDurationText || null,
                row.PossibleAiDetection || null,
                row.PasteCharCount === null || row.PasteCharCount === undefined ? null : Number(row.PasteCharCount),
                row.MetadataJson || '{}'
            );

            const computedEventHash = this.hashSha256(canonical);
            if (computedEventHash !== row.EventHash) {
                mismatchReason = `Event hash mismatch at event ${row.EventId}.`;
                break;
            }

            const expectedChainHash = this.hashSha256(`${previousChainHash}|${computedEventHash}`);
            if (expectedChainHash !== row.ChainHash) {
                mismatchReason = `Chain hash mismatch at event ${row.EventId}.`;
                break;
            }

            if ((row.PrevEventHash || '') !== previousChainHash) {
                mismatchReason = `Previous hash link mismatch at event ${row.EventId}.`;
                break;
            }

            previousChainHash = expectedChainHash;
            lastChainHash = expectedChainHash;
        }

        const snapshotResult = await executeQuery(
            `SELECT TOP 1 SessionHash, EventCount
             FROM dbo.SessionIntegritySnapshots
             WHERE SessionId = @sessionId
             ORDER BY SequenceNumber DESC`,
            { sessionId }
        );

        const expectedHash = snapshotResult.recordset[0]?.SessionHash || null;
        const expectedEventCount = Number(snapshotResult.recordset[0]?.EventCount || rows.recordset.length);
        const computedHash = this.computeSessionRootHash(sessionId, rows.recordset.length, lastChainHash || '');

        if (!mismatchReason && expectedHash && expectedHash !== computedHash) {
            mismatchReason = 'Snapshot hash mismatch for this session.';
        }
        if (!mismatchReason && expectedEventCount !== rows.recordset.length) {
            mismatchReason = 'Snapshot event count does not match current session event count.';
        }

        return {
            sessionId,
            eventCount: rows.recordset.length,
            verified: !mismatchReason,
            mismatchReason,
            expectedHash,
            computedHash
        };
    }

    private async ensureAuthSchema(): Promise<void> {
        if (this.authSchemaReady) {
            return;
        }

        await executeQuery(`
            IF OBJECT_ID('dbo.ExtensionAuthUsers', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.ExtensionAuthUsers (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    Provider NVARCHAR(50) NOT NULL,
                    SubjectId NVARCHAR(255) NOT NULL,
                    Email NVARCHAR(255) NOT NULL,
                    DisplayName NVARCHAR(255) NOT NULL,
                    AssignedRole NVARCHAR(20) NOT NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT UQ_ExtensionAuthUsers_Provider_Subject UNIQUE (Provider, SubjectId)
                );
            END

            IF OBJECT_ID('dbo.ClassActivities', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.ClassActivities (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    TeacherAuthUserId INT NOT NULL,
                    Name NVARCHAR(200) NOT NULL,
                    Description NVARCHAR(1000) NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT FK_ClassActivities_TeacherAuthUser FOREIGN KEY (TeacherAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id)
                );
            END

            IF OBJECT_ID('dbo.WorkspaceActivityLinks', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.WorkspaceActivityLinks (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentAuthUserId INT NOT NULL,
                    TeacherAuthUserId INT NOT NULL,
                    ActivityId INT NOT NULL,
                    WorkspaceName NVARCHAR(255) NOT NULL,
                    WorkspaceRootPath NVARCHAR(1024) NOT NULL,
                    WorkspaceFoldersJson NVARCHAR(MAX) NOT NULL,
                    LinkedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT FK_WorkspaceActivityLinks_StudentAuthUser FOREIGN KEY (StudentAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id),
                    CONSTRAINT FK_WorkspaceActivityLinks_TeacherAuthUser FOREIGN KEY (TeacherAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id),
                    CONSTRAINT FK_WorkspaceActivityLinks_ClassActivity FOREIGN KEY (ActivityId) REFERENCES dbo.ClassActivities(Id),
                    CONSTRAINT UQ_WorkspaceActivityLinks_StudentWorkspace UNIQUE (StudentAuthUserId, WorkspaceRootPath)
                );
            END
        `);

        this.authSchemaReady = true;
    }

    async upsertAuthUser(identity: AuthIdentityInput): Promise<UpsertAuthUserResult> {
        await this.ensureAuthSchema();

        const existing = await executeQuery(
            `SELECT Id, AssignedRole FROM dbo.ExtensionAuthUsers WHERE Provider = @provider AND SubjectId = @subjectId`,
            { provider: identity.provider, subjectId: identity.subjectId }
        );

        if (existing.recordset.length > 0) {
            const row = existing.recordset[0];
            await executeQuery(
                `UPDATE dbo.ExtensionAuthUsers
                 SET Email = @email,
                     DisplayName = @displayName,
                     UpdatedAt = SYSUTCDATETIME()
                 WHERE Id = @id`,
                {
                    id: row.Id,
                    email: identity.email,
                    displayName: identity.displayName
                }
            );

            return {
                authUserId: row.Id,
                role: row.AssignedRole as UserRole,
                isNew: false
            };
        }

        const inserted = await executeQuery(
            `INSERT INTO dbo.ExtensionAuthUsers (Provider, SubjectId, Email, DisplayName, AssignedRole)
             OUTPUT INSERTED.Id, INSERTED.AssignedRole
             VALUES (@provider, @subjectId, @email, @displayName, @assignedRole)`,
            {
                provider: identity.provider,
                subjectId: identity.subjectId,
                email: identity.email,
                displayName: identity.displayName,
                assignedRole: 'Student'
            }
        );

        return {
            authUserId: inserted.recordset[0].Id,
            role: inserted.recordset[0].AssignedRole as UserRole,
            isNew: true
        };
    }

    async updateAuthUserRole(authUserId: number, role: UserRole): Promise<void> {
        await this.ensureAuthSchema();
        await executeQuery(
            `UPDATE dbo.ExtensionAuthUsers
             SET AssignedRole = @role,
                 UpdatedAt = SYSUTCDATETIME()
             WHERE Id = @authUserId`,
            { authUserId, role }
        );
    }

    async updateAuthUserDisplayName(authUserId: number, displayName: string): Promise<void> {
        await this.ensureAuthSchema();
        await executeQuery(
            `UPDATE dbo.ExtensionAuthUsers
             SET DisplayName = @displayName,
                 UpdatedAt = SYSUTCDATETIME()
             WHERE Id = @authUserId`,
            { authUserId, displayName }
        );
    }

    async findAuthUserByEmail(email: string): Promise<{ authUserId: number; role: UserRole; displayName: string } | null> {
        await this.ensureAuthSchema();
        const result = await executeQuery(
            `SELECT Id, AssignedRole, DisplayName FROM dbo.ExtensionAuthUsers
             WHERE Provider = 'email' AND SubjectId = @email`,
            { email: email.toLowerCase() }
        );
        if (result.recordset.length === 0) { return null; }
        const row = result.recordset[0];
        return { authUserId: row.Id, role: row.AssignedRole as UserRole, displayName: row.DisplayName };
    }

    async createClassActivity(teacherAuthUserId: number, name: string, description: string): Promise<number> {
        await this.ensureAuthSchema();

        const inserted = await executeQuery(
            `INSERT INTO dbo.ClassActivities (TeacherAuthUserId, Name, Description)
             OUTPUT INSERTED.Id
             VALUES (@teacherAuthUserId, @name, @description)`,
            {
                teacherAuthUserId,
                name,
                description: description || null
            }
        );

        return inserted.recordset[0].Id;
    }

    async listClassActivities(): Promise<ClassActivityRecord[]> {
        await this.ensureAuthSchema();

        const result = await executeQuery(`
            SELECT
                ca.Id,
                ca.Name,
                ISNULL(ca.Description, '') AS Description,
                ca.TeacherAuthUserId,
                eau.DisplayName AS TeacherDisplayName
            FROM dbo.ClassActivities ca
            INNER JOIN dbo.ExtensionAuthUsers eau ON eau.Id = ca.TeacherAuthUserId
            WHERE ca.IsActive = 1
            ORDER BY ca.CreatedAt DESC
        `);

        return result.recordset.map((row: any) => ({
            id: row.Id,
            name: row.Name,
            description: row.Description || '',
            teacherAuthUserId: row.TeacherAuthUserId,
            teacherDisplayName: row.TeacherDisplayName || 'Unknown Teacher'
        }));
    }

    async linkWorkspaceToActivity(input: WorkspaceActivityLinkInput): Promise<void> {
        await this.ensureAuthSchema();

        const existing = await executeQuery(
            `SELECT Id
             FROM dbo.WorkspaceActivityLinks
             WHERE StudentAuthUserId = @studentAuthUserId AND WorkspaceRootPath = @workspaceRootPath`,
            {
                studentAuthUserId: input.studentAuthUserId,
                workspaceRootPath: input.workspaceRootPath
            }
        );

        if (existing.recordset.length > 0) {
            await executeQuery(
                `UPDATE dbo.WorkspaceActivityLinks
                 SET TeacherAuthUserId = @teacherAuthUserId,
                     ActivityId = @activityId,
                     WorkspaceName = @workspaceName,
                     WorkspaceFoldersJson = @workspaceFoldersJson,
                     UpdatedAt = SYSUTCDATETIME()
                 WHERE Id = @id`,
                {
                    id: existing.recordset[0].Id,
                    teacherAuthUserId: input.teacherAuthUserId,
                    activityId: input.activityId,
                    workspaceName: input.workspaceName,
                    workspaceFoldersJson: input.workspaceFoldersJson
                }
            );
            return;
        }

        await executeQuery(
            `INSERT INTO dbo.WorkspaceActivityLinks (
                StudentAuthUserId,
                TeacherAuthUserId,
                ActivityId,
                WorkspaceName,
                WorkspaceRootPath,
                WorkspaceFoldersJson
            )
            VALUES (
                @studentAuthUserId,
                @teacherAuthUserId,
                @activityId,
                @workspaceName,
                @workspaceRootPath,
                @workspaceFoldersJson
            )`,
            {
                studentAuthUserId: input.studentAuthUserId,
                teacherAuthUserId: input.teacherAuthUserId,
                activityId: input.activityId,
                workspaceName: input.workspaceName,
                workspaceRootPath: input.workspaceRootPath,
                workspaceFoldersJson: input.workspaceFoldersJson
            }
        );
    }

    private async ensureClassesSchema(): Promise<void> {
        if (this.classesSchemaReady) { return; }
        await this.ensureAuthSchema();
        await executeQuery(`
            IF OBJECT_ID('dbo.Classes', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.Classes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    TeacherAuthUserId INT NOT NULL,
                    CourseName NVARCHAR(200) NOT NULL,
                    CourseCode NVARCHAR(50) NOT NULL,
                    TeacherName NVARCHAR(255) NOT NULL,
                    MeetingTime NVARCHAR(200) NOT NULL,
                    StartDate DATE NOT NULL,
                    EndDate DATE NOT NULL,
                    JoinCode NVARCHAR(20) NOT NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT UQ_Classes_JoinCode UNIQUE (JoinCode),
                    CONSTRAINT FK_Classes_TeacherAuthUser FOREIGN KEY (TeacherAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id)
                );
            END

            IF OBJECT_ID('dbo.ClassAssignments', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.ClassAssignments (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    ClassId INT NOT NULL,
                    Name NVARCHAR(200) NOT NULL,
                    Description NVARCHAR(1000) NULL,
                    DueDate DATE NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT FK_ClassAssignments_Class FOREIGN KEY (ClassId) REFERENCES dbo.Classes(Id)
                );
            END

            IF OBJECT_ID('dbo.StudentClassEnrollments', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.StudentClassEnrollments (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentAuthUserId INT NOT NULL,
                    TeacherAuthUserId INT NOT NULL,
                    ClassId INT NOT NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    IsActive BIT NOT NULL DEFAULT 1,
                    CONSTRAINT FK_StudentClassEnrollments_Student FOREIGN KEY (StudentAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id),
                    CONSTRAINT FK_StudentClassEnrollments_Teacher FOREIGN KEY (TeacherAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id),
                    CONSTRAINT FK_StudentClassEnrollments_Class FOREIGN KEY (ClassId) REFERENCES dbo.Classes(Id),
                    CONSTRAINT UQ_StudentClassEnrollments_StudentClass UNIQUE (StudentAuthUserId, ClassId)
                );
            END

            IF OBJECT_ID('dbo.StudentWorkspaceAssignments', 'U') IS NULL
            BEGIN
                CREATE TABLE dbo.StudentWorkspaceAssignments (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentAuthUserId INT NOT NULL,
                    TeacherAuthUserId INT NOT NULL,
                    ClassId INT NOT NULL,
                    AssignmentId INT NOT NULL,
                    WorkspaceName NVARCHAR(255) NOT NULL,
                    WorkspaceRootPath NVARCHAR(1024) NOT NULL,
                    WorkspaceFoldersJson NVARCHAR(MAX) NOT NULL,
                    LinkedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CONSTRAINT FK_StudentWorkspaceAssignments_Student FOREIGN KEY (StudentAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id),
                    CONSTRAINT FK_StudentWorkspaceAssignments_Teacher FOREIGN KEY (TeacherAuthUserId) REFERENCES dbo.ExtensionAuthUsers(Id),
                    CONSTRAINT FK_StudentWorkspaceAssignments_Class FOREIGN KEY (ClassId) REFERENCES dbo.Classes(Id),
                    CONSTRAINT FK_StudentWorkspaceAssignments_Assignment FOREIGN KEY (AssignmentId) REFERENCES dbo.ClassAssignments(Id),
                    CONSTRAINT UQ_StudentWorkspaceAssignments_StudentWorkspace UNIQUE (StudentAuthUserId, WorkspaceRootPath)
                );
            END

            INSERT INTO dbo.StudentClassEnrollments (StudentAuthUserId, TeacherAuthUserId, ClassId)
            SELECT DISTINCT swa.StudentAuthUserId, swa.TeacherAuthUserId, swa.ClassId
            FROM dbo.StudentWorkspaceAssignments swa
            LEFT JOIN dbo.StudentClassEnrollments sce
                ON sce.StudentAuthUserId = swa.StudentAuthUserId
               AND sce.ClassId = swa.ClassId
            WHERE sce.Id IS NULL;
        `);
        this.classesSchemaReady = true;
    }

    async createClass(input: CreateClassInput): Promise<ClassRecord> {
        await this.ensureClassesSchema();

        // Generate a unique join code (TBD-XXXXXX), retry on rare collision
        let joinCode = '';
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = 'TBD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
            const collision = await executeQuery(
                `SELECT Id FROM dbo.Classes WHERE JoinCode = @joinCode`,
                { joinCode: candidate }
            );
            if (collision.recordset.length === 0) {
                joinCode = candidate;
                break;
            }
        }
        if (!joinCode) { throw new Error('Failed to generate a unique class join code.'); }

        const inserted = await executeQuery(
            `INSERT INTO dbo.Classes (TeacherAuthUserId, CourseName, CourseCode, TeacherName, MeetingTime, StartDate, EndDate, JoinCode)
             OUTPUT INSERTED.Id, INSERTED.JoinCode, CONVERT(VARCHAR, INSERTED.CreatedAt, 126) AS CreatedAt
             VALUES (@teacherAuthUserId, @courseName, @courseCode, @teacherName, @meetingTime, @startDate, @endDate, @joinCode)`,
            {
                teacherAuthUserId: input.teacherAuthUserId,
                courseName: input.courseName,
                courseCode: input.courseCode,
                teacherName: input.teacherName,
                meetingTime: input.meetingTime,
                startDate: input.startDate,
                endDate: input.endDate,
                joinCode
            }
        );

        const row = inserted.recordset[0];
        return {
            id: row.Id,
            courseName: input.courseName,
            courseCode: input.courseCode,
            teacherName: input.teacherName,
            meetingTime: input.meetingTime,
            startDate: input.startDate,
            endDate: input.endDate,
            joinCode: row.JoinCode,
            teacherAuthUserId: input.teacherAuthUserId,
            createdAt: row.CreatedAt || ''
        };
    }

    async listTeacherClasses(teacherAuthUserId: number): Promise<ClassRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(`
            SELECT
                Id,
                CourseName,
                CourseCode,
                TeacherName,
                MeetingTime,
                CONVERT(VARCHAR(10), StartDate, 23) AS StartDate,
                CONVERT(VARCHAR(10), EndDate, 23) AS EndDate,
                JoinCode,
                TeacherAuthUserId,
                CONVERT(VARCHAR, CreatedAt, 126) AS CreatedAt
            FROM dbo.Classes
            WHERE TeacherAuthUserId = @teacherAuthUserId AND IsActive = 1
            ORDER BY CreatedAt DESC
        `, { teacherAuthUserId });

        return result.recordset.map((row: any) => ({
            id: row.Id,
            courseName: row.CourseName,
            courseCode: row.CourseCode,
            teacherName: row.TeacherName,
            meetingTime: row.MeetingTime,
            startDate: row.StartDate || '',
            endDate: row.EndDate || '',
            joinCode: row.JoinCode,
            teacherAuthUserId: row.TeacherAuthUserId,
            createdAt: row.CreatedAt || ''
        }));
    }

    async updateClass(input: UpdateClassInput): Promise<void> {
        await this.ensureClassesSchema();

        await executeQuery(
            `UPDATE dbo.Classes
             SET CourseName = @courseName,
                 CourseCode = @courseCode,
                 TeacherName = @teacherName,
                 MeetingTime = @meetingTime,
                 StartDate = @startDate,
                 EndDate = @endDate
             WHERE Id = @classId AND TeacherAuthUserId = @teacherAuthUserId AND IsActive = 1`,
            {
                classId: input.classId,
                teacherAuthUserId: input.teacherAuthUserId,
                courseName: input.courseName,
                courseCode: input.courseCode,
                teacherName: input.teacherName,
                meetingTime: input.meetingTime,
                startDate: input.startDate,
                endDate: input.endDate
            }
        );
    }

    async getTeacherClassById(classId: number, teacherAuthUserId: number): Promise<ClassRecord | undefined> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                Id,
                CourseName,
                CourseCode,
                TeacherName,
                MeetingTime,
                CONVERT(VARCHAR(10), StartDate, 23) AS StartDate,
                CONVERT(VARCHAR(10), EndDate, 23) AS EndDate,
                JoinCode,
                TeacherAuthUserId,
                CONVERT(VARCHAR, CreatedAt, 126) AS CreatedAt
             FROM dbo.Classes
             WHERE Id = @classId AND TeacherAuthUserId = @teacherAuthUserId AND IsActive = 1`,
            { classId, teacherAuthUserId }
        );

        if (result.recordset.length === 0) {
            return undefined;
        }

        const row = result.recordset[0];
        return {
            id: row.Id,
            courseName: row.CourseName,
            courseCode: row.CourseCode,
            teacherName: row.TeacherName,
            meetingTime: row.MeetingTime,
            startDate: row.StartDate || '',
            endDate: row.EndDate || '',
            joinCode: row.JoinCode,
            teacherAuthUserId: row.TeacherAuthUserId,
            createdAt: row.CreatedAt || ''
        };
    }

    async createClassAssignment(input: CreateClassAssignmentInput): Promise<ClassAssignmentRecord> {
        await this.ensureClassesSchema();

        const authorizedClass = await this.getTeacherClassById(input.classId, input.teacherAuthUserId);
        if (!authorizedClass) {
            throw new Error('Class not found or access denied.');
        }

        const inserted = await executeQuery(
            `INSERT INTO dbo.ClassAssignments (ClassId, Name, Description, DueDate)
             OUTPUT INSERTED.Id, INSERTED.ClassId, INSERTED.Name, ISNULL(INSERTED.Description, '') AS Description,
                    CONVERT(VARCHAR(10), INSERTED.DueDate, 23) AS DueDate,
                    CONVERT(VARCHAR, INSERTED.CreatedAt, 126) AS CreatedAt
             VALUES (@classId, @name, @description, @dueDate)`,
            {
                classId: input.classId,
                name: input.name,
                description: input.description || null,
                dueDate: input.dueDate || null
            }
        );

        const row = inserted.recordset[0];
        return {
            id: row.Id,
            classId: row.ClassId,
            name: row.Name,
            description: row.Description || '',
            dueDate: row.DueDate || '',
            createdAt: row.CreatedAt || ''
        };
    }

    async listClassAssignments(classId: number, teacherAuthUserId: number): Promise<ClassAssignmentRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                ca.Id,
                ca.ClassId,
                ca.Name,
                ISNULL(ca.Description, '') AS Description,
                CONVERT(VARCHAR(10), ca.DueDate, 23) AS DueDate,
                CONVERT(VARCHAR, ca.CreatedAt, 126) AS CreatedAt
             FROM dbo.ClassAssignments ca
             INNER JOIN dbo.Classes c ON c.Id = ca.ClassId
             WHERE ca.ClassId = @classId
               AND c.TeacherAuthUserId = @teacherAuthUserId
               AND ca.IsActive = 1
               AND c.IsActive = 1
             ORDER BY ca.CreatedAt DESC`,
            { classId, teacherAuthUserId }
        );

        return result.recordset.map((row: any) => ({
            id: row.Id,
            classId: row.ClassId,
            name: row.Name,
            description: row.Description || '',
            dueDate: row.DueDate || '',
            createdAt: row.CreatedAt || ''
        }));
    }

    async listClassStudents(classId: number, teacherAuthUserId: number): Promise<ClassStudentRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                eau.Id AS AuthUserId,
                eau.DisplayName AS StudentName,
                eau.Email AS StudentEmail,
                eau.AssignedRole AS AssignedRole,
                ca.Name AS AssignmentName,
                swa.WorkspaceName,
                swa.WorkspaceRootPath,
                CONVERT(VARCHAR, swa.LinkedAt, 126) AS LinkedAt
             FROM dbo.StudentWorkspaceAssignments swa
             INNER JOIN dbo.ExtensionAuthUsers eau ON eau.Id = swa.StudentAuthUserId
             INNER JOIN dbo.ClassAssignments ca ON ca.Id = swa.AssignmentId
             INNER JOIN dbo.Classes c ON c.Id = swa.ClassId
             WHERE swa.ClassId = @classId
               AND c.TeacherAuthUserId = @teacherAuthUserId
             ORDER BY swa.LinkedAt DESC`,
            { classId, teacherAuthUserId }
        );

        return result.recordset.map((row: any) => ({
            authUserId: row.AuthUserId,
            studentName: row.StudentName || 'Unknown Student',
            studentEmail: row.StudentEmail || '',
            role: (row.AssignedRole || 'Student') as UserRole,
            assignmentName: row.AssignmentName || 'Unknown Assignment',
            workspaceName: row.WorkspaceName || '',
            workspaceRootPath: row.WorkspaceRootPath || '',
            linkedAt: row.LinkedAt || ''
        }));
    }

    async listClassStudentsSummary(classId: number, teacherAuthUserId: number): Promise<ClassStudentSummaryRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                eau.Id AS AuthUserId,
                eau.DisplayName AS StudentName,
                eau.Email AS StudentEmail,
                eau.AssignedRole AS AssignedRole,
                CONVERT(VARCHAR, sce.CreatedAt, 126) AS LinkedAt
             FROM dbo.StudentClassEnrollments sce
             INNER JOIN dbo.ExtensionAuthUsers eau ON eau.Id = sce.StudentAuthUserId
             INNER JOIN dbo.Classes c ON c.Id = sce.ClassId
             WHERE sce.ClassId = @classId
               AND c.TeacherAuthUserId = @teacherAuthUserId
               AND sce.IsActive = 1
             ORDER BY eau.DisplayName ASC`,
            { classId, teacherAuthUserId }
        );

        return result.recordset.map((row: any) => ({
            authUserId: row.AuthUserId,
            studentName: row.StudentName || 'Unknown Student',
            studentEmail: row.StudentEmail || '',
            role: (row.AssignedRole || 'Student') as UserRole,
            linkedAt: row.LinkedAt || ''
        }));
    }

    async listAssignmentStudentWork(
        classId: number,
        assignmentId: number,
        teacherAuthUserId: number
    ): Promise<AssignmentStudentWorkRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                eau.Id AS AuthUserId,
                eau.DisplayName AS StudentName,
                eau.Email AS StudentEmail,
                eau.AssignedRole AS AssignedRole,
                COUNT(DISTINCT s.Id) AS SessionCount
             FROM dbo.StudentWorkspaceAssignments swa
             INNER JOIN dbo.ExtensionAuthUsers eau ON eau.Id = swa.StudentAuthUserId
             INNER JOIN dbo.Classes c ON c.Id = swa.ClassId
             LEFT JOIN dbo.Projects p ON p.Name = swa.WorkspaceName
             LEFT JOIN dbo.Sessions s ON s.ProjectId = p.Id
             WHERE swa.ClassId = @classId
               AND swa.AssignmentId = @assignmentId
               AND c.TeacherAuthUserId = @teacherAuthUserId
             GROUP BY eau.Id, eau.DisplayName, eau.Email, eau.AssignedRole
             ORDER BY eau.DisplayName ASC`,
            { classId, assignmentId, teacherAuthUserId }
        );

        return result.recordset.map((row: any) => ({
            authUserId: row.AuthUserId,
            studentName: row.StudentName || 'Unknown Student',
            studentEmail: row.StudentEmail || '',
            role: (row.AssignedRole || 'Student') as UserRole,
            sessionCount: Number(row.SessionCount || 0)
        }));
    }

    async listAssignmentStudentSessions(
        classId: number,
        assignmentId: number,
        studentAuthUserId: number,
        teacherAuthUserId: number
    ): Promise<AssignmentStudentSessionRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                s.Id AS SessionId,
                ISNULL(slf.OriginalFilename,
                    CONCAT(u.Username, '-', p.Name, '-Session', s.Id, '-integrity.log')) AS FileName,
                CONVERT(VARCHAR, s.StartedAt, 126) AS StartedAt,
                u.Username AS IdeUser,
                p.Name AS WorkspaceName
             FROM dbo.StudentWorkspaceAssignments swa
             INNER JOIN dbo.Classes c ON c.Id = swa.ClassId
             INNER JOIN dbo.Projects p ON p.Name = swa.WorkspaceName
             INNER JOIN dbo.Sessions s ON s.ProjectId = p.Id
             INNER JOIN dbo.Users u ON u.Id = s.UserId
             OUTER APPLY (
                SELECT TOP 1 OriginalFilename
                FROM dbo.SessionLogFiles slf
                WHERE slf.SessionId = s.Id
                ORDER BY slf.Id DESC
             ) slf
             WHERE swa.ClassId = @classId
               AND swa.AssignmentId = @assignmentId
               AND swa.StudentAuthUserId = @studentAuthUserId
               AND c.TeacherAuthUserId = @teacherAuthUserId
             ORDER BY s.StartedAt DESC, s.Id DESC`,
            { classId, assignmentId, studentAuthUserId, teacherAuthUserId }
        );

        return result.recordset.map((row: any) => ({
            sessionId: row.SessionId,
            filename: row.FileName,
            startedAt: row.StartedAt || '',
            ideUser: row.IdeUser || '',
            workspaceName: row.WorkspaceName || ''
        }));
    }

    async findClassByJoinCode(joinCode: string): Promise<ClassLookupRecord | undefined> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                c.Id,
                c.TeacherAuthUserId,
                c.TeacherName,
                c.CourseName,
                c.CourseCode,
                c.JoinCode
             FROM dbo.Classes c
             WHERE UPPER(c.JoinCode) = UPPER(@joinCode) AND c.IsActive = 1`,
            { joinCode: joinCode.trim() }
        );

        if (result.recordset.length === 0) {
            return undefined;
        }

        const row = result.recordset[0];
        return {
            id: row.Id,
            teacherAuthUserId: row.TeacherAuthUserId,
            teacherName: row.TeacherName,
            courseName: row.CourseName,
            courseCode: row.CourseCode,
            joinCode: row.JoinCode
        };
    }

async enrollStudentInClass(studentAuthUserId: number, classInfo: ClassLookupRecord): Promise<boolean> {
        await this.ensureClassesSchema();

        const existing = await executeQuery(
            `SELECT Id
             FROM dbo.StudentClassEnrollments
             WHERE StudentAuthUserId = @studentAuthUserId
               AND ClassId = @classId`,
            {
                studentAuthUserId,
                classId: classInfo.id
            }
        );

        // RAINY DAY: Double Enrollment Detection
        if (existing.recordset.length > 0) {
            // We just update the record to ensure it is active, but return false so the UI knows it's a duplicate
            await executeQuery(
                `UPDATE dbo.StudentClassEnrollments
                 SET TeacherAuthUserId = @teacherAuthUserId,
                     IsActive = 1,
                     UpdatedAt = SYSUTCDATETIME()
                 WHERE Id = @id`,
                {
                    id: existing.recordset[0].Id,
                    teacherAuthUserId: classInfo.teacherAuthUserId
                }
            );
            return false; 
        }

        await executeQuery(
            `INSERT INTO dbo.StudentClassEnrollments (StudentAuthUserId, TeacherAuthUserId, ClassId)
             VALUES (@studentAuthUserId, @teacherAuthUserId, @classId)`,
            {
                studentAuthUserId,
                teacherAuthUserId: classInfo.teacherAuthUserId,
                classId: classInfo.id
            }
        );
        
        return true; 
    }

    async listStudentClasses(studentAuthUserId: number): Promise<StudentClassRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                c.Id,
                c.CourseName,
                c.CourseCode,
                c.TeacherName,
                c.MeetingTime,
                CONVERT(VARCHAR(10), c.StartDate, 23) AS StartDate,
                CONVERT(VARCHAR(10), c.EndDate, 23) AS EndDate,
                c.JoinCode,
                                CONVERT(VARCHAR, MAX(sce.CreatedAt), 126) AS LinkedAt
                         FROM dbo.StudentClassEnrollments sce
                         INNER JOIN dbo.Classes c ON c.Id = sce.ClassId
                         WHERE sce.StudentAuthUserId = @studentAuthUserId
                             AND sce.IsActive = 1
               AND c.IsActive = 1
             GROUP BY
                c.Id,
                c.CourseName,
                c.CourseCode,
                c.TeacherName,
                c.MeetingTime,
                c.StartDate,
                c.EndDate,
                c.JoinCode
             ORDER BY c.CourseName ASC, c.CourseCode ASC`,
            { studentAuthUserId }
        );

        return result.recordset.map((row: any) => ({
            id: row.Id,
            courseName: row.CourseName || '',
            courseCode: row.CourseCode || '',
            teacherName: row.TeacherName || '',
            meetingTime: row.MeetingTime || '',
            startDate: row.StartDate || '',
            endDate: row.EndDate || '',
            joinCode: row.JoinCode || '',
            linkedAt: row.LinkedAt || ''
        }));
    }

    async listStudentAssignmentsForClass(
        studentAuthUserId: number,
        classId: number
    ): Promise<StudentClassAssignmentRecord[]> {
        await this.ensureClassesSchema();

        const membership = await executeQuery(
            `SELECT TOP 1 1 AS HasMembership
                         FROM dbo.StudentClassEnrollments
             WHERE StudentAuthUserId = @studentAuthUserId
                             AND ClassId = @classId
                             AND IsActive = 1`,
            { studentAuthUserId, classId }
        );

        if (membership.recordset.length === 0) {
            return [];
        }

        const result = await executeQuery(
            `SELECT
                ca.Id AS AssignmentId,
                ca.ClassId,
                ca.Name AS AssignmentName,
                ISNULL(ca.Description, '') AS Description,
                CONVERT(VARCHAR(10), ca.DueDate, 23) AS DueDate,
                ISNULL(linked.WorkspaceName, '') AS WorkspaceName,
                ISNULL(linked.WorkspaceRootPath, '') AS WorkspaceRootPath,
                ISNULL(linked.LinkedAt, '') AS LinkedAt
             FROM dbo.ClassAssignments ca
             INNER JOIN dbo.Classes c ON c.Id = ca.ClassId
             OUTER APPLY (
                SELECT TOP 1
                    swa.WorkspaceName,
                    swa.WorkspaceRootPath,
                    CONVERT(VARCHAR, swa.LinkedAt, 126) AS LinkedAt
                FROM dbo.StudentWorkspaceAssignments swa
                WHERE swa.StudentAuthUserId = @studentAuthUserId
                  AND swa.ClassId = ca.ClassId
                  AND swa.AssignmentId = ca.Id
                ORDER BY swa.UpdatedAt DESC, swa.LinkedAt DESC, swa.Id DESC
             ) linked
             WHERE ca.ClassId = @classId
               AND ca.IsActive = 1
               AND c.IsActive = 1
             ORDER BY ca.CreatedAt DESC, ca.Id DESC`,
            { studentAuthUserId, classId }
        );

        return result.recordset.map((row: any) => ({
            assignmentId: row.AssignmentId,
            classId: row.ClassId,
            assignmentName: row.AssignmentName || '',
            description: row.Description || '',
            dueDate: row.DueDate || '',
            workspaceName: row.WorkspaceName || '',
            workspaceRootPath: row.WorkspaceRootPath || '',
            linkedAt: row.LinkedAt || ''
        }));
    }

    async listAssignmentsForClass(classId: number): Promise<ClassAssignmentRecord[]> {
        await this.ensureClassesSchema();

        const result = await executeQuery(
            `SELECT
                Id,
                ClassId,
                Name,
                ISNULL(Description, '') AS Description,
                CONVERT(VARCHAR(10), DueDate, 23) AS DueDate,
                CONVERT(VARCHAR, CreatedAt, 126) AS CreatedAt
             FROM dbo.ClassAssignments
             WHERE ClassId = @classId AND IsActive = 1
             ORDER BY CreatedAt DESC`,
            { classId }
        );

        return result.recordset.map((row: any) => ({
            id: row.Id,
            classId: row.ClassId,
            name: row.Name,
            description: row.Description || '',
            dueDate: row.DueDate || '',
            createdAt: row.CreatedAt || ''
        }));
    }

    async linkStudentWorkspaceToAssignment(input: StudentAssignmentLinkInput): Promise<void> {
        await this.ensureClassesSchema();

        const classLookup = await executeQuery(
            `SELECT TOP 1 Id, TeacherAuthUserId
             FROM dbo.Classes
             WHERE Id = @classId AND IsActive = 1`,
            { classId: input.classId }
        );

        if (classLookup.recordset.length === 0) {
            throw new Error('Class not found.');
        }

        const resolvedTeacherAuthUserId = Number(classLookup.recordset[0].TeacherAuthUserId || 0);
        if (!Number.isFinite(resolvedTeacherAuthUserId) || resolvedTeacherAuthUserId <= 0) {
            throw new Error('Class teacher could not be resolved.');
        }

        await this.enrollStudentInClass(input.studentAuthUserId, {
            id: input.classId,
            teacherAuthUserId: resolvedTeacherAuthUserId,
            teacherName: '',
            courseName: '',
            courseCode: '',
            joinCode: ''
        });

        const existingAssignmentLink = await executeQuery(
            `SELECT TOP 1 Id
             FROM dbo.StudentWorkspaceAssignments
             WHERE StudentAuthUserId = @studentAuthUserId
               AND ClassId = @classId
               AND AssignmentId = @assignmentId`,
            {
                studentAuthUserId: input.studentAuthUserId,
                classId: input.classId,
                assignmentId: input.assignmentId
            }
        );

        if (existingAssignmentLink.recordset.length > 0) {
            throw new Error('A workspace is already linked to this assignment and cannot be changed.');
        }

        const existing = await executeQuery(
            `SELECT Id, ClassId, AssignmentId
             FROM dbo.StudentWorkspaceAssignments
             WHERE StudentAuthUserId = @studentAuthUserId
               AND WorkspaceRootPath = @workspaceRootPath`,
            {
                studentAuthUserId: input.studentAuthUserId,
                workspaceRootPath: input.workspaceRootPath
            }
        );

        if (existing.recordset.length > 0) {
            const existingRow = existing.recordset[0];
            if (Number(existingRow.ClassId) === input.classId && Number(existingRow.AssignmentId) === input.assignmentId) {
                throw new Error('This workspace is already linked to this assignment.');
            }
            throw new Error('This workspace folder is already linked to a different assignment.');
        }

        await executeQuery(
            `INSERT INTO dbo.StudentWorkspaceAssignments (
                StudentAuthUserId,
                TeacherAuthUserId,
                ClassId,
                AssignmentId,
                WorkspaceName,
                WorkspaceRootPath,
                WorkspaceFoldersJson
            )
            VALUES (
                @studentAuthUserId,
                @teacherAuthUserId,
                @classId,
                @assignmentId,
                @workspaceName,
                @workspaceRootPath,
                @workspaceFoldersJson
            )`,
            {
                studentAuthUserId: input.studentAuthUserId,
                teacherAuthUserId: resolvedTeacherAuthUserId,
                classId: input.classId,
                assignmentId: input.assignmentId,
                workspaceName: input.workspaceName,
                workspaceRootPath: input.workspaceRootPath,
                workspaceFoldersJson: input.workspaceFoldersJson
            }
        );
    }
    async validateAssignmentLink(studentAuthUserId: number, workspacePath: string): Promise<{ 
    classId: number; 
    assignmentId: number; 
    assignmentName: string; 
    courseName: string 
} | null> {
    await this.ensureClassesSchema();

    // Query to find the link and join with descriptive tables
    const result = await executeQuery(
        `SELECT swa.ClassId, swa.AssignmentId, ca.Name as AssignmentName, c.CourseName
         FROM dbo.StudentWorkspaceAssignments swa
         INNER JOIN dbo.ClassAssignments ca ON ca.Id = swa.AssignmentId
         INNER JOIN dbo.Classes c ON c.Id = swa.ClassId
         WHERE swa.StudentAuthUserId = @studentAuthUserId 
           AND swa.WorkspaceRootPath = @workspaceRootPath`,
        {
            studentAuthUserId,
            workspaceRootPath: workspacePath
        }
    );

    if (result && result.recordset && result.recordset.length > 0) {
        const row = result.recordset[0];
        return {
            classId: row.ClassId,
            assignmentId: row.AssignmentId,
            assignmentName: row.AssignmentName,
            courseName: row.CourseName
        };
    }
    return null;
}
    
}
