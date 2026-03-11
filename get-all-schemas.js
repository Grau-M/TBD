// Get all table schemas
require('dotenv').config();
const sql = require('mssql');

async function getAllSchemas() {
    const pool = await sql.connect({
        server: process.env.AZURE_SQL_SERVER,
        database: process.env.AZURE_SQL_DATABASE,
        user: process.env.AZURE_SQL_USER,
        password: process.env.AZURE_SQL_PASSWORD,
        port: parseInt(process.env.AZURE_SQL_PORT),
        options: { encrypt: true, trustServerCertificate: false, connectTimeout: 30000 }
    });
    
    const tables = ['Users', 'Projects', 'Sessions', 'SessionEvents', 'SessionLogFiles', 'InstructorNotes'];
    
    for(const t of tables) {
        const r = await pool.request().query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = '${t}' 
            ORDER BY ORDINAL_POSITION
        `);
        console.log(`\n${t}:`, r.recordset.map(c => c.COLUMN_NAME).join(', '));
    }
    
    await pool.close();
}

getAllSchemas().catch(console.error);
