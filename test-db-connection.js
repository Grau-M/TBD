// Test script to verify Azure SQL database connection
require('dotenv').config();
const sql = require('mssql');

async function testDatabaseConnection() {
    try {
        console.log('🔌 Connecting to Azure SQL Database...');
        console.log(`Server: ${process.env.AZURE_SQL_SERVER}`);
        console.log(`Database: ${process.env.AZURE_SQL_DATABASE}`);
        console.log(`User: ${process.env.AZURE_SQL_USER}`);
        
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
                connectionTimeout: 30000,
                requestTimeout: 30000
            }
        };

        // Connect to database
        const pool = await sql.connect(config);
        console.log('✅ Connected to Azure SQL Database successfully!\n');

        // Query all users from Users table
        console.log('📊 Querying Users table...');
        const result = await pool.request().query('SELECT * FROM Users');
        
        console.log(`\n📋 Found ${result.recordset.length} user(s) in the Users table:\n`);
        
        if (result.recordset.length === 0) {
            console.log('   (No users found - table is empty)');
        } else {
            // Print each user
            result.recordset.forEach((user, index) => {
                console.log(`User ${index + 1}:`);
                console.log(`  Username: ${user.Username}`);
                console.log(`  DisplayName: ${user.DisplayName}`);
                console.log(`  CreatedAt: ${user.CreatedAt}`);
                console.log('');
            });
        }

        // Close connection
        await pool.close();
        console.log('✅ Database connection closed.');
        
    } catch (err) {
        console.error('❌ Error connecting to database:');
        console.error(err.message);
        if (err.code) {
            console.error(`Error Code: ${err.code}`);
        }
        process.exit(1);
    }
}

// Run the test
testDatabaseConnection();
