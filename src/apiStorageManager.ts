import * as vscode from 'vscode';
import type { StandardEvent } from './types';
import { ApiHttpError, apiGet, apiPost } from './api';

interface ApiSyncStatus {
    state: 'synced' | 'syncing' | 'offline' | 'queue-warning' | 'conflict' | 'idle';
    pendingQueueCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
    lastConflictAt: string | null;
}

type UserRole = 'Student' | 'Teacher' | 'Admin';

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

    private pick(obj: any, keys: string[]): any {
        if (!obj || typeof obj !== 'object') {
            return undefined;
        }
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null) {
                return obj[key];
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

    async init(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        this.syncStatus.state = 'synced';
        this.syncStatus.lastError = null;
    }

    async flush(_newEvents: StandardEvent[]): Promise<void> {
        this.syncStatus.lastSyncedAt = new Date().toISOString();
        this.syncStatus.state = 'synced';
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

    async upsertAuthUser(identity: { email: string; displayName: string; [key: string]: any }): Promise<{ authUserId: number; role: UserRole; isNew: boolean }> {
        const email = String(identity.email || '').toLowerCase();
        const displayName = String(identity.displayName || '').trim();
        const provider = String(identity.provider || 'email').toLowerCase();
        const subjectId = String(identity.subjectId || email).trim();
        const username = String(identity.username || email).trim();
        const password = identity.password ? String(identity.password) : undefined;
        const role = identity.role ? this.normalizeRole(identity.role) : undefined;

        const payload = {
            provider,
            Provider: provider,
            subjectId,
            SubjectId: subjectId,
            email,
            Email: email,
            username,
            Username: username,
            displayName,
            DisplayName: displayName,
            password,
            Password: password,
            role,
            Role: role
        };

        const result = await apiPost('/api/auth/upsert-user', payload);
        const user = result?.user ?? result;
        return {
            authUserId: Number(this.pick(result, ['authUserId', 'AuthUserId']) ?? this.pick(user, ['id', 'Id', 'authUserId', 'AuthUserId']) ?? 0),
            role: this.normalizeRole(this.pick(result, ['role', 'Role']) ?? this.pick(user, ['role', 'Role'])),
            isNew: Boolean(this.pick(result, ['isNew', 'IsNew']) ?? false)
        };
    }

    async updateAuthUserRole(authUserId: number, role: UserRole): Promise<void> {
        await apiPost('/api/auth/update-role', {
            authUserId,
            AuthUserId: authUserId,
            role,
            Role: role
        });
    }

    async updateAuthUserDisplayName(authUserId: number, displayName: string, email?: string): Promise<void> {
        await apiPost('/api/auth/update-display-name', {
            authUserId,
            userId: authUserId,
            id: authUserId,
            AuthUserId: authUserId,
            displayName,
            DisplayName: displayName,
            email: email?.toLowerCase(),
            Email: email?.toLowerCase()
        });
    }

    async findAuthUserByEmail(email: string): Promise<{ authUserId: number; role: UserRole; displayName: string } | null> {
        const result = await apiGet(`/api/auth/user-by-email?email=${encodeURIComponent(email.toLowerCase())}`);
        const user = result?.user ?? result;
        const authUserId = Number(this.pick(user, ['authUserId', 'AuthUserId', 'id', 'Id']) ?? 0);
        if (!authUserId) {
            return null;
        }
        return {
            authUserId,
            role: this.normalizeRole(this.pick(user, ['role', 'Role'])),
            displayName: String(this.pick(user, ['displayName', 'DisplayName', 'username', 'Username', 'email', 'Email']) || 'user')
        };
    }

    async authenticateEmailPassword(email: string, password: string): Promise<{ authUserId: number; role: UserRole; displayName: string } | null> {
        const result = await apiPost('/api/auth/login', {
            email: email.toLowerCase(),
            Email: email.toLowerCase(),
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
            displayName: String(this.pick(user, ['displayName', 'DisplayName', 'username', 'Username']) || email)
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
            studentAuthUserId,
            StudentAuthUserId: studentAuthUserId,
            classId,
            ClassId: classId,
            teacherAuthUserId: Number(this.pick(linkedClass, ['teacherAuthUserId', 'TeacherAuthUserId']) ?? 0),
            TeacherAuthUserId: Number(this.pick(linkedClass, ['teacherAuthUserId', 'TeacherAuthUserId']) ?? 0)
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

    async linkStudentWorkspaceToAssignment(input: any): Promise<void> {
        await this.apiPostFirst([
            '/api/classes/link-student-assignment-workspace',
            '/api/student-assignment/link-workspace'
        ], {
            studentAuthUserId: Number(input?.studentAuthUserId ?? input?.StudentAuthUserId ?? 0),
            StudentAuthUserId: Number(input?.studentAuthUserId ?? input?.StudentAuthUserId ?? 0),
            teacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            TeacherAuthUserId: Number(input?.teacherAuthUserId ?? input?.TeacherAuthUserId ?? 0),
            classId: Number(input?.classId ?? input?.ClassId ?? 0),
            ClassId: Number(input?.classId ?? input?.ClassId ?? 0),
            assignmentId: Number(input?.assignmentId ?? input?.AssignmentId ?? 0),
            AssignmentId: Number(input?.assignmentId ?? input?.AssignmentId ?? 0),
            workspaceName: String(input?.workspaceName ?? input?.WorkspaceName ?? ''),
            WorkspaceName: String(input?.workspaceName ?? input?.WorkspaceName ?? ''),
            workspaceRootPath: String(input?.workspaceRootPath ?? input?.WorkspaceRootPath ?? ''),
            WorkspaceRootPath: String(input?.workspaceRootPath ?? input?.WorkspaceRootPath ?? ''),
            workspaceFoldersJson: String(input?.workspaceFoldersJson ?? input?.WorkspaceFoldersJson ?? '[]'),
            WorkspaceFoldersJson: String(input?.workspaceFoldersJson ?? input?.WorkspaceFoldersJson ?? '[]')
        });
    }

    async validateAssignmentLink(_authUserId: number, workspaceRoot: string): Promise<{ assignmentName: string; workspaceRootPath: string } | null> {
        if (!workspaceRoot) {
            return null;
        }
        return {
            assignmentName: 'Current Assignment',
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
            startDate: String(input?.startDate ?? input?.StartDate ?? ''),
            StartDate: String(input?.startDate ?? input?.StartDate ?? ''),
            endDate: String(input?.endDate ?? input?.EndDate ?? ''),
            EndDate: String(input?.endDate ?? input?.EndDate ?? ''),
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

        await this.apiPostFirst([
            '/api/classes/update',
            '/api/classes',
            '/api/classes/edit',
            '/api/class/update',
            '/api/class-activities/update',
            '/api/class-activities/edit'
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
            `/api/classes/students?classId=${classId}&teacherAuthUserId=${teacherAuthUserId}`
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
            `/api/classes/${classId}/assignments/${assignmentId}/students?teacherAuthUserId=${teacherAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.students) ? result.students : (Array.isArray(result?.data) ? result.data : []));
        return rows;
    }

    async listAssignmentStudentSessions(
        classId: number,
        assignmentId: number,
        studentAuthUserId: number,
        teacherAuthUserId?: number
    ): Promise<any[]> {
        const teacherId = Number(teacherAuthUserId ?? 0);
        const result = await this.apiGetFirst([
            `/api/classes/${classId}/assignments/${assignmentId}/students/${studentAuthUserId}/sessions?teacherAuthUserId=${teacherId}`,
            `/api/classes/assignment-student-sessions?classId=${classId}&assignmentId=${assignmentId}&studentAuthUserId=${studentAuthUserId}&teacherAuthUserId=${teacherId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.sessions) ? result.sessions : (Array.isArray(result?.data) ? result.data : []));
        return rows;
    }

    async listStudentClasses(studentAuthUserId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/student/classes?studentAuthUserId=${studentAuthUserId}`,
            `/api/classes/student?studentAuthUserId=${studentAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.classes) ? result.classes : (Array.isArray(result?.data) ? result.data : []));
        return rows;
    }

    async listStudentAssignmentsForClass(studentAuthUserId: number, classId: number): Promise<any[]> {
        const result = await this.apiGetFirst([
            `/api/student/classes/${classId}/assignments?studentAuthUserId=${studentAuthUserId}`,
            `/api/classes/${classId}/student-assignments?studentAuthUserId=${studentAuthUserId}`
        ]);
        const rows = Array.isArray(result)
            ? result
            : (Array.isArray(result?.assignments) ? result.assignments : (Array.isArray(result?.data) ? result.data : []));
        return rows;
    }
}
