import * as vscode from 'vscode';

export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'tbd.ui.themePreference.v1';

export function normalizeThemePreference(value: unknown): ThemePreference {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'light' || v === 'dark' || v === 'system') {
        return v;
    }
    return 'system';
}

export function getThemePreference(context: vscode.ExtensionContext): ThemePreference {
    return normalizeThemePreference(context.globalState.get<string>(THEME_PREFERENCE_KEY, 'system'));
}

export async function setThemePreference(context: vscode.ExtensionContext, value: unknown): Promise<ThemePreference> {
    const normalized = normalizeThemePreference(value);
    await context.globalState.update(THEME_PREFERENCE_KEY, normalized);
    return normalized;
}
