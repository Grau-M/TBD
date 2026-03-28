import * as vscode from 'vscode';
import { storageManager } from '../../state';

export function parseLogTime(s: string): number {
    if (!s) {return 0;}
    const cleanStr = s.replace(/ [A-Z]{3,4}$/, ""); 
    const parts = cleanStr.split(' ');
    if (parts.length < 2) {return 0;}

    const dateSub = parts[0].split('-');
    if (dateSub.length < 3) {return 0;}

    const monthStr = dateSub[0];
    const months: { [key: string]: number } = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };
    
    const month = months[monthStr] !== undefined ? months[monthStr] : parseInt(monthStr) - 1;
    const day = parseInt(dateSub[1]);
    const year = parseInt(dateSub[2]);

    const timeSub = parts[1].split(':');
    const hr = parseInt(timeSub[0]) || 0;
    const min = parseInt(timeSub[1]) || 0;
    const sec = parseInt(timeSub[2]) || 0;
    const ms = parseInt(timeSub[3]) || 0;

    const parsedTime = new Date(year, month, day, hr, min, sec, ms).getTime();
    return isNaN(parsedTime) ? 0 : parsedTime;
}

export async function fetchAndParseLog(password: string, uri: vscode.Uri) {
    const res = await storageManager.retrieveLogContentWithPassword(password, uri);
    let parsed: any = null;
    
    try { 
        // 1. Try standard single-object JSON (Local Files)
        parsed = JSON.parse(res.text); 
    } catch {
        try {
            // 2. Try JSON-Lines format (Cloud Database Files)
            const lines = res.text.split('\n').filter((l: string) => l.trim());
            if (lines.length > 0 && lines[0].trim().startsWith('{')) {
                parsed = { events: [] };
                for (const line of lines) {
                    try {
                        const parsedLine = JSON.parse(line);
                        // Convert cloud columns to legacy fields if needed
                        if (parsedLine.occurredAt && !parsedLine.time) {
                            parsedLine.time = parsedLine.occurredAt;
                        }
                        if (parsedLine.sessionHeader) {
                            parsedLine.sessionHeader = parsedLine.sessionHeader;
                        } else {
                            parsed.events.push(parsedLine);
                        }
                    } catch(err) {
                        // Skip unparseable lines silently
                    }
                }
            } else {
                // 3. Absolute fallback for corrupted local files
                const s = res.text.indexOf('{');
                const e = res.text.lastIndexOf('}');
                if (s !== -1 && e > s) {
                    parsed = JSON.parse(res.text.slice(s, e + 1));
                }
            }
        } catch (_) { 
            parsed = null; 
        }
    }
    return { content: res.text, parsed, partial: res.partial };
}