import * as assert from 'assert';
import { printSessionInfo, getSessionInfo } from '../sessionInfo';

suite('Unit Tests: Session Info', () => {
    test('getSessionInfo returns shape with user and project', () => {
        const info = getSessionInfo();
        assert.ok(typeof info.user === 'string');
        assert.ok(typeof info.project === 'string');
    });

    test('printSessionInfo returns the info object', () => {
        const info = printSessionInfo();
        assert.ok(info && typeof info.user === 'string' && typeof info.project === 'string');
    });
});
