import * as vscode from 'vscode';
import type { StandardEvent } from './types';
import { apiGet, apiPost } from './api';

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
        return {
            id: 1,
            teacherAuthUserId: 1,
            teacherName: 'Teacher',
            courseName: 'Course',
            courseCode: 'CODE101',
            joinCode
        };
    }

    async enrollStudentInClass(_studentAuthUserId: number, _linkedClass: any): Promise<boolean> {
        return true;
    }

    async listAssignmentsForClass(_classId: number): Promise<Array<{ id: number; name: string; dueDate?: string }>> {
        return [
            {
                id: 1,
                name: 'Default Assignment',
                dueDate: ''
            }
        ];
    }

    async linkStudentWorkspaceToAssignment(_input: any): Promise<void> {
        // no-op for API-only compatibility mode
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

    async listTeacherClasses(_teacherAuthUserId: number): Promise<any[]> {
        return [];
    }

    async createClass(_input: any): Promise<any> {
        return {
            id: Date.now(),
            joinCode: 'TBD-CLASS'
        };
    }

    async updateClass(_input: any): Promise<void> {
        // no-op
    }

    async getTeacherClassById(_classId: number, _teacherAuthUserId: number): Promise<any> {
        return undefined;
    }

    async listClassStudentsSummary(_classId: number, _teacherAuthUserId: number): Promise<any[]> {
        return [];
    }

    async listClassAssignments(_classId: number, _teacherAuthUserId: number): Promise<any[]> {
        return [];
    }

    async createClassAssignment(_input: any): Promise<any> {
        return { id: Date.now() };
    }

    async listAssignmentStudentWork(_classId: number, _assignmentId: number, _teacherAuthUserId: number): Promise<any[]> {
        return [];
    }

    async listAssignmentStudentSessions(
        _classId: number,
        _assignmentId: number,
        _teacherAuthUserId: number,
        _studentAuthUserId?: number
    ): Promise<any[]> {
        return [];
    }

    async listStudentClasses(_studentAuthUserId: number): Promise<any[]> {
        return [];
    }

    async listStudentAssignmentsForClass(_studentAuthUserId: number, _classId: number): Promise<any[]> {
        return [];
    }
}
