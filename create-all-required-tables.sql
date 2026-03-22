/*
    TBD Logger - All Required Tables Bootstrap Script
    Target: Microsoft SQL Server / Azure SQL

    Safe to run multiple times (idempotent).
*/

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* =============================
   Core Logging Tables
   ============================= */

IF OBJECT_ID('dbo.Users', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Users (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        Username NVARCHAR(255) NOT NULL,
        DisplayName NVARCHAR(255) NOT NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_Users_Username UNIQUE (Username)
    );
END
GO

IF OBJECT_ID('dbo.Projects', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Projects (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        Name NVARCHAR(255) NOT NULL,
        WorkspacePath NVARCHAR(1024) NOT NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Projects_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_Projects_Name_WorkspacePath UNIQUE (Name, WorkspacePath)
    );
END
GO

IF OBJECT_ID('dbo.Sessions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Sessions (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        UserId BIGINT NOT NULL,
        ProjectId BIGINT NOT NULL,
        SessionNumber INT NOT NULL,
        StartedAt DATETIME2 NOT NULL,
        VscodeVersion NVARCHAR(64) NULL,
        ExtensionVersion NVARCHAR(64) NULL,
        RawStartTimestampText NVARCHAR(128) NULL,
        RecreationNotice NVARCHAR(4000) NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Sessions_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_Sessions_User FOREIGN KEY (UserId) REFERENCES dbo.Users(Id),
        CONSTRAINT FK_Sessions_Project FOREIGN KEY (ProjectId) REFERENCES dbo.Projects(Id),
        CONSTRAINT UQ_Sessions_User_Project_Number UNIQUE (UserId, ProjectId, SessionNumber)
    );
END
GO

IF OBJECT_ID('dbo.SessionLogFiles', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SessionLogFiles (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        SessionId BIGINT NOT NULL,
        OriginalFilename NVARCHAR(512) NOT NULL,
        StorageUri NVARCHAR(2048) NULL,
        IsActive BIT NOT NULL CONSTRAINT DF_SessionLogFiles_IsActive DEFAULT 1,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_SessionLogFiles_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_SessionLogFiles_Session FOREIGN KEY (SessionId) REFERENCES dbo.Sessions(Id)
    );
END
GO

IF OBJECT_ID('dbo.SessionEvents', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SessionEvents (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        SessionId BIGINT NOT NULL,
        OccurredAt DATETIME2 NOT NULL,
        RawTimeText NVARCHAR(128) NULL,
        FlightTimeMs INT NOT NULL CONSTRAINT DF_SessionEvents_FlightTimeMs DEFAULT 0,
        EventType NVARCHAR(100) NOT NULL,
        FileEditPath NVARCHAR(2048) NULL,
        FileViewPath NVARCHAR(2048) NULL,
        FileFocusDurationText NVARCHAR(128) NULL,
        PossibleAiDetection NVARCHAR(255) NULL,
        PasteCharCount INT NULL,
        MetadataJson NVARCHAR(MAX) NOT NULL CONSTRAINT DF_SessionEvents_MetadataJson DEFAULT N'{}',
        /* Compatibility column: older merge logic reads EventData */
        EventData NVARCHAR(MAX) NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_SessionEvents_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_SessionEvents_Session FOREIGN KEY (SessionId) REFERENCES dbo.Sessions(Id)
    );
END
GO

IF OBJECT_ID('dbo.InstructorNotes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.InstructorNotes (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        SessionId BIGINT NOT NULL,
        EventTimestampText NVARCHAR(128) NOT NULL,
        NoteText NVARCHAR(MAX) NOT NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_InstructorNotes_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_InstructorNotes_Session FOREIGN KEY (SessionId) REFERENCES dbo.Sessions(Id)
    );
END
GO

IF OBJECT_ID('dbo.IntegrityIncidents', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.IntegrityIncidents (
        Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        IncidentTime DATETIME2 NOT NULL CONSTRAINT DF_IntegrityIncidents_IncidentTime DEFAULT SYSUTCDATETIME(),
        IncidentType NVARCHAR(100) NOT NULL,
        Details NVARCHAR(MAX) NULL,
        ProjectId BIGINT NOT NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_IntegrityIncidents_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_IntegrityIncidents_Project FOREIGN KEY (ProjectId) REFERENCES dbo.Projects(Id)
    );
END
GO

/* =============================
   Integrity / WORM Tables
   ============================= */

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
GO

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
        CONSTRAINT FK_SessionIntegritySnapshots_Session FOREIGN KEY (SessionId) REFERENCES dbo.Sessions(Id),
        CONSTRAINT UQ_SessionIntegritySnapshots UNIQUE (SessionId, SequenceNumber)
    );
END
GO

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
GO

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
GO

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
GO

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
GO

/* =============================
   Sync / Purge / Alert Tables
   ============================= */

IF OBJECT_ID('dbo.SessionSyncConflicts', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SessionSyncConflicts (
        Id BIGINT IDENTITY(1,1) PRIMARY KEY,
        SessionId BIGINT NOT NULL,
        DetectedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        ResolutionStrategy NVARCHAR(100) NOT NULL,
        DetailsJson NVARCHAR(MAX) NOT NULL,
        IsResolved BIT NOT NULL DEFAULT 0,
        CONSTRAINT FK_SessionSyncConflicts_Session FOREIGN KEY (SessionId) REFERENCES dbo.Sessions(Id)
    );
END
GO

IF OBJECT_ID('dbo.PurgeAuditLogs', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PurgeAuditLogs (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        PurgedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        SessionsDeleted INT NOT NULL,
        EventsDeleted INT NOT NULL,
        Summary NVARCHAR(MAX) NOT NULL
    );
END
GO

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
GO

/* =============================
   Legacy Purge Compatibility Tables
   (Used by runAutomatedDataPurge)
   ============================= */

IF OBJECT_ID('dbo.ExtensionSessions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ExtensionSessions (
        Id BIGINT IDENTITY(1,1) PRIMARY KEY,
        CourseEndDate DATETIME2 NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        NeedsManualReview BIT NOT NULL DEFAULT 0
    );
END
GO

IF OBJECT_ID('dbo.ExtensionEvents', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ExtensionEvents (
        Id BIGINT IDENTITY(1,1) PRIMARY KEY,
        SessionId BIGINT NOT NULL,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_ExtensionEvents_ExtensionSessions FOREIGN KEY (SessionId) REFERENCES dbo.ExtensionSessions(Id)
    );
END
GO

IF COL_LENGTH('dbo.ExtensionSessions', 'NeedsManualReview') IS NULL
BEGIN
    ALTER TABLE dbo.ExtensionSessions ADD NeedsManualReview BIT NOT NULL CONSTRAINT DF_ExtensionSessions_NeedsManualReview DEFAULT 0;
END
GO

/* =============================
   Auth / Classroom Tables
   ============================= */

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
GO

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
GO

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
GO

IF OBJECT_ID('dbo.UserConsentsV2', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserConsentsV2 (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Username NVARCHAR(255) NOT NULL,
        PolicyVersion NVARCHAR(50) NOT NULL,
        ConsentGivenAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

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
GO

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
GO

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
GO

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
GO

/* =============================
   Helpful Indexes
   ============================= */

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SessionEvents_SessionId_OccurredAt' AND object_id = OBJECT_ID('dbo.SessionEvents'))
BEGIN
    CREATE INDEX IX_SessionEvents_SessionId_OccurredAt ON dbo.SessionEvents (SessionId, OccurredAt);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Sessions_ProjectId_StartedAt' AND object_id = OBJECT_ID('dbo.Sessions'))
BEGIN
    CREATE INDEX IX_Sessions_ProjectId_StartedAt ON dbo.Sessions (ProjectId, StartedAt);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SessionLogFiles_SessionId_Id' AND object_id = OBJECT_ID('dbo.SessionLogFiles'))
BEGIN
    CREATE INDEX IX_SessionLogFiles_SessionId_Id ON dbo.SessionLogFiles (SessionId, Id DESC);
END
GO
