import * as assert from 'assert';
import { parseCommand } from '../../commands/commandParser';
import { commandHelpText } from '../../commands/commandHelp';
import { routeCommand } from '../../commands/commandRouter';

suite('Ace.X command grammar', () => {
    test('parses #write with a Python alias and preserves the request', () => {
        const result = parseCommand('#write py code to check whether a number is prime');
        assert.deepStrictEqual(result, {
            kind: 'command',
            originalText: '#write py code to check whether a number is prime',
            command: 'write',
            language: 'python',
            instruction: 'code to check whether a number is prime',
            malformed: false,
        });
    });

    test('normalizes common language aliases', () => {
        assert.strictEqual(parseCommand('#write js binary search').language, 'javascript');
        assert.strictEqual(parseCommand('#write ts typed helper').language, 'typescript');
        assert.strictEqual(parseCommand('#write c++ queue').language, 'cpp');
        assert.strictEqual(parseCommand('#write bash backup script').language, 'shell');
    });

    test('parses every Phase 1 command and natural-language arguments', () => {
        const cases: Array<[string, string]> = [
            ['#explain this code', 'explain'],
            ['#debug why the loop stops early', 'debug'],
            ['#teach recursion', 'teach'],
            ['#test this function', 'test'],
            ['#review the selected code', 'review'],
            ['#fix this', 'fix'],
            ['#what changed', 'what_changed'],
            ['#help', 'help'],
        ];
        for (const [input, command] of cases) {
            assert.strictEqual(parseCommand(input).command, command, input);
        }
        assert.strictEqual(parseCommand('#debug why the loop stops early').instruction, 'why the loop stops early');
    });

    test('ordinary chat remains ordinary and preserves its text', () => {
        assert.deepStrictEqual(parseCommand('Why does this function return undefined?'), {
            kind: 'ordinary',
            originalText: 'Why does this function return undefined?',
            instruction: 'Why does this function return undefined?',
        });
    });

    test('unknown and malformed commands are explicit and safe', () => {
        const unknown = parseCommand('#dance around the bug');
        assert.strictEqual(unknown.unknownCommand, 'dance');
        assert.strictEqual(unknown.malformed, false);
        assert.strictEqual(parseCommand('#').malformed, true);
        assert.strictEqual(parseCommand('#write').malformed, true);
        assert.strictEqual(parseCommand('#help').malformed, false);
        assert.strictEqual(parseCommand('#what changed').instruction, '');
    });

    test('help documents the grammar without claiming Phase 2 behavior', () => {
        const help = commandHelpText();
        for (const command of ['#write', '#explain', '#debug', '#teach', '#test', '#review', '#fix', '#what changed', '#help']) {
            assert.ok(help.includes(command), `help should include ${command}`);
        }
        assert.ok(help.includes('next phase'));
        assert.ok(help.includes('py/python'));
    });

    test('routing keeps Phase 1 write safe and delegates advisory commands', async () => {
        const calls: string[] = [];
        const handlers = {
            chat: async (text: string) => { calls.push(`chat:${text}`); return { text, failed: false }; },
            ask: async (text: string) => { calls.push(`ask:${text}`); return { text: 'advice', failed: false }; },
            fix: async () => { calls.push('fix'); return { text: 'fix flow', failed: false }; },
            whatChanged: () => { calls.push('what-changed'); return { text: 'change', failed: false }; },
            write: async () => { calls.push('write'); return { text: 'write', failed: false }; },
        };
        const write = await routeCommand(parseCommand('#write py check prime'), handlers);
        assert.strictEqual(write.failed, false);
        assert.strictEqual(write.text, 'write');
        assert.deepStrictEqual(calls, ['write']);
        await routeCommand(parseCommand('#teach recursion'), handlers);
        assert.ok(String(calls[1]).startsWith('ask:'));
        const changed = await routeCommand(parseCommand('#what changed'), handlers);
        assert.strictEqual(changed.text, 'change');
        assert.strictEqual(calls[2], 'what-changed');
    });

    test('routing delegates ordinary chat and existing fix intent', async () => {
        const calls: string[] = [];
        const handlers = {
            chat: async () => { calls.push('chat'); return { text: 'chat', failed: false }; },
            ask: async () => { calls.push('ask'); return { text: 'ask', failed: false }; },
            fix: async () => { calls.push('fix'); return { text: 'fix', failed: false }; },
            whatChanged: () => ({ text: 'change', failed: false }),
            write: async () => ({ text: 'write', failed: false }),
        };
        await routeCommand(parseCommand('ordinary question'), handlers);
        await routeCommand(parseCommand('#fix this'), handlers);
        assert.deepStrictEqual(calls, ['chat', 'fix']);
    });
});
