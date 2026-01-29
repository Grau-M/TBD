import * as assert from 'assert';
import { StorageManager } from '../storageManager';

suite('Unit Tests: StorageManager (partial)', () => {
    test('retrieveHiddenEntries rejects wrong password and returns empty array when uninitialized with correct password', async () => {
        const sm = new StorageManager();
        await assert.rejects(async () => {
            await sm.retrieveHiddenEntries('bad-password');
        }, /Invalid Password/);

        // correct password (known from source) returns [] because hiddenLogUri is not set
        const entries = await sm.retrieveHiddenEntries('password');
        assert.deepStrictEqual(entries, []);
    });

    test('retrieveHiddenLogContent behaves similarly for password', async () => {
        const sm = new StorageManager();
        await assert.rejects(async () => {
            await sm.retrieveHiddenLogContent('nope');
        }, /Invalid Password/);

        const content = await sm.retrieveHiddenLogContent('password');
        // without initialization hidden log URI is null and method returns empty string
        assert.strictEqual(content, '');
    });
});
