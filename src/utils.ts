// Module: utils.ts
// Purpose: Lightweight formatting and helper utilities used across the
// extension. Includes timestamp formatting (using America/New_York), a
// duration formatter (HH:MM:SS), and a helper to determine which paths
// should be ignored by the logger (logs, encrypted files, etc.).
// Function: formatTimestamp
// Purpose: Format a millisecond timestamp into a human-readable
// string using the America/New_York timezone (handles EST/EDT).
export function formatTimestamp(ms: number): string {
    // Use America/New_York timezone (handles EST/EDT automatically)
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short',
        hour12: false
    });
    const parts = dtf.formatToParts(new Date(ms));
    const map: Record<string, string> = {};
    for (const p of parts) {
        if (p.type !== 'literal') {map[p.type] = p.value;}
    }
    const MM = map.month || '00';
    const DD = map.day || '00';
    const YYYY = map.year || '0000';
    const hh = (map.hour || '00').padStart(2, '0');
    const mm = (map.minute || '00').padStart(2, '0');
    const ss = (map.second || '00').padStart(2, '0');
    const SSS = String(new Date(ms).getMilliseconds()).padStart(3, '0');
    const tz = map.timeZoneName || 'EST';
    return `${MM}-${DD}-${YYYY} ${hh}:${mm}:${ss}:${SSS} ${tz}`;
}

// Function: formatDuration
// Purpose: Convert milliseconds to an HH:MM:SS string suitable for UI
// and logging output.
export function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Function: isIgnoredPath
// Purpose: Determine whether a relative file path should be ignored by
// the logger (e.g., editor settings, log files, encrypted files).
export function isIgnoredPath(relPath: string): boolean {
    if (!relPath) {return true;}
    const p = relPath.replace(/\\/g, '/');
    if (p.startsWith('.vscode/')) {return true;}
    if (p.includes('tbd-integrity-log')) {return true;}
    if (p.endsWith('.log') || p.endsWith('.json')|| p.endsWith('enc')) {return true;}
    return false;
}

export function getUserFriendlyErrorMessage(error: unknown, fallback = 'An unexpected error occurred. Please try again.') {
    // Handle API errors that expose status codes.
    if (error && typeof error === 'object') {
        const err = error as { status?: number; message?: string; responseBody?: string };
        const status = Number(err.status || 0);

        // Standard login failures should avoid technical details.
        if ([401, 403, 404].includes(status)) {
            return 'Invalid credentials. Please check your email and password.';
        }

        // Conflicts mean existing record; guide user experience.
        if (status === 409) {
            return 'An account with that email already exists. Please sign in instead.';
        }

        // Server-side issues should be non-technical.
        if (status >= 500) {
            return 'Server is currently unavailable. Please try again later.';
        }

        // Some API implementations may include user-friendly error text in body.
        if (err.responseBody && typeof err.responseBody === 'string') {
            const body = err.responseBody.trim();
            if (body.length > 0 && body.length < 512) {
                return body;
            }
        }

        if (err.message && typeof err.message === 'string') {
            const msg = err.message.trim();
            if (msg.length > 0 && !msg.startsWith('API ')) {
                return msg;
            }
        }
    }

    if (error instanceof Error) {
        const msg = String(error.message || '').trim();
        if (msg.length > 0) {
            return msg;
        }
    }

    if (typeof error === 'string' && error.trim().length > 0) {
        return error.trim();
    }

    return fallback;
}
