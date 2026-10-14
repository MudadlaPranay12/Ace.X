import {
    COMMAND_NAMES,
    type CommandLanguage,
    type CommandName,
    type ParsedCommand,
} from './commandTypes';

const LANGUAGE_ALIASES: Record<string, CommandLanguage> = {
    py: 'python',
    python: 'python',
    js: 'javascript',
    javascript: 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    'c++': 'cpp',
    cs: 'csharp',
    csharp: 'csharp',
    go: 'go',
    golang: 'go',
    rs: 'rust',
    rust: 'rust',
    kt: 'kotlin',
    kotlin: 'kotlin',
    rb: 'ruby',
    ruby: 'ruby',
    php: 'php',
    swift: 'swift',
    dart: 'dart',
    sql: 'sql',
    sh: 'shell',
    shell: 'shell',
    bash: 'shell',
};

const COMMAND_ALIASES: Record<string, CommandName> = {
    write: 'write',
    create: 'write',
    generate: 'write',
    explain: 'explain',
    why: 'explain',
    debug: 'debug',
    teach: 'teach',
    learn: 'teach',
    test: 'test',
    review: 'review',
    fix: 'fix',
    repair: 'fix',
    'what-changed': 'what_changed',
    'what_changed': 'what_changed',
    help: 'help',
};

function cleanInstruction(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parses only the explicit user grammar. It does not infer commands from
 * ordinary prose and does not invoke AI or VS Code APIs.
 */
export function parseCommand(input: string): ParsedCommand {
    const originalText = input;
    const trimmed = input.trim();
    if (!trimmed.startsWith('#')) {
        return { kind: 'ordinary', originalText, instruction: trimmed };
    }

    const body = trimmed.slice(1);
    if (!body || !/^[a-z]/i.test(body)) {
        return { kind: 'command', originalText, instruction: '', malformed: true };
    }

    const tokens = body.split(/\s+/);
    const rawCommand = tokens.shift()?.toLowerCase() ?? '';
    let command = Object.hasOwn(COMMAND_ALIASES, rawCommand) ? COMMAND_ALIASES[rawCommand] : undefined;
    if (rawCommand === 'what' && tokens[0]?.toLowerCase() === 'changed') {
        tokens.shift();
        command = 'what_changed';
    }
    const instructionTokens = [...tokens];
    const languageToken = instructionTokens[0]?.toLowerCase();
    const language = command === 'write' && languageToken && Object.hasOwn(LANGUAGE_ALIASES, languageToken) ? LANGUAGE_ALIASES[languageToken] : undefined;
    if (language) {
        instructionTokens.shift();
    }

    if (!command) {
        return {
            kind: 'command',
            originalText,
            instruction: cleanInstruction(instructionTokens.join(' ')),
            unknownCommand: rawCommand,
            malformed: !rawCommand,
        };
    }

    return {
        kind: 'command',
        originalText,
        command,
        language,
        instruction: cleanInstruction(instructionTokens.join(' ')),
        malformed: (command !== 'help' && command !== 'what_changed' && instructionTokens.length === 0)
            || ((command === 'help' || command === 'what_changed') && instructionTokens.length > 0),
    };
}

export function isCommandName(value: string): value is CommandName {
    return (COMMAND_NAMES as readonly string[]).includes(value);
}
