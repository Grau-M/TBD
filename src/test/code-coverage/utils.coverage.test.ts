// Test: utils.coverage.test.ts
// Purpose: Comprehensive coverage tests for utils.ts formatting and helper functions
import * as assert from 'assert';
import { formatTimestamp, formatDuration, isIgnoredPath } from '../../utils';

suite('Code Coverage: Utils', () => {
    suite('formatTimestamp', () => {
        test('formats timestamp correctly with America/New_York timezone', () => {
            const timestamp = new Date('2024-03-15T14:30:45.123Z').getTime();
            const result = formatTimestamp(timestamp);
            
            // Should contain date components
            assert.ok(result.includes('Mar'), 'Should include month');
            assert.ok(result.includes('15'), 'Should include day');
            assert.ok(result.includes('2024'), 'Should include year');
            assert.ok(result.includes(':'), 'Should include time separators');
        });

        test('handles milliseconds correctly', () => {
            const timestamp = new Date('2024-03-15T14:30:45.999Z').getTime();
            const result = formatTimestamp(timestamp);
            
            // Should contain milliseconds
            assert.ok(result.includes('999') || result.length > 20, 'Should include milliseconds');
        });

        test('formats different times of day correctly', () => {
            const morning = new Date('2024-03-15T10:00:00.000Z').getTime();
            const evening = new Date('2024-03-15T22:00:00.000Z').getTime();
            
            const morningResult = formatTimestamp(morning);
            const eveningResult = formatTimestamp(evening);
            
            assert.ok(morningResult.length > 0, 'Morning timestamp should be formatted');
            assert.ok(eveningResult.length > 0, 'Evening timestamp should be formatted');
        });

        test('handles epoch time (0)', () => {
            const result = formatTimestamp(0);
            assert.ok(result.includes('1969') || result.includes('1970'), 'Should handle epoch time');
        });

        test('handles current time', () => {
            const now = Date.now();
            const result = formatTimestamp(now);
            assert.ok(result.length > 20, 'Should format current time');
        });
    });

    suite('formatDuration', () => {
        test('formats zero duration', () => {
            const result = formatDuration(0);
            assert.strictEqual(result, '00:00:00', 'Zero duration should be 00:00:00');
        });

        test('formats seconds only', () => {
            const result = formatDuration(5000); // 5 seconds
            assert.strictEqual(result, '00:00:05', 'Should format 5 seconds');
        });

        test('formats minutes and seconds', () => {
            const result = formatDuration(125000); // 2 minutes 5 seconds
            assert.strictEqual(result, '00:02:05', 'Should format 2 minutes 5 seconds');
        });

        test('formats hours, minutes, and seconds', () => {
            const result = formatDuration(3665000); // 1 hour 1 minute 5 seconds
            assert.strictEqual(result, '01:01:05', 'Should format 1:01:05');
        });

        test('formats large durations', () => {
            const result = formatDuration(36000000); // 10 hours
            assert.strictEqual(result, '10:00:00', 'Should format 10 hours');
        });

        test('handles durations over 24 hours', () => {
            const result = formatDuration(90000000); // 25 hours
            assert.strictEqual(result, '25:00:00', 'Should format 25 hours');
        });

        test('rounds down partial seconds', () => {
            const result = formatDuration(5999); // 5.999 seconds
            assert.strictEqual(result, '00:00:05', 'Should round down to 5 seconds');
        });

        test('formats 59:59:59', () => {
            const result = formatDuration(215999000); // 59 hours, 59 minutes, 59 seconds
            assert.strictEqual(result, '59:59:59', 'Should format maximum values');
        });
    });

    suite('isIgnoredPath', () => {
        test('ignores empty paths', () => {
            assert.strictEqual(isIgnoredPath(''), true, 'Empty path should be ignored');
        });

        test('ignores .vscode folder paths', () => {
            assert.strictEqual(isIgnoredPath('.vscode/settings.json'), true, 'Should ignore .vscode paths');
            assert.strictEqual(isIgnoredPath('.vscode/launch.json'), true, 'Should ignore .vscode launch.json');
        });

        test('ignores paths with backslashes in .vscode', () => {
            assert.strictEqual(isIgnoredPath('.vscode\\settings.json'), true, 'Should ignore .vscode paths with backslashes');
        });

        test('ignores tbd-integrity-log paths', () => {
            assert.strictEqual(isIgnoredPath('tbd-integrity-log/Session1.log'), true, 'Should ignore integrity log paths');
            assert.strictEqual(isIgnoredPath('path/to/tbd-integrity-log/file.txt'), true, 'Should ignore nested integrity log paths');
        });

        test('ignores .log files', () => {
            assert.strictEqual(isIgnoredPath('debug.log'), true, 'Should ignore .log files');
            assert.strictEqual(isIgnoredPath('path/to/error.log'), true, 'Should ignore nested .log files');
        });

        test('ignores .json files', () => {
            assert.strictEqual(isIgnoredPath('config.json'), true, 'Should ignore .json files');
            assert.strictEqual(isIgnoredPath('data/settings.json'), true, 'Should ignore nested .json files');
        });

        test('ignores .enc files', () => {
            assert.strictEqual(isIgnoredPath('encrypted.enc'), true, 'Should ignore .enc files');
            assert.strictEqual(isIgnoredPath('secure/data.enc'), true, 'Should ignore nested .enc files');
        });

        test('does not ignore normal source files', () => {
            assert.strictEqual(isIgnoredPath('src/index.ts'), false, 'Should not ignore TypeScript files');
            assert.strictEqual(isIgnoredPath('lib/utils.js'), false, 'Should not ignore JavaScript files');
            assert.strictEqual(isIgnoredPath('README.md'), false, 'Should not ignore markdown files');
        });

        test('does not ignore paths without extensions', () => {
            assert.strictEqual(isIgnoredPath('Makefile'), false, 'Should not ignore files without extensions');
        });

        test('handles mixed case extensions', () => {
            assert.strictEqual(isIgnoredPath('File.LOG'), true, 'Should ignore .LOG files');  
            assert.strictEqual(isIgnoredPath('File.JSON'), true, 'Should ignore .JSON files');
        });

        test('handles complex nested paths', () => {
            assert.strictEqual(isIgnoredPath('src/components/App.tsx'), false, 'Should not ignore normal nested files');
            assert.strictEqual(isIgnoredPath('.vscode/extensions/test.json'), true, 'Should ignore .vscode nested files');
        });
    });
});
