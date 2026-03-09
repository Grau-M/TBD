// Module: dbStorageManager.ts
// Purpose: Database-backed storage manager for session logs, events, and notes.
// Replaces file-based storage with Azure SQL database persistence while maintaining
// the same API interface as the original StorageManager for compatibility.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getSessionInfo } from './sessionInfo';
import { formatTimestamp } from './utils';
import { executeQuery, getPool, closePool } from './db';
import type { StandardEvent } from './types';

// SECURITY CONFIGURATION
const SECRET_PASSPHRASE = 'password';
const SALT = 'salty_buffer_tbd';
const KEY = crypto.scryptSync(SECRET_PASSPHRASE, SALT, 32);

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

export class DbStorageManager {
    private context!: vscode.ExtensionContext;
    private initialized = false;
    private currentSessionId: number | null = null;
    private currentUserId: number | null = null;
    private currentProjectId: number | null = null;

    async init(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        
        try {
            // Initialize database connection
            await getPool();
            console.log('[TBD Logger DB] Database connection initialized');

            // Get session info
            const info = getSessionInfo();
            
            // Ensure user exists
            this.currentUserId = await this.ensureUser(info.user);
            
            // Ensure project exists
            this.currentProjectId = await this.ensureProject(info.project, info.user);
            
            // Create new session
            this.currentSessionId = await this.createSession(info);
            
            this.initialized = true;
            console.log(`[TBD Logger DB] Session initialized: User=${this.currentUserId}, Project=${this.currentProjectId}, Session=${this.currentSessionId}`);
        } catch (err) {
            console.error('[TBD Logger DB] Failed to initialize database storage:', err);
            throw err;
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
            // Check if project exists
            const result = await executeQuery(
                `SELECT ProjectId FROM Projects WHERE Name = @name`,
                { name: projectName }
            );

            if (result.recordset.length > 0) {
                return result.recordset[0].ProjectId;
            }

            // Create new project (using project name as path for now)
            const insertResult = await executeQuery(
                `INSERT INTO Projects (Name, Path, CreatedBy) 
                 OUTPUT INSERTED.ProjectId
                 VALUES (@name, @path, @createdBy)`,
                { name: projectName, path: projectName, createdBy: username }
            );

            return insertResult.recordset[0].ProjectId;
        } catch (err) {
            console.error('[TBD Logger DB] Error ensuring project:', err);
            throw err;
        }
    }

    /**
     * Create a new session in the database
     */
    private async createSession(info: any): Promise<number> {
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
            const metadata = JSON.stringify({
                vscodeVersion: vscode.version,
                startTimestamp: formatTimestamp(startTime.getTime()),
                extensionVersion
            });

            // Create session - using UserId and ProjectId as per schema
            const insertResult = await executeQuery(
                `INSERT INTO Sessions (UserId, ProjectId, StartTime, Metadata, Status) 
                 OUTPUT INSERTED.SessionId
                 VALUES (@userId, @projectId, @startTime, @metadata, @status)`,
                {
                    userId: this.currentUserId,
                    projectId: this.currentProjectId,
                    startTime,
                    metadata,
                    status: 'active'
                }
            );

            const sessionId = insertResult.recordset[0].SessionId;

            // Create corresponding SessionLogFiles entry for compatibility
            const formattedStart = formatTimestamp(startTime.getTime());
            const filename = `${info.user}-${info.project}-Session${sessionId}-integrity.log`;
            
            await executeQuery(
                `INSERT INTO SessionLogFiles (SessionId, FileName, Format, CreatedAt) 
                 VALUES (@sessionId, @fileName, @format, @createdAt)`,
                {
                    sessionId,
                    fileName: filename,
                    format: 'json',
                    createdAt: startTime
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
            console.warn('[TBD Logger DB] Flush called but not initialized');
            return;
        }

        if (newEvents.length === 0) {
            return;
        }

        try {
            const pool = await getPool();
            const transaction = pool.transaction();
            await transaction.begin();

            try {
                for (const event of newEvents) {
                    const request = transaction.request();
                    
                    // Parse timestamp - handle the formatTimestamp output
                    let eventTime: Date;
                    try {
                        eventTime = new Date(event.time);
                        if (isNaN(eventTime.getTime())) {
                            eventTime = new Date();
                        }
                    } catch {
                        eventTime = new Date();
                    }

                    request.input('sessionId', this.currentSessionId);
                    request.input('sessionTime', eventTime);
                    request.input('eventType', event.eventType);
                    request.input('flightTime', event.flightTime || '0');
                    request.input('fileEdit', event.fileEdit || '');
                    request.input('fileView', event.fileView || '');
                    request.input('possibleAiDetection', event.possibleAiDetection || null);
                    request.input('fileFocusCount', event.fileFocusCount || null);
                    request.input('pasteCharCount', event.pasteCharCount || null);

                    // Store any additional fields as JSON
                    const additionalData: any = {};
                    for (const key in event) {
                        if (!['time', 'flightTime', 'eventType', 'fileEdit', 'fileView', 
                              'possibleAiDetection', 'fileFocusCount', 'pasteCharCount'].includes(key)) {
                            additionalData[key] = (event as any)[key];
                        }
                    }
                    const additionalDataJson = Object.keys(additionalData).length > 0 
                        ? JSON.stringify(additionalData) 
                        : null;
                    request.input('additionalData', additionalDataJson);

                    await request.query(`
                        INSERT INTO SessionEvents 
                        (SessionId, SessionTime, EventType, FlightTime, FileEdit, FileView, 
                         PossibleAiDetection, FileFocusCount, PasteCharCount, AdditionalData)
                        VALUES 
                        (@sessionId, @sessionTime, @eventType, @flightTime, @fileEdit, @fileView,
                         @possibleAiDetection, @fileFocusCount, @pasteCharCount, @additionalData)
                    `);
                }

                await transaction.commit();
                console.log(`[TBD Logger DB] Flushed ${newEvents.length} events to database`);
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        } catch (err) {
            console.error('[TBD Logger DB] Error flushing events:', err);
            // Don't throw - match original behavior of logging but not throwing
        }
    }

    /**
     * List available sessions (replaces listLogFiles)
     */
    async listLogFiles(): Promise<Array<{ label: string; uri: vscode.Uri }>> {
        try {
            const result = await executeQuery(`
                SELECT 
                    s.SessionId,
                    slf.FileName,
                    u.Username,
                    p.Name as ProjectName,
                    s.StartTime
                FROM Sessions s
                INNER JOIN SessionLogFiles slf ON s.SessionId = slf.SessionId
                INNER JOIN Users u ON s.UserId = u.UserId
                INNER JOIN Projects p ON s.ProjectId = p.ProjectId
                ORDER BY s.SessionId ASC
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
                    s.SessionId,
                    s.StartTime,
                    s.Metadata,
                    u.Username,
                    p.Name as ProjectName
                FROM Sessions s
                INNER JOIN Users u ON s.UserId = u.UserId
                INNER JOIN Projects p ON s.ProjectId = p.ProjectId
                WHERE s.SessionId = @sessionId
            `, { sessionId });

            if (headerResult.recordset.length === 0) {
                throw new Error('Session not found');
            }

            const session = headerResult.recordset[0];
            let metadata: any = {};
            try {
                metadata = JSON.parse(session.Metadata || '{}');
            } catch {
                metadata = {};
            }

            // Get all events for this session
            const eventsResult = await executeQuery(`
                SELECT 
                    SessionTime,
                    EventType,
                    FlightTime,
                    FileEdit,
                    FileView,
                    PossibleAiDetection,
                    FileFocusCount,
                    PasteCharCount,
                    AdditionalData
                FROM SessionEvents
                WHERE SessionId = @sessionId
                ORDER BY EventId ASC
            `, { sessionId });

            const events = eventsResult.recordset.map((row: any) => {
                const event: any = {
                    time: formatTimestamp(new Date(row.SessionTime).getTime()),
                    flightTime: row.FlightTime || '0',
                    eventType: row.EventType,
                    fileEdit: row.FileEdit || '',
                    fileView: row.FileView || ''
                };

                if (row.PossibleAiDetection) {
                    event.possibleAiDetection = row.PossibleAiDetection;
                }
                if (row.FileFocusCount) {
                    event.fileFocusCount = row.FileFocusCount;
                }
                if (row.PasteCharCount !== null) {
                    event.pasteCharCount = row.PasteCharCount;
                }
                if (row.AdditionalData) {
                    try {
                        const additional = JSON.parse(row.AdditionalData);
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
                    startTime: formatTimestamp(new Date(session.StartTime).getTime()),
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
                        request.input('noteTime', noteTime);
                        request.input('noteText', note.text);

                        await request.query(`
                            INSERT INTO InstructorNotes (SessionId, NoteTime, NoteText)
                            VALUES (@sessionId, @noteTime, @noteText)
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
                SELECT NoteTime, NoteText
                FROM InstructorNotes
                WHERE SessionId = @sessionId
                ORDER BY NoteId ASC
            `, { sessionId });

            return result.recordset.map((row: any) => ({
                timestamp: formatTimestamp(new Date(row.NoteTime).getTime()),
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
                INNER JOIN Projects p ON ii.ProjectId = p.ProjectId
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
}
