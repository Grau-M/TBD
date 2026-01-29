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
        if (p.type !== 'literal') map[p.type] = p.value;
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
    if (!relPath) return true;
    const p = relPath.replace(/\\/g, '/');
    if (p.startsWith('.vscode/')) return true;
    if (p.includes('tbd-integrity-log')) return true;
    if (p.endsWith('.log') || p.endsWith('.json')|| p.endsWith('enc')) return true;
    return false;
}
