export const COMMAND_NAMES = [
    'write',
    'explain',
    'debug',
    'teach',
    'test',
    'review',
    'fix',
    'what_changed',
    'help',
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

export type CommandLanguage =
    | 'python'
    | 'javascript'
    | 'typescript'
    | 'java'
    | 'c'
    | 'cpp'
    | 'csharp'
    | 'go'
    | 'rust'
    | 'kotlin'
    | 'ruby'
    | 'php'
    | 'swift'
    | 'dart'
    | 'sql'
    | 'shell';

export interface ParsedCommand {
    kind: 'command' | 'ordinary';
    originalText: string;
    command?: CommandName;
    language?: CommandLanguage;
    /** Text after the command and optional language alias. */
    instruction: string;
    /** True when the command prefix was present but not recognized. */
    unknownCommand?: string;
    /** True for a command with no usable command name or argument. */
    malformed?: boolean;
}
