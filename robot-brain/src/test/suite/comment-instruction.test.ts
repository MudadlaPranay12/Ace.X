import * as assert from 'assert';
import { parseCommentInstructions } from '../../intent/commentInstruction';

suite('Ace.X explicit Eve comment instructions', () => {
    test('parses supported line comments and ignores ordinary comments', () => {
        const result = parseCommentInstructions('# Eve: write a prime checker\n# TODO: document this', 'python', 'file:///prime.py');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].text, 'write a prime checker');
        assert.strictEqual(result[0].startLine, 0);
        assert.ok(result[0].id.length > 0);
    });

    test('parses JavaScript block instructions across lines', () => {
        const result = parseCommentInstructions('/*\n * Eve: add input validation\n */\nfunction f() {}', 'javascript', 'file:///app.js');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].text, 'add input validation');
        assert.strictEqual(result[0].endLine, 2);
    });

    test('does not interpret strings or unmarked documentation as commands', () => {
        const source = 'const x = "// Eve: do something";\n// Example: Eve: do something\n// write a function';
        assert.deepStrictEqual(parseCommentInstructions(source, 'typescript', 'file:///app.ts'), []);
    });

    test('identity changes when instruction content or location changes', () => {
        const first = parseCommentInstructions('// Eve: write a queue', 'javascript', 'file:///app.js')[0];
        const changed = parseCommentInstructions('// Eve: write a stack', 'javascript', 'file:///app.js')[0];
        assert.notStrictEqual(first.id, changed.id);
    });
});
