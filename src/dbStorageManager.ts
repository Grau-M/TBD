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
    private authSchemaReady = false;
    private classesSchemaReady = false;

    async init(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;

        const info = getSessionInfo();
        this.currentUserName = info.user;
        this.currentProjectName = info.project;

        this.offlineQueueDir = vscode.Uri.joinPath(context.globalStorageUri, 'offline-queue');
        await vscode.workspace.fs.createDirectory(this.offlineQueueDir);

        // Start connection in the background (don't await - let it connect while extension operates)
        void this.initializeOnlineSessionInBackground();

        this.syncTimer = setInterval(() => {
            void this.syncOfflineQueue();
        }, 30000);
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
            console.log('[TBD Logger DB] Database connection established successfully');
        } catch (err) {
            console.warn('[TBD Logger DB] Operating in offline mode. Events will be queued locally.', err);
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
            void this.syncOfflineQueue();
        } catch (err) {
            console.warn('[TBD Logger DB] Database write failed, queueing events for offline sync:', err);
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

    private async insertEventsForSession(sessionId: number, events: StandardEvent[]): Promise<void> {
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            for (const event of events) {
                const request = transaction.request();

                let eventTime: Date;
                try {
                    eventTime = new Date(event.time);
                    if (isNaN(eventTime.getTime())) {
                        eventTime = new Date();
                    }
                } catch {
                    eventTime = new Date();
                }

                request.input('sessionId', sessionId);
                request.input('occurredAt', eventTime);
                request.input('rawTimeText', event.time || formatTimestamp(Date.now()));
                request.input('eventType', event.eventType);
                request.input('flightTimeMs', parseInt(event.flightTime || '0', 10) || 0);
                request.input('fileEditPath', event.fileEdit || '');
                request.input('fileViewPath', event.fileView || '');
                request.input('fileFocusDurationText', event.fileFocusCount || null);
                request.input('possibleAiDetection', event.possibleAiDetection || null);
                request.input('pasteCharCount', event.pasteCharCount || null);

                const additionalData: Record<string, unknown> = {};
                for (const key in event) {
                    if (!['time', 'flightTime', 'eventType', 'fileEdit', 'fileView', 'possibleAiDetection', 'fileFocusCount', 'pasteCharCount'].includes(key)) {
                        additionalData[key] = (event as unknown as Record<string, unknown>)[key];
                    }
                }
                // MetadataJson is non-nullable in the current schema.
                const additionalDataJson = Object.keys(additionalData).length > 0 ? JSON.stringify(additionalData) : '{}';
                request.input('metadataJson', additionalDataJson);

                await request.query(`
                    INSERT INTO SessionEvents
                    (SessionId, OccurredAt, RawTimeText, FlightTimeMs, EventType,
                     FileEditPath, FileViewPath, FileFocusDurationText,
                     PossibleAiDetection, PasteCharCount, MetadataJson)
                    VALUES
                    (@sessionId, @occurredAt, @rawTimeText, @flightTimeMs, @eventType,
                     @fileEditPath, @fileViewPath, @fileFocusDurationText,
                     @possibleAiDetection, @pasteCharCount, @metadataJson)
                `);
            }

            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }

    private async enqueueOfflineBatch(batch: QueuedBatch): Promise<void> {
        if (!this.offlineQueueDir) {
            return;
        }
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        const uri = vscode.Uri.joinPath(this.offlineQueueDir, name);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(batch), 'utf8'));
    }

    private async syncOfflineQueue(): Promise<void> {
        if (this.isSyncing || !this.offlineQueueDir) {
            return;
        }

        this.isSyncing = true;
        try {
            const files = await vscode.workspace.fs.readDirectory(this.offlineQueueDir);
            const queueFiles = files
                .map(([name]) => name)
                .filter(name => name.endsWith('.json'))
                .sort();

            if (queueFiles.length === 0) {
                return;
            }

            await getPool();

            for (const fileName of queueFiles) {
                const fileUri = vscode.Uri.joinPath(this.offlineQueueDir, fileName);
                try {
                    const raw = await vscode.workspace.fs.readFile(fileUri);
                    const batch = JSON.parse(Buffer.from(raw).toString('utf8')) as QueuedBatch;
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

                    await this.insertEventsForSession(targetSessionId, batch.events);
                    await vscode.workspace.fs.delete(fileUri);
                } catch (err) {
                    console.warn('[TBD Logger DB] Offline sync paused due to error:', err);
                    break;
                }
            }
        } catch (err) {
            // Database likely still unavailable, keep queue for next sync attempt.
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

    /**
     * Check if database connection is currently being established
     */
    isConnecting(): boolean {
        return this.isConnectionInProgress;
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

        const existing = await executeQuery(
            `SELECT Id
             FROM dbo.StudentWorkspaceAssignments
             WHERE StudentAuthUserId = @studentAuthUserId
               AND WorkspaceRootPath = @workspaceRootPath`,
            {
                studentAuthUserId: input.studentAuthUserId,
                workspaceRootPath: input.workspaceRootPath
            }
        );

        if (existing.recordset.length > 0) {
            await executeQuery(
                `UPDATE dbo.StudentWorkspaceAssignments
                 SET TeacherAuthUserId = @teacherAuthUserId,
                     ClassId = @classId,
                     AssignmentId = @assignmentId,
                     WorkspaceName = @workspaceName,
                     WorkspaceFoldersJson = @workspaceFoldersJson,
                     UpdatedAt = SYSUTCDATETIME()
                 WHERE Id = @id`,
                {
                    id: existing.recordset[0].Id,
                    teacherAuthUserId: input.teacherAuthUserId,
                    classId: input.classId,
                    assignmentId: input.assignmentId,
                    workspaceName: input.workspaceName,
                    workspaceFoldersJson: input.workspaceFoldersJson
                }
            );
            return;
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
                teacherAuthUserId: input.teacherAuthUserId,
                classId: input.classId,
                assignmentId: input.assignmentId,
                workspaceName: input.workspaceName,
                workspaceRootPath: input.workspaceRootPath,
                workspaceFoldersJson: input.workspaceFoldersJson
            }
        );
    }
}
