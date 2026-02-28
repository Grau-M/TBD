import * as vscode from 'vscode';
import { storageManager } from '../../state';
import { fetchAndParseLog } from '../utilis/LogHelpers';

export async function handleOpenLog(panel: vscode.WebviewPanel, password: string, filename: string) {
    const files = await storageManager.listLogFiles();
    const chosen = files.find(f => f.label === filename);
    if (!chosen) return panel.webview.postMessage({ command: 'error', message: 'Log not found' });

    const { content, parsed, partial } = await fetchAndParseLog(password, chosen.uri);
    if (parsed) {
        panel.webview.postMessage({ command: 'logData', filename, data: parsed, partial });
    } else {
        let safe = String(content).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '\uFFFD');
        if (safe.length > 200_000) safe = safe.slice(0, 200_000) + '\n\n[truncated]';
        panel.webview.postMessage({ command: 'rawData', filename, data: safe, partial });
    }
}

export async function handleExportLog(panel: vscode.WebviewPanel, password: string, filename: string, format: string) {
    try {
        const files = await storageManager.listLogFiles();
        const chosen = files.find(f => f.label === filename);
        if(!chosen) throw new Error("File not found on disk");

        const res = await storageManager.retrieveLogContentWithPassword(password, chosen.uri);
        const logData = JSON.parse(res.text);

        let fileContent = '';
        if (format === 'json') {
            fileContent = JSON.stringify(logData, null, 2);
        } else {
            const header = "Timestamp,EventType,FlightTime(ms),File,PasteLength,Details\n";
            const rows = (logData.events || []).map((e: any) => {
                const escape = (s: any) => `"${String(s || '').replace(/"/g, '""')}"`;
                return [
                    escape(e.time), escape(e.eventType), escape(e.flightTime),
                    escape(e.fileView || e.fileEdit), escape(e.pasteLength || e.length),
                    escape(e.text ? e.text.substring(0, 50) + "..." : "")
                ].join(',');
            });
            fileContent = header + rows.join('\n');
        }

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`export-${filename.replace('.log','')}.${format}`),
            filters: format === 'json' ? {'JSON': ['json']} : {'CSV': ['csv']}
        });

        if (saveUri) {
            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(fileContent, 'utf8'));
            const auditEntry = `[${new Date().toISOString()}] EXPORT: Instructor exported ${filename} as ${format.toUpperCase()}.\n`;
            if (vscode.workspace.workspaceFolders) {
                const auditUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'audit_log.txt');
                let currentAudit = '';
                try { currentAudit = (await vscode.workspace.fs.readFile(auditUri)).toString(); } catch {} 
                await vscode.workspace.fs.writeFile(auditUri, Buffer.from(currentAudit + auditEntry, 'utf8'));
            }
            vscode.window.showInformationMessage(`Successfully exported ${filename} to ${format.toUpperCase()}`);
            panel.webview.postMessage({ command: 'success', message: 'Export complete.' });
        }
    } catch (err: any) {
        // Audit log failed attempt
        const auditEntry = `[${new Date().toISOString()}] FAILED EXPORT ATTEMPT: Unauthorized access or decryption failure for ${filename}.\n`;
        if (vscode.workspace.workspaceFolders) {
            const auditUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'audit_log.txt');
            let currentAudit = '';
            try { currentAudit = (await vscode.workspace.fs.readFile(auditUri)).toString(); } catch {} 
            await vscode.workspace.fs.writeFile(auditUri, Buffer.from(currentAudit + auditEntry, 'utf8'));
        }
        vscode.window.showErrorMessage(`Export Failed: ${err.message}`);
        panel.webview.postMessage({ command: 'error', message: `Export failed: ${err.message}` });
    }
}

export async function handleGetDeletions(panel: vscode.WebviewPanel, password: string) {
    const json = await storageManager.retrieveHiddenLogContent(password);
    let parsed: any = null;
    try { parsed = JSON.parse(json); } catch { parsed = { raw: json }; }
    panel.webview.postMessage({ command: 'deletionData', data: parsed });
}

export async function handleSaveLogNotes(panel: vscode.WebviewPanel, password: string, filename: string, notes: Array<{ timestamp: string; text: string }>) {
    try {
        await storageManager.saveLogNotes(password, filename, notes);
        panel.webview.postMessage({ command: 'success', message: 'Notes saved successfully.' });
    } catch (err: any) {
        panel.webview.postMessage({ command: 'error', message: `Failed to save notes: ${err.message}` });
    }
}

export async function handleLoadLogNotes(panel: vscode.WebviewPanel, password: string, filename: string) {
    try {
        const notes = await storageManager.loadLogNotes(password, filename);
        panel.webview.postMessage({ command: 'logNotes', filename, notes });
    } catch (err: any) {
        panel.webview.postMessage({ command: 'error', message: `Failed to load notes: ${err.message}` });
    }
}