// Module: db.ts
// Purpose: Legacy direct SQL adapter is intentionally disabled.
// All extension persistence should flow through the API layer instead
// of shipping database connectivity logic in the VSIX.

export interface LegacyDbResult<T = any> {
    recordset: T[];
    rowsAffected?: number[];
}

const LEGACY_SQL_DISABLED_MESSAGE =
    'Direct Azure SQL connectivity is disabled in this extension build. Use API endpoints instead.';

export async function getPool(): Promise<any> {
    throw new Error(LEGACY_SQL_DISABLED_MESSAGE);
}

export function isConnected(): boolean {
    return false;
}

export async function closePool(): Promise<void> {
    // no-op: legacy adapter disabled
}

export async function executeQuery(_query: string, _params?: Record<string, any>): Promise<LegacyDbResult> {
    throw new Error(LEGACY_SQL_DISABLED_MESSAGE);
}

export async function executeProcedure(_procedureName: string, _params?: Record<string, any>): Promise<LegacyDbResult> {
    throw new Error(LEGACY_SQL_DISABLED_MESSAGE);
}

export async function beginTransaction(): Promise<any> {
    throw new Error(LEGACY_SQL_DISABLED_MESSAGE);
}
