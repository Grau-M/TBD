import * as vscode from 'vscode';
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

export class ApiStorageManager {
    private context: vscode.ExtensionContext | null = null;
    private syncStatus: ApiSyncStatus = {
        state: 'idle',
        pendingQueueCount: 0,
        lastSyncedAt: null,
        lastError: null,
        lastConflictAt: null
    };

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

    private async apiGetFirst(paths: string[]): Promise<any> {
        let lastError: unknown;
        const tried: string[] = [];
        for (const path of paths) {
            tried.push(path);
            try {
                return await apiGet(path);
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
                return await apiPost(path, body);
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
                return await apiPut(path, body);
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
    }

    async flush(_newEvents: StandardEvent[]): Promise<void> {
        if (!this.context) {
            throw new Error('Storage manager is not initialized.');
        }

        const sessionId = this.context.workspaceState.get<number>('sessionId');
        if (!sessionId) {
            throw new Error('Cannot flush logs without an active session id.');
        }

        const session = this.context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const studentWorkspaceAssignmentId = Number(session?.workspaceLinkedAssignmentId ?? 0);

        for (const event of _newEvents) {
            const response = await apiPost('/api/events', {
                sessionId,
                eventType: event.eventType,
                occurredAt: event.time,
                StudentWorkspaceAssignmentId: studentWorkspaceAssignmentId > 0 ? studentWorkspaceAssignmentId : undefined,
                eventData: {
                    time: event.time,
                    flightTime: event.flightTime,
                    fileEdit: event.fileEdit,
                    fileView: event.fileView,
                    possibleAiDetection: event.possibleAiDetection,
                    fileFocusCount: event.fileFocusCount,
                    pasteCharCount: event.pasteCharCount,
                    StudentWorkspaceAssignmentId: studentWorkspaceAssignmentId > 0 ? studentWorkspaceAssignmentId : undefined
                }
            });

            const eventId = response?.event?.Id ?? response?.event?.id ?? response?.id ?? response?.Id;
            console.log(
                `[TBD Logger] Pushed event to /api/events: ${event.eventType} @ ${event.time}` +
                (eventId ? ` (event id: ${eventId})` : '')
            );
        }

        this.syncStatus.lastSyncedAt = new Date().toISOString();
        this.syncStatus.state = 'synced';
        console.log(`[TBD Logger] Flush complete: ${_newEvents.length} event(s) pushed to /api/events.`);
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
        return [];
    }

    async retrieveLogContentForUri(_passwordAttempt: string, _fileUri: vscode.Uri): Promise<string> {
        throw new Error('Log retrieval from local SQL storage is not available in API-only mode.');
    }

    async retrieveHiddenLogContent(_passwordAttempt: string): Promise<string> {
        throw new Error('Hidden log retrieval from local SQL storage is not available in API-only mode.');
    }

    async retrieveLogContentWithPassword(_passwordAttempt: string, _fileUri: vscode.Uri): Promise<{ text: string; partial: boolean }> {
        throw new Error('Log retrieval is not available in API-only mode.');
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

    // 1. Update the signature and payload for upsertAuthUser
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
            // ... (keep authUserId, role, isNew mapping) ...
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


    // Update the login/fetch methods so the session knows the consent state
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
        const result = await this.apiGetFirst([
            `/api/classes/join-code/${encodeURIComponent(joinCode.trim())}`,
            `/api/class/join-code/${encodeURIComponent(joinCode.trim())}`,
            `/api/classes/by-join-code?joinCode=${encodeURIComponent(joinCode.trim())}`,
            `/api/classes/join-code?joinCode=${encodeURIComponent(joinCode.trim())}`,
            `/api/class-activities/by-join-code?joinCode=${encodeURIComponent(joinCode.trim())}`
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

        return result?.link ?? result?.data ?? result;
    }

    async validateAssignmentLink(_authUserId: number, workspaceRoot: string): Promise<{
        classId: number;
        assignmentId: number;
        assignmentName: string;
        workspaceRootPath: string;
    } | null> {
        if (!workspaceRoot || !this.context) {
            return null;
        }

        // 👉 NEW FEATURE: Ask the backend if this file path is already registered!
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
                return {
                    classId: Number(result.classId || result.ClassId),
                    assignmentId: Number(result.assignmentId || result.AssignmentId),
                    assignmentName: String(result.assignmentName || result.AssignmentName || result.WorkplaceName || result.workplaceName || 'Linked Assignment'),
                    workspaceRootPath: workspaceRoot
                };
            }
        } catch (err) {
            console.log("[TBD Logger] Backend validation route unavailable. Falling back to local cache.");
        }

        // 👉 FALLBACK: Check local memory if the API doesn't respond
        const session = this.context.workspaceState.get<any>('tbd.auth.workspaceSession.v1');
        const classId = Number(session?.workspaceLinkedClassId ?? 0);
        const assignmentId = Number(session?.workspaceLinkedAssignmentId ?? 0);

        if (!classId || !assignmentId) {
            return null;
        }

        return {
            classId,
            assignmentId,
            assignmentName: String(session?.assignmentName || session?.AssignmentName || session?.workplaceName || session?.WorkplaceName || session?.displayName || 'Current Assignment'),
            workspaceRootPath: workspaceRoot
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
            // Some backends expose list routes as POST instead of GET.
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
                // Return empty list if no known listing route exists instead of crashing class tab.
                console.warn('Unable to list teacher classes from API:', String(postError?.message || postError));
                return [];
            }
        }

        return rows
            .filter((row: any) => {
                const rowTeacherId = Number(this.pick(row, ['teacherAuthUserId', 'TeacherAuthUserId', 'teacherId', 'TeacherId']) ?? 0);
                // If backend already filtered by teacher, keep rows that omit teacher id too.
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

        console.groupCollapsed('[TBD Teacher] Loading assignment sessions');
        console.log('Full URL being requested:', `${API_BASE}${primaryPath}`);
        console.log('Query parameters:', { classId, assignmentId, studentAuthUserId });
        console.log('Fallback request path:', `${API_BASE}${fallbackPath}`);

        let result: any;
        try {
            result = await this.apiGetFirst([
                primaryPath,
                fallbackPath
            ]);
            console.log('Raw JSON response from backend:', result);
        } catch (error) {
            console.error('[TBD Teacher] assignment sessions request failed:', {
                classId,
                assignmentId,
                studentAuthUserId,
                teacherAuthUserId: teacherId,
                error
            });
            console.groupEnd();
            throw error;
        }

        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.sessions) ? result.sessions : (Array.isArray(result?.data) ? result.data : []));
        console.log('Data shape before UI:', rows.map((row: any) => ({
            keys: Object.keys(row || {}),
            SessionId: row?.SessionId ?? row?.sessionId,
            StudentWorkspaceAssignmentId: row?.StudentWorkspaceAssignmentId ?? row?.studentWorkspaceAssignmentId,
            OccurredAt: row?.OccurredAt ?? row?.occurredAt,
            EventType: row?.EventType ?? row?.eventType,
            EventDataKeys: Object.keys(row?.EventData ?? row?.eventData ?? {})
        })));
        console.groupEnd();
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
        const result = await this.apiGetFirst([
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
            workspaceId: Number(this.pick(workspace, ['workspaceId', 'WorkspaceId']) ?? 0),
            workspaceName: String(this.pick(workspace, ['workspaceName', 'WorkspaceName']) || ''),
            workspaceRootPath: String(this.pick(workspace, ['workspaceRootPath', 'WorkspaceRootPath']) || ''),
            workspaceFoldersJson: String(this.pick(workspace, ['workspaceFoldersJson', 'WorkspaceFoldersJson']) || '[]'),
            linkedAt: String(this.pick(workspace, ['LinkedAt', 'linkedAt']) || ''),
            updatedAt: String(this.pick(workspace, ['UpdatedAt', 'updatedAt']) || '')
        };
    }
}
