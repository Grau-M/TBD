import * as vscode from 'vscode';
import type { StandardEvent } from './types';

interface ApiSyncStatus {
    state: 'synced' | 'syncing' | 'offline' | 'queue-warning' | 'conflict' | 'idle';
    pendingQueueCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
    lastConflictAt: string | null;
}

interface SimpleAuthUser {
    authUserId: number;
    email: string;
    displayName: string;
    role: 'Student' | 'Teacher' | 'Admin';
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
    private nextAuthUserId = 1;
    private authUsersByEmail = new Map<string, SimpleAuthUser>();

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

    async upsertAuthUser(identity: { email: string; displayName: string; [key: string]: any }): Promise<{ authUserId: number; role: 'Student' | 'Teacher' | 'Admin'; isNew: boolean }> {
        const key = String(identity.email || '').toLowerCase();
        const existing = this.authUsersByEmail.get(key);
        if (existing) {
            return {
                authUserId: existing.authUserId,
                role: existing.role,
                isNew: false
            };
        }

        const created: SimpleAuthUser = {
            authUserId: this.nextAuthUserId++,
            email: key,
            displayName: identity.displayName,
            role: 'Student'
        };
        this.authUsersByEmail.set(key, created);

        return {
            authUserId: created.authUserId,
            role: created.role,
            isNew: true
        };
    }

    async updateAuthUserRole(authUserId: number, role: 'Student' | 'Teacher' | 'Admin'): Promise<void> {
        for (const [email, user] of this.authUsersByEmail.entries()) {
            if (user.authUserId === authUserId) {
                this.authUsersByEmail.set(email, { ...user, role });
                return;
            }
        }
    }

    async updateAuthUserDisplayName(authUserId: number, displayName: string): Promise<void> {
        for (const [email, user] of this.authUsersByEmail.entries()) {
            if (user.authUserId === authUserId) {
                this.authUsersByEmail.set(email, { ...user, displayName });
                return;
            }
        }
    }

    async findAuthUserByEmail(email: string): Promise<{ authUserId: number; role: 'Student' | 'Teacher' | 'Admin'; displayName: string } | null> {
        const found = this.authUsersByEmail.get(email.toLowerCase());
        if (!found) {
            return null;
        }
        return {
            authUserId: found.authUserId,
            role: found.role,
            displayName: found.displayName
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
