import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '.');

    return new Promise(async (resolve, reject) => {
        /* c8 ignore start */
        try {
            const files = await glob('**/*.test.js', { cwd: testsRoot });
            const optionalCoverageFiles = [
                path.resolve(testsRoot, '..', 'code-coverage', 'ui-components.coverage.test.js')
            ];

            for (const optionalFile of optionalCoverageFiles) {
                const normalized = path.normalize(optionalFile);
                if (!files.some((f: string) => path.normalize(path.resolve(testsRoot, f)) === normalized)) {
                    if (fs.existsSync(optionalFile)) {
                        files.push(path.relative(testsRoot, optionalFile));
                    }
                }
            }

            // Add files to the test suite
            files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));

            try {
                // Run the mocha test
                mocha.run((failures: number) => {
                    if (failures > 0) {
                        reject(new Error(`${failures} tests failed.`));
                    } else {
                        resolve();
                    }
                });
            } catch (err) {
                console.error(err);
                reject(err);
            }
        } catch (err) {
            reject(err);
        }
        /* c8 ignore end */
    });
}