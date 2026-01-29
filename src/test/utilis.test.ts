// Test: utilis.test.ts
// Purpose: Unit tests for utility helpers in `src/utils.ts`. Verifies
// `formatDuration` and `isIgnoredPath` formatting and exclusion rules.
import * as assert from 'assert';
import { formatDuration, isIgnoredPath } from '../utils';

suite('Unit Tests: Utils', () => {
    // Asserts that millisecond inputs convert to HH:MM:SS strings
    test('formatDuration formats milliseconds correctly', () => {
        assert.strictEqual(formatDuration(1000), '00:00:01');
        assert.strictEqual(formatDuration(65000), '00:01:05');
        assert.strictEqual(formatDuration(3661000), '01:01:01');
    });

    // Verifies which relative paths are considered ignored by the logger
    test('isIgnoredPath correctly identifies ignored files', () => {
        assert.strictEqual(isIgnoredPath('.vscode/settings.json'), true);
        assert.strictEqual(isIgnoredPath('tbd-integrity-log.enc'), true);
        assert.strictEqual(isIgnoredPath('src/extension.ts'), false);
        assert.strictEqual(isIgnoredPath('folder/script.js'), false);
    });
});