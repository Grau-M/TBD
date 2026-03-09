// Test script to verify database storage integration
require('dotenv').config();
const sql = require('mssql');

async function testDatabaseIntegration() {
    console.log('🧪 Testing Database Integration...\n');

    try {
        // Connect to database
        const config = {
            server: process.env.AZURE_SQL_SERVER,
            database: process.env.AZURE_SQL_DATABASE,
            user: process.env.AZURE_SQL_USER,
            password: process.env.AZURE_SQL_PASSWORD,
            port: parseInt(process.env.AZURE_SQL_PORT || '1433'),
            options: {
                encrypt: process.env.AZURE_SQL_ENCRYPT === 'true',
                trustServerCertificate: false,
                enableArithAbort: true,
                connectTimeout: 30000,
                requestTimeout: 30000
            }
        };

        const pool = await sql.connect(config);
        console.log('✅ Connected to database\n');

        // Test 1: Check Users table
        console.log('Test 1: Users Table');
        const usersResult = await pool.request().query('SELECT COUNT(*) as Count FROM Users');
        console.log(`  Users count: ${usersResult.recordset[0].Count}`);

        // Test 2: Check Projects table
        console.log('\nTest 2: Projects Table');
        const projectsResult = await pool.request().query('SELECT COUNT(*) as Count FROM Projects');
        console.log(`  Projects count: ${projectsResult.recordset[0].Count}`);

        // Test 3: Check Sessions table
        console.log('\nTest 3: Sessions Table');
        const sessionsResult = await pool.request().query('SELECT COUNT(*) as Count FROM Sessions');
        console.log(`  Sessions count: ${sessionsResult.recordset[0].Count}`);

        // Test 4: Check SessionEvents table
        console.log('\nTest 4: SessionEvents Table');
        const eventsResult = await pool.request().query('SELECT COUNT(*) as Count FROM SessionEvents');
        console.log(`  Events count: ${eventsResult.recordset[0].Count}`);

        // Test 5: Check SessionLogFiles table
        console.log('\nTest 5: SessionLogFiles Table');
        const logFilesResult = await pool.request().query('SELECT COUNT(*) as Count FROM SessionLogFiles');
        console.log(`  Log files count: ${logFilesResult.recordset[0].Count}`);

        // Test 6: Check InstructorNotes table
        console.log('\nTest 6: InstructorNotes Table');
        const notesResult = await pool.request().query('SELECT COUNT(*) as Count FROM InstructorNotes');
        console.log(`  Notes count: ${notesResult.recordset[0].Count}`);

        // Test 7: Simulate a session creation
        console.log('\n\nTest 7: Simulating Session Creation...');
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Create or get test user
            let userId;
            const userCheck = await transaction.request()
                .input('username', 'test_user')
                .query('SELECT UserId FROM Users WHERE Username = @username');
            
            if (userCheck.recordset.length > 0) {
                userId = userCheck.recordset[0].UserId;
                console.log(`  Using existing test user: ${userId}`);
            } else {
                const userInsert = await transaction.request()
                    .input('username', 'test_user')
                    .query('INSERT INTO Users (Username, DisplayName) OUTPUT INSERTED.UserId VALUES (@username, @username)');
                userId = userInsert.recordset[0].UserId;
                console.log(`  Created new test user: ${userId}`);
            }

            // Create or get test project
            let projectId;
            const projectCheck = await transaction.request()
                .input('name', 'test_project')
                .query('SELECT ProjectId FROM Projects WHERE Name = @name');
            
            if (projectCheck.recordset.length > 0) {
                projectId = projectCheck.recordset[0].ProjectId;
                console.log(`  Using existing test project: ${projectId}`);
            } else {
                const projectInsert = await transaction.request()
                    .input('name', 'test_project')
                    .input('path', 'test_project')
                    .input('createdBy', 'test_user')
                    .query('INSERT INTO Projects (Name, Path, CreatedBy) OUTPUT INSERTED.ProjectId VALUES (@name, @path, @createdBy)');
                projectId = projectInsert.recordset[0].ProjectId;
                console.log(`  Created new test project: ${projectId}`);
            }

            // Create test session
            const sessionInsert = await transaction.request()
                .input('userId', userId)
                .input('projectId', projectId)
                .input('startTime', new Date())
                .input('metadata', JSON.stringify({ test: true, version: '1.0.0' }))
                .input('status', 'active')
                .query('INSERT INTO Sessions (UserId, ProjectId, StartTime, Metadata, Status) OUTPUT INSERTED.SessionId VALUES (@userId, @projectId, @startTime, @metadata, @status)');
            
            const sessionId = sessionInsert.recordset[0].SessionId;
            console.log(`  Created test session: ${sessionId}`);

            // Create test log file entry
            await transaction.request()
                .input('sessionId', sessionId)
                .input('fileName', `test_user-test_project-Session${sessionId}-integrity.log`)
                .input('format', 'json')
                .input('createdAt', new Date())
                .query('INSERT INTO SessionLogFiles (SessionId, FileName, Format, CreatedAt) VALUES (@sessionId, @fileName, @format, @createdAt)');
            console.log('  Created test log file entry');

            // Create test event
            await transaction.request()
                .input('sessionId', sessionId)
                .input('sessionTime', new Date())
                .input('eventType', 'session-start')
                .input('flightTime', '0')
                .input('fileEdit', '')
                .input('fileView', 'test.js')
                .query('INSERT INTO SessionEvents (SessionId, SessionTime, EventType, FlightTime, FileEdit, FileView) VALUES (@sessionId, @sessionTime, @eventType, @flightTime, @fileEdit, @fileView)');
            console.log('  Created test event');

            // Rollback test transaction (don't actually save test data)
            await transaction.rollback();
            console.log('  Test transaction rolled back (no data saved)');

        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        await pool.close();
        console.log('\n✅ All database integration tests passed!');
        console.log('\n📝 Your extension is now configured to use Azure SQL Database.');
        console.log('   When the extension runs, it will automatically create users,');
        console.log('   projects, sessions, and events in the database.\n');

    } catch (err) {
        console.error('\n❌ Database integration test failed:');
        console.error(err.message);
        if (err.code) {
            console.error(`Error Code: ${err.code}`);
        }
        process.exit(1);
    }
}

testDatabaseIntegration();
