import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        // ONE Eve only: the extension host activated for tests must never
        // auto-launch a visible Eve window. The test runner merges
        // process.env into the extension host environment, so this flag
        // reaches the Brain, which suppresses auto-launch (manual Show Eve
        // still works). No test may spawn its own visible robot either.
        process.env['ACEX_NO_EVE'] = '1';

        const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
        const extensionTestsPath = path.resolve(__dirname, './index');

        // Optional local overrides so the demo workspace and an already
        // installed VS Code build can be used without downloading anything.
        const vscodeExecutablePath = process.env.BOTX_TEST_VSCODE || undefined;
        const workspace = process.env.BOTX_TEST_WORKSPACE || undefined;

        // The live Phase 6 suite needs a REAL language server (Pylance) to produce
        // real diagnostics, so it opts out of --disable-extensions. Everything
        // else keeps the isolated, fast default.
        const withExtensions = process.env.BOTX_TEST_WITH_EXTENSIONS === '1';

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            vscodeExecutablePath,
            launchArgs: [
                ...(withExtensions ? [] : ['--disable-extensions']),
                '--disable-gpu',
                ...(workspace ? [workspace] : [])
            ]
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
