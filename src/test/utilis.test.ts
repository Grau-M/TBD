// src/test/unit/utils.test.ts
import * as assert from 'assert';
import { formatDuration, isIgnoredPath } from '../utils';

suite('Unit Tests: Utils', () => {
    test('formatDuration formats milliseconds correctly', () => {
        assert.strictEqual(formatDuration(1000), '00:00:01');
        assert.strictEqual(formatDuration(65000), '00:01:05');
        assert.strictEqual(formatDuration(3661000), '01:01:01');
    });

    test('isIgnoredPath correctly identifies ignored files', () => {
        assert.strictEqual(isIgnoredPath('.vscode/settings.json'), true);
        assert.strictEqual(isIgnoredPath('tbd-integrity-log.enc'), true);
        assert.strictEqual(isIgnoredPath('src/extension.ts'), false);
        assert.strictEqual(isIgnoredPath('folder/script.js'), false);
    });
});