// Test: sessionInfo.test.ts
// Purpose: Validate session information helpers return expected shapes
// and that `printSessionInfo` logs and returns the same structure.
import * as assert from 'assert';
import { printSessionInfo, getSessionInfo } from '../sessionInfo';

suite('Unit Tests: Session Info', () => {
    // Confirms returned object contains `user` and `project` string fields
    test('getSessionInfo returns shape with user and project', () => {
        const info = getSessionInfo();
        assert.ok(typeof info.user === 'string');
        assert.ok(typeof info.project === 'string');
    });

    // Verifies that `printSessionInfo` logs/returns the same info structure
    test('printSessionInfo returns the info object', () => {
        const info = printSessionInfo();
        assert.ok(info && typeof info.user === 'string' && typeof info.project === 'string');
    });
});
