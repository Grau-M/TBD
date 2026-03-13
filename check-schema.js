// Test script to check database schema
require('dotenv').config();
const sql = require('mssql');

async function checkSchema() {
    try {
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
        console.log('Connected to database\n');

        // Get Users table columns
        console.log('=== Users Table Columns ===');
        const usersColumns = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'Users'
            ORDER BY ORDINAL_POSITION
        `);
        usersColumns.recordset.forEach(col => {
            console.log(`  ${col.COLUMN_NAME} (${col.DATA_TYPE})`);
        });

        // Get actual Users data
        console.log('\n=== Users Table Data ===');
        const users = await pool.request().query('SELECT * FROM Users');
        console.log(JSON.stringify(users.recordset, null, 2));

        await pool.close();

    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

checkSchema();
