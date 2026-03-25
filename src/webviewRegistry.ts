import * as vscode from 'vscode';

const trackedPanels = new Set<vscode.WebviewPanel>();

export function registerWebviewPanel(panel: vscode.WebviewPanel): void {
    trackedPanels.add(panel);

    panel.onDidDispose(() => {
        trackedPanels.delete(panel);
    });
}

export async function closeAllWebviews(): Promise<void> {
    const panels = Array.from(trackedPanels);
    trackedPanels.clear();

    await Promise.allSettled(panels.map((panel) => {
        try {
            panel.dispose();
        } catch {
            // Ignore disposal errors so one bad panel does not block logout.
        }

        return Promise.resolve();
    }));
}