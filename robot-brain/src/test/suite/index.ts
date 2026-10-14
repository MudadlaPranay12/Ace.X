import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 10000
    });

    const testsRoot = path.resolve(__dirname, '.');

    return new Promise((resolve, reject) => {
        try {
            const findTestFiles = (dir: string): string[] => {
                const files: string[] = [];
                const entries = fs.readdirSync(dir, { withFileTypes: true });

                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        files.push(...findTestFiles(fullPath));
                    } else if (entry.name.endsWith('.test.js')) {
                        files.push(fullPath);
                    }
                }

                return files;
            };

            const testFiles = findTestFiles(testsRoot);
            testFiles.forEach(f => mocha.addFile(f));

            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}
