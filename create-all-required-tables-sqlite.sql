-- TBD Logger - All Required Tables Bootstrap Script (SQLite/Turso)
-- Safe to run multiple times (idempotent).

PRAGMA foreign_keys = ON;

/* =============================
   Core Logging Tables
   ============================= */

CREATE TABLE IF NOT EXISTS Users (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Username TEXT NOT NULL UNIQUE,
    DisplayName TEXT NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Projects (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT NOT NULL,
    WorkspacePath TEXT NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (Name, WorkspacePath)
);

CREATE TABLE IF NOT EXISTS Sessions (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    UserId INTEGER NOT NULL,
    ProjectId INTEGER NOT NULL,
    SessionNumber INTEGER NOT NULL,
    StartedAt TEXT NOT NULL,
    VscodeVersion TEXT,
    ExtensionVersion TEXT,
    RawStartTimestampText TEXT,
    RecreationNotice TEXT,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (UserId, ProjectId, SessionNumber),
    FOREIGN KEY (UserId) REFERENCES Users(Id),
    FOREIGN KEY (ProjectId) REFERENCES Projects(Id)
);

CREATE TABLE IF NOT EXISTS SessionLogFiles (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    SessionId INTEGER NOT NULL,
    OriginalFilename TEXT NOT NULL,
    StorageUri TEXT,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (SessionId) REFERENCES Sessions(Id)
);

CREATE TABLE IF NOT EXISTS SessionEvents (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    SessionId INTEGER NOT NULL,
    OccurredAt TEXT NOT NULL,
    RawTimeText TEXT,
    FlightTimeMs INTEGER NOT NULL DEFAULT 0,
    EventType TEXT NOT NULL,
    FileEditPath TEXT,
    FileViewPath TEXT,
    FileFocusDurationText TEXT,
    PossibleAiDetection TEXT,
    PasteCharCount INTEGER,
    -- SQLite stores JSON as TEXT. Use JSON.stringify on write and JSON.parse on read.
    MetadataJson TEXT NOT NULL DEFAULT '{}',
    EventData TEXT,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (SessionId) REFERENCES Sessions(Id)
);

CREATE TABLE IF NOT EXISTS InstructorNotes (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    SessionId INTEGER NOT NULL,
    EventTimestampText TEXT NOT NULL,
    NoteText TEXT NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (SessionId) REFERENCES Sessions(Id)
);

CREATE TABLE IF NOT EXISTS IntegrityIncidents (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    IncidentTime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    IncidentType TEXT NOT NULL,
    Details TEXT,
    ProjectId INTEGER NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ProjectId) REFERENCES Projects(Id)
);

/* =============================
   Integrity / WORM Tables
   ============================= */

CREATE TABLE IF NOT EXISTS SessionEventIntegrity (
    EventId INTEGER PRIMARY KEY,
    EventHash TEXT NOT NULL,
    PrevEventHash TEXT,
    ChainHash TEXT NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (EventId) REFERENCES SessionEvents(Id)
);

CREATE TABLE IF NOT EXISTS SessionIntegritySnapshots (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    SessionId INTEGER NOT NULL,
    SequenceNumber INTEGER NOT NULL,
    EventCount INTEGER NOT NULL,
    SessionHash TEXT NOT NULL,
    LastChainHash TEXT,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (SessionId, SequenceNumber),
    FOREIGN KEY (SessionId) REFERENCES Sessions(Id)
);

CREATE TABLE IF NOT EXISTS IntegrityAuditTrail (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    OccurredAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ActionType TEXT NOT NULL,
    SessionId INTEGER,
    EventId INTEGER,
    Actor TEXT,
    Details TEXT
);

DROP TRIGGER IF EXISTS TR_SessionEvents_WORM_BlockUpdate;
CREATE TRIGGER TR_SessionEvents_WORM_BlockUpdate
BEFORE UPDATE ON SessionEvents
FOR EACH ROW
BEGIN
    INSERT INTO IntegrityAuditTrail (ActionType, SessionId, EventId, Actor, Details)
    VALUES ('UPDATE_BLOCKED', OLD.SessionId, OLD.Id, NULL, 'Write-once policy blocked modification on SessionEvents');
    SELECT RAISE(ABORT, 'SessionEvents are immutable (WORM policy): UPDATE blocked.');
END;

DROP TRIGGER IF EXISTS TR_SessionEvents_WORM_BlockDelete;
CREATE TRIGGER TR_SessionEvents_WORM_BlockDelete
BEFORE DELETE ON SessionEvents
FOR EACH ROW
BEGIN
    INSERT INTO IntegrityAuditTrail (ActionType, SessionId, EventId, Actor, Details)
    VALUES ('DELETE_BLOCKED', OLD.SessionId, OLD.Id, NULL, 'Write-once policy blocked modification on SessionEvents');
    SELECT RAISE(ABORT, 'SessionEvents are immutable (WORM policy): DELETE blocked.');
END;

DROP TRIGGER IF EXISTS TR_SessionEventIntegrity_WORM_BlockUpdate;
CREATE TRIGGER TR_SessionEventIntegrity_WORM_BlockUpdate
BEFORE UPDATE ON SessionEventIntegrity
FOR EACH ROW
BEGIN
    INSERT INTO IntegrityAuditTrail (ActionType, EventId, Actor, Details)
    VALUES ('INTEGRITY_UPDATE_BLOCKED', OLD.EventId, NULL, 'Write-once policy blocked modification on SessionEventIntegrity');
    SELECT RAISE(ABORT, 'SessionEventIntegrity is immutable (WORM policy): UPDATE blocked.');
END;

DROP TRIGGER IF EXISTS TR_SessionEventIntegrity_WORM_BlockDelete;
CREATE TRIGGER TR_SessionEventIntegrity_WORM_BlockDelete
BEFORE DELETE ON SessionEventIntegrity
FOR EACH ROW
BEGIN
    INSERT INTO IntegrityAuditTrail (ActionType, EventId, Actor, Details)
    VALUES ('INTEGRITY_DELETE_BLOCKED', OLD.EventId, NULL, 'Write-once policy blocked modification on SessionEventIntegrity');
    SELECT RAISE(ABORT, 'SessionEventIntegrity is immutable (WORM policy): DELETE blocked.');
END;

DROP TRIGGER IF EXISTS TR_SessionIntegritySnapshots_WORM_BlockUpdate;
CREATE TRIGGER TR_SessionIntegritySnapshots_WORM_BlockUpdate
BEFORE UPDATE ON SessionIntegritySnapshots
FOR EACH ROW
BEGIN
    INSERT INTO IntegrityAuditTrail (ActionType, SessionId, Actor, Details)
    VALUES ('SNAPSHOT_UPDATE_BLOCKED', OLD.SessionId, NULL, 'Write-once policy blocked modification on SessionIntegritySnapshots');
    SELECT RAISE(ABORT, 'SessionIntegritySnapshots are immutable (WORM policy): UPDATE blocked.');
END;

DROP TRIGGER IF EXISTS TR_SessionIntegritySnapshots_WORM_BlockDelete;
CREATE TRIGGER TR_SessionIntegritySnapshots_WORM_BlockDelete
BEFORE DELETE ON SessionIntegritySnapshots
FOR EACH ROW
BEGIN
    INSERT INTO IntegrityAuditTrail (ActionType, SessionId, Actor, Details)
    VALUES ('SNAPSHOT_DELETE_BLOCKED', OLD.SessionId, NULL, 'Write-once policy blocked modification on SessionIntegritySnapshots');
    SELECT RAISE(ABORT, 'SessionIntegritySnapshots are immutable (WORM policy): DELETE blocked.');
END;

/* =============================
   Sync / Purge / Alert Tables
   ============================= */

CREATE TABLE IF NOT EXISTS SessionSyncConflicts (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    SessionId INTEGER NOT NULL,
    DetectedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ResolutionStrategy TEXT NOT NULL,
    DetailsJson TEXT NOT NULL,
    IsResolved INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (SessionId) REFERENCES Sessions(Id)
);

CREATE TABLE IF NOT EXISTS PurgeAuditLogs (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    PurgedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    SessionsDeleted INTEGER NOT NULL,
    EventsDeleted INTEGER NOT NULL,
    Summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS UnmonitoredWorkAlerts (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    ObservedAt TEXT NOT NULL,
    IdeUser TEXT NOT NULL,
    WorkspaceName TEXT NOT NULL,
    WorkspacePath TEXT NOT NULL,
    Reason TEXT NOT NULL,
    IsAcknowledged INTEGER NOT NULL DEFAULT 0,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* =============================
   Legacy Purge Compatibility Tables
   ============================= */

CREATE TABLE IF NOT EXISTS ExtensionSessions (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    CourseEndDate TEXT,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    NeedsManualReview INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ExtensionEvents (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    SessionId INTEGER NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (SessionId) REFERENCES ExtensionSessions(Id)
);

/* =============================
   Auth / Classroom Tables
   ============================= */

CREATE TABLE IF NOT EXISTS ExtensionAuthUsers (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Provider TEXT NOT NULL,
    SubjectId TEXT NOT NULL,
    Email TEXT NOT NULL,
    DisplayName TEXT NOT NULL,
    AssignedRole TEXT NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (Provider, SubjectId)
);

CREATE TABLE IF NOT EXISTS ClassActivities (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    TeacherAuthUserId INTEGER NOT NULL,
    Name TEXT NOT NULL,
    Description TEXT,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (TeacherAuthUserId) REFERENCES ExtensionAuthUsers(Id)
);

CREATE TABLE IF NOT EXISTS WorkspaceActivityLinks (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    StudentAuthUserId INTEGER NOT NULL,
    TeacherAuthUserId INTEGER NOT NULL,
    ActivityId INTEGER NOT NULL,
    WorkspaceName TEXT NOT NULL,
    WorkspaceRootPath TEXT NOT NULL,
    WorkspaceFoldersJson TEXT NOT NULL,
    LinkedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (StudentAuthUserId, WorkspaceRootPath),
    FOREIGN KEY (StudentAuthUserId) REFERENCES ExtensionAuthUsers(Id),
    FOREIGN KEY (TeacherAuthUserId) REFERENCES ExtensionAuthUsers(Id),
    FOREIGN KEY (ActivityId) REFERENCES ClassActivities(Id)
);

CREATE TABLE IF NOT EXISTS UserConsentsV2 (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Username TEXT NOT NULL,
    PolicyVersion TEXT NOT NULL,
    ConsentGivenAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Classes (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    TeacherAuthUserId INTEGER NOT NULL,
    CourseName TEXT NOT NULL,
    CourseCode TEXT NOT NULL,
    TeacherName TEXT NOT NULL,
    MeetingTime TEXT NOT NULL,
    StartDate TEXT NOT NULL,
    EndDate TEXT NOT NULL,
    JoinCode TEXT NOT NULL UNIQUE,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (TeacherAuthUserId) REFERENCES ExtensionAuthUsers(Id)
);

CREATE TABLE IF NOT EXISTS ClassAssignments (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    ClassId INTEGER NOT NULL,
    Name TEXT NOT NULL,
    Description TEXT,
    DueDate TEXT,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ClassId) REFERENCES Classes(Id)
);

CREATE TABLE IF NOT EXISTS StudentClassEnrollments (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    StudentAuthUserId INTEGER NOT NULL,
    TeacherAuthUserId INTEGER NOT NULL,
    ClassId INTEGER NOT NULL,
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    IsActive INTEGER NOT NULL DEFAULT 1,
    UNIQUE (StudentAuthUserId, ClassId),
    FOREIGN KEY (StudentAuthUserId) REFERENCES ExtensionAuthUsers(Id),
    FOREIGN KEY (TeacherAuthUserId) REFERENCES ExtensionAuthUsers(Id),
    FOREIGN KEY (ClassId) REFERENCES Classes(Id)
);

CREATE TABLE IF NOT EXISTS StudentWorkspaceAssignments (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    StudentAuthUserId INTEGER NOT NULL,
    TeacherAuthUserId INTEGER NOT NULL,
    ClassId INTEGER NOT NULL,
    AssignmentId INTEGER NOT NULL,
    WorkspaceName TEXT NOT NULL,
    WorkspaceRootPath TEXT NOT NULL,
    WorkspaceFoldersJson TEXT NOT NULL,
    LinkedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (StudentAuthUserId, WorkspaceRootPath),
    FOREIGN KEY (StudentAuthUserId) REFERENCES ExtensionAuthUsers(Id),
    FOREIGN KEY (TeacherAuthUserId) REFERENCES ExtensionAuthUsers(Id),
    FOREIGN KEY (ClassId) REFERENCES Classes(Id),
    FOREIGN KEY (AssignmentId) REFERENCES ClassAssignments(Id)
);

/* =============================
   Helpful Indexes
   ============================= */

CREATE INDEX IF NOT EXISTS IX_SessionEvents_SessionId_OccurredAt
    ON SessionEvents (SessionId, OccurredAt);

CREATE INDEX IF NOT EXISTS IX_Sessions_ProjectId_StartedAt
    ON Sessions (ProjectId, StartedAt);

CREATE INDEX IF NOT EXISTS IX_SessionLogFiles_SessionId_Id
    ON SessionLogFiles (SessionId, Id DESC);
