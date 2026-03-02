import * as vscode from 'vscode';
import { storageManager } from '../../state';
import { fetchAndParseLog, parseLogTime } from '../utilis/LogHelpers';

export async function handleOpenLog(panel: vscode.WebviewPanel, password: string, filename: string) {
  const files = await storageManager.listLogFiles();
  const chosen = files.find(f => f.label === filename);
  if (!chosen) {
    return panel.webview.postMessage({ command: 'error', message: 'Log not found' });
  }

  const { content, parsed, partial } = await fetchAndParseLog(password, chosen.uri);

  if (parsed) {
    // ✅ Evidence Confidence Indicator (attached to the parsed payload)
    try {
      const total = Array.isArray(parsed.events) ? parsed.events.length : 0;

      let label = "High";
      if (partial || total < 20) label = "Medium";
      if (partial && total < 10) label = "Low";

      parsed.confidence = {
        label,
        totalEvents: total,
        partial: !!partial,
        reason:
          label === "High"
            ? "Complete session data"
            : label === "Medium"
              ? "Some interruptions or limited data"
              : "Significant gaps or incomplete data"
      };
    } catch { /* silently skip */ }

    panel.webview.postMessage({ command: 'logData', filename, data: parsed, partial });
  } else {
    let safe = String(content).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '\uFFFD');
    if (safe.length > 200_000) { safe = safe.slice(0, 200_000) + '\n\n[truncated]'; }
    panel.webview.postMessage({ command: 'rawData', filename, data: safe, partial });
  }
}

export async function handleExportLog(panel: vscode.WebviewPanel, password: string, filename: string, format: string) {
  try {
    const files = await storageManager.listLogFiles();
    const chosen = files.find(f => f.label === filename);
    if (!chosen) { throw new Error("File not found on disk"); }

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
      defaultUri: vscode.Uri.file(`export-${filename.replace('.log', '')}.${format}`),
      filters: format === 'json' ? { 'JSON': ['json'] } : { 'CSV': ['csv'] }
    });

    if (saveUri) {
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(fileContent, 'utf8'));
      const auditEntry = `[${new Date().toISOString()}] EXPORT: Instructor exported ${filename} as ${format.toUpperCase()}.\n`;
      if (vscode.workspace.workspaceFolders) {
        const auditUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'audit_log.txt');
        let currentAudit = '';
        try { currentAudit = (await vscode.workspace.fs.readFile(auditUri)).toString(); } catch { }
        await vscode.workspace.fs.writeFile(auditUri, Buffer.from(currentAudit + auditEntry, 'utf8'));
      }
      vscode.window.showInformationMessage(`Successfully exported ${filename} to ${format.toUpperCase()}`);
      panel.webview.postMessage({ command: 'success', message: 'Export complete.' });
    }
  } catch (err: any) {
    const auditEntry = `[${new Date().toISOString()}] FAILED EXPORT ATTEMPT: Unauthorized access or decryption failure for ${filename}.\n`;
    if (vscode.workspace.workspaceFolders) {
      const auditUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode', 'audit_log.txt');
      let currentAudit = '';
      try { currentAudit = (await vscode.workspace.fs.readFile(auditUri)).toString(); } catch { }
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

// ✅ NEW: Generate Student Transparency Summary
export async function handleGenerateStudentSummary(panel: vscode.WebviewPanel, password: string, filename: string) {
  try {
    const files = await storageManager.listLogFiles();
    const chosen = files.find(f => f.label === filename);
    if (!chosen) throw new Error("Log not found");

    const { parsed, partial } = await fetchAndParseLog(password, chosen.uri);

    const events = parsed && Array.isArray(parsed.events) ? parsed.events : [];

    // Rainy day: insufficient data
    if (events.length < 5) {
      panel.webview.postMessage({
        command: "studentSummary",
        filename,
        summary: "Not enough recorded activity to generate a meaningful student summary for this session."
      });
      return;
    }

    // Student-safe metrics only
    let pasteCount = 0;
    const fileSet = new Set<string>();
    let firstTs = 0;
    let lastTs = 0;

    for (const e of events) {
      const et = (e.eventType || "").toLowerCase();
      if (et === "paste" || et === "clipboard" || et === "pasteevent") pasteCount++;

      const f = e.fileView || e.fileEdit || e.file || e.filePath || "";
      if (typeof f === "string" && f.trim()) fileSet.add(f.trim());

      const t = parseLogTime(e.time || "");
      if (t > 0 && firstTs === 0) firstTs = t;
      if (t > 0) lastTs = t;
    }

    const durationMin =
      firstTs > 0 && lastTs > firstTs ? Math.round((lastTs - firstTs) / 60000) : null;

    const lines: string[] = [];
    lines.push("This summary gives a high-level view of your recorded work session.");
    if (durationMin !== null) lines.push(`• Session length: about ${durationMin} minute(s).`);
    lines.push(`• Total recorded actions: ${events.length}.`);
    lines.push(`• Files interacted with: ${fileSet.size}.`);
    lines.push(`• Clipboard paste actions: ${pasteCount}.`);
    if (partial) lines.push("• Note: Some session data may be incomplete due to interruptions or missing logs.");
    lines.push("This summary excludes internal metrics and is provided for transparency.");

    panel.webview.postMessage({
      command: "studentSummary",
      filename,
      summary: lines.join("\n")
    });

  } catch (err: any) {
    panel.webview.postMessage({
      command: "error",
      message: `Student summary failed: ${String(err?.message || err)}`
    });
  }
}