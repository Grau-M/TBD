// Diagnostic script to test Azure SQL connection and show detailed status
require('dotenv').config();
const sql = require('mssql');

async function testConnection() {
    console.log('🔍 TBD Logger Database Diagnostic\n');
    console.log('Configuration:');
    console.log(`  Server: ${process.env.AZURE_SQL_SERVER}`);
    console.log(`  Database: ${process.env.AZURE_SQL_DATABASE}`);
    console.log(`  User: ${process.env.AZURE_SQL_USER}`);
    console.log(`  Port: ${process.env.AZURE_SQL_PORT}\n`);

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

    try {
        console.log('⏳ Attempting to connect...');
        const pool = new sql.ConnectionPool(config);
        
        pool.on('error', (err) => {
            console.error('\n❌ Pool Error Event:', err.message);
        });

        const startTime = Date.now();
        await pool.connect();
        const connectTime = Date.now() - startTime;
        
        console.log(`✅ Connected successfully! (${connectTime}ms)`);
        console.log(`\n📊 Connection Pool Status:`);
        console.log(`  Pool Connected: ${pool.connected}`);
        console.log(`  Config: ${JSON.stringify(pool.config, null, 2)}`);

        // Test query
        console.log('\n⏳ Running test query...');
        const result = await pool.request().query('SELECT COUNT(*) as UserCount FROM Users');
        console.log(`✅ Test query successful`);
        console.log(`  Users in database: ${result.recordset[0].UserCount}`);

        // Get table stats
        console.log('\n📋 Database Table Statistics:');
        const tables = ['Users', 'Projects', 'Sessions', 'SessionEvents', 'SessionLogFiles', 'InstructorNotes'];
        for (const table of tables) {
            const r = await pool.request().query(`SELECT COUNT(*) as cnt FROM ${table}`);
            console.log(`  ${table}: ${r.recordset[0].cnt} rows`);
        }

        await pool.close();
        console.log('\n✅ All tests passed! Connection is working.');
        process.exit(0);

    } catch (err) {
        console.error('\n❌ Connection failed:');
        console.error(`  Error: ${err.message}`);
        if (err.code) {
            console.error(`  Code: ${err.code}`);
        }
        console.error(`\n🔧 Troubleshooting steps:`);
        console.error('  1. Verify .env file has correct AZURE_SQL_SERVER, AZURE_SQL_DATABASE, AZURE_SQL_USER, AZURE_SQL_PASSWORD');
        console.error('  2. Check Azure Portal that your SQL Server firewall allows your IP');
        console.error('  3. Verify SQL authentication is enabled (not Azure AD only)');
        console.error('  4. Try pinging the server: nslookup ' + process.env.AZURE_SQL_SERVER);
        process.exit(1);
    }
}

testConnection();
