import * as vscode from 'vscode';

const AUTO_DISMISS_MS = 10_000;
const TICK_MS = 100;

type ToastMessageOptions = {
    modal?: boolean;
};

let notificationPatchInstalled = false;
let originalShowInformationMessage: typeof vscode.window.showInformationMessage | undefined;
let originalShowWarningMessage: typeof vscode.window.showWarningMessage | undefined;
let originalShowErrorMessage: typeof vscode.window.showErrorMessage | undefined;

function normalizeItems(items: string[]): string[] {
    return items.filter((item) => typeof item === 'string' && item.length > 0);
}

function parseInfoMessageArgs(args: any[]): { items: string[]; options: ToastMessageOptions | undefined } {
    const items: string[] = [];
    let options: ToastMessageOptions | undefined;

    for (const arg of args) {
        if (typeof arg === 'string') {
            items.push(arg);
            continue;
        }

        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
            options = arg as ToastMessageOptions;
        }
    }

    return { items: normalizeItems(items), options };
}

function reportToastProgress(progress: vscode.Progress<{ increment?: number; message?: string }>, elapsedMs: number): void {
    progress.report({
        increment: elapsedMs === 0 ? 100 : -1,
    });
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function showTimedToast(message: string, items: string[] = []): Thenable<string | undefined> {
    const normalizedItems = normalizeItems(items);

    if (normalizedItems.length > 0) {
        return originalShowInformationMessage
            ? originalShowInformationMessage(message, ...normalizedItems)
            : Promise.resolve(undefined);
    }

    return vscode.window.withProgress<string | undefined>({
        location: vscode.ProgressLocation.Notification,
        title: message,
        cancellable: false
    }, async (progress) => {
        let elapsedMs = 0;
        reportToastProgress(progress, 0);

        while (elapsedMs < AUTO_DISMISS_MS) {
            await wait(TICK_MS);
            elapsedMs += TICK_MS;
            reportToastProgress(progress, elapsedMs);
        }

        return undefined;
    });
}

export function installNotificationToastTimeouts(): void {
    if (notificationPatchInstalled) {
        return;
    }

    notificationPatchInstalled = true;

    originalShowInformationMessage = vscode.window.showInformationMessage.bind(vscode.window);
    originalShowWarningMessage = vscode.window.showWarningMessage.bind(vscode.window);
    originalShowErrorMessage = vscode.window.showErrorMessage.bind(vscode.window);

    vscode.window.showInformationMessage = ((message: string, ...rest: any[]) => {
        const { items, options } = parseInfoMessageArgs(rest);
        if (options?.modal || items.length > 0) {
            return originalShowInformationMessage!(message, ...rest);
        }
        return showTimedToast(message);
    }) as typeof vscode.window.showInformationMessage;

    vscode.window.showWarningMessage = ((message: string, ...rest: any[]) => {
        const result = originalShowWarningMessage!(message, ...rest);
        return result;
    }) as typeof vscode.window.showWarningMessage;

    vscode.window.showErrorMessage = ((message: string, ...rest: any[]) => {
        const result = originalShowErrorMessage!(message, ...rest);
        return result;
    }) as typeof vscode.window.showErrorMessage;
}
