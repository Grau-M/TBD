export function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').replace('Z', '');
}

export function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function isIgnoredPath(relPath: string): boolean {
    if (!relPath) return true;
    const p = relPath.replace(/\\/g, '/');
    if (p.startsWith('.vscode/')) return true;
    if (p.includes('tbd-session-')) return true;
    if (p.endsWith('.log') || p.endsWith('.json')) return true;
    return false;
}
