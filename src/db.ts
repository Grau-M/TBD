// Module: db.ts
// Purpose: Database connection pool and query utilities for Azure SQL.
// Provides a centralized connection pool and helper methods for executing
// SQL queries against the Azure SQL database that stores session logs,
// events, instructor notes, and audit trails.

import * as sql from 'mssql';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from the extension root.
// __dirname is dist/ when bundled, so go up one level to find .env
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
//Define the variable and enforce the security check for encryption
const isEncryptionForced = process.env.AZURE_SQL_ENCRYPT === 'true';
if (process.env.NODE_ENV === 'production' && !isEncryptionForced) {
    throw new Error('SECURITY HALT: Production database connections must enforce TLS/SSL encryption (AZURE_SQL_ENCRYPT=true).');
}
// Database configuration from environment variables
const config: sql.config = {
    server: process.env.AZURE_SQL_SERVER || '',
    database: process.env.AZURE_SQL_DATABASE || '',
    user: process.env.AZURE_SQL_USER || '',
    password: process.env.AZURE_SQL_PASSWORD || '',
    port: parseInt(process.env.AZURE_SQL_PORT || '1433'),
    options: {
        encrypt: isEncryptionForced, // Enforce encryption based on environment variable
        trustServerCertificate: false,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 30000
    }
};

// Singleton connection pool
let pool: sql.ConnectionPool | null = null;
let isConnecting = false;

/**
 * Get or create the database connection pool
 * @returns Promise<sql.ConnectionPool>
 */
export async function getPool(): Promise<sql.ConnectionPool> {
    if (!config.server) {
        throw new Error('Database configuration missing: AZURE_SQL_SERVER is not defined');
    }

    if (pool && pool.connected) {
        return pool;
    }

    // Prevent concurrent connection attempts
    if (isConnecting) {
        while (isConnecting) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (pool && pool.connected) {
            return pool;
        }
    }

    try {
        isConnecting = true;
        console.log('[TBD Logger DB] Connecting to Azure SQL Database...');
        pool = await new sql.ConnectionPool(config).connect();
        return pool;
    } catch (err:any) {
        // Rainy Day Handling: Log specific handshake or auth failures
        if (err.message.includes('Login failed')) {
            console.error('[SECURITY EVENT] Authentication Handshake Failure: Invalid credentials provided.', err);
        } else if (err.message.includes('certificate') || err.message.includes('SSL')) {
            console.error('[SECURITY EVENT] Insecure Connection Attempt: TLS handshake rejected by server.', err);
        } else {
            console.error('[TBD Logger DB] Failed to connect to database:', err);
        }
        throw err;
    } finally {
        isConnecting = false;
    }
}

/**
 * Check if the database is currently connected
 * @returns boolean True if pool is connected, false otherwise
 */
export function isConnected(): boolean {
    return !!(pool && pool.connected);
}

/**
 * Close the database connection pool
 */
export async function closePool(): Promise<void> {
    if (pool) {
        try {
            await pool.close();
            pool = null;
            console.log('[TBD Logger DB] Database connection pool closed');
        } catch (err) {
            console.error('[TBD Logger DB] Error closing pool:', err);
        }
    }
}

/**
 * Execute a query with parameters
 * @param query SQL query string
 * @param params Object with parameter names and values
 * @returns Promise<sql.IResult<any>>
 */
export async function executeQuery(query: string, params?: Record<string, any>): Promise<sql.IResult<any>> {
    const connection = await getPool();
    const request = connection.request();
    
    // Add parameters if provided
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            request.input(key, value);
        }
    }
    
    return request.query(query);
}

/**
 * Execute a stored procedure
 * @param procedureName Name of the stored procedure
 * @param params Object with parameter names and values
 * @returns Promise<sql.IResult<any>>
 */
export async function executeProcedure(procedureName: string, params?: Record<string, any>): Promise<sql.IResult<any>> {
    const connection = await getPool();
    const request = connection.request();
    
    // Add parameters if provided
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            request.input(key, value);
        }
    }
    
    return request.execute(procedureName);
}

/**
 * Begin a transaction
 * @returns Promise<sql.Transaction>
 */
export async function beginTransaction(): Promise<sql.Transaction> {
    const connection = await getPool();
    const transaction = new sql.Transaction(connection);
    await transaction.begin();
    return transaction;
}
