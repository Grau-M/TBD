import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function createTempJunction(targetDir: string): string {
	const linkDir = path.join(os.tmpdir(), `tbd-ext-link-${process.pid}-${Date.now()}`);
	fs.symlinkSync(targetDir, linkDir, 'junction');
	return linkDir;
}

async function main() {
	let linkRoot = '';
	let userDataDir = '';
	let extensionsDir = '';
	try {
		const workspaceRoot = path.resolve(__dirname, '../../');
		linkRoot = createTempJunction(workspaceRoot);

		const extensionDevelopmentPath = linkRoot;
		const extensionTestsPath = path.join(linkRoot, 'out', 'test', 'suite');
		userDataDir = path.join(os.tmpdir(), 'tbd-vscode-test-user-data');
		extensionsDir = path.join(os.tmpdir(), 'tbd-vscode-test-extensions');

		fs.mkdirSync(userDataDir, { recursive: true });
		fs.mkdirSync(extensionsDir, { recursive: true });

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				`--user-data-dir=${userDataDir}`,
				`--extensions-dir=${extensionsDir}`,
			],
		});
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	} finally {
		if (userDataDir && fs.existsSync(userDataDir)) {
			try {
				fs.rmSync(userDataDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup: ignore transient file lock issues.
			}
		}
		if (extensionsDir && fs.existsSync(extensionsDir)) {
			try {
				fs.rmSync(extensionsDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup: ignore transient file lock issues.
			}
		}
		if (linkRoot && fs.existsSync(linkRoot)) {
			fs.unlinkSync(linkRoot);
		}
	}
}

main();
