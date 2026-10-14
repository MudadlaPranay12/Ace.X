export const COMMAND_HELP = [
    'Ace.X commands:',
    '#write [language] <request> — prepare code for the active editor (writing arrives in the next phase).',
    '#explain [request] — explain the current issue or a coding question.',
    '#debug [request] — investigate a bug or debugging question.',
    '#teach [topic] — learn a concept at your preferred explanation depth.',
    '#test [request] — discuss or plan tests for the current code.',
    '#review [request] — review code or a proposed change.',
    '#fix [request] — use the existing approval-gated fix flow when an issue is active.',
    '#what changed — describe the latest recorded change or verification.',
    '#help — show this help.',
    '',
    'Language aliases include py/python, js/javascript, ts/typescript, cpp/c++, and sh/bash/shell.',
    'Ordinary messages without # continue as normal conversation. Follow-up messages can omit # when context is available.',
].join('\n');

export function commandHelpText(): string {
    return COMMAND_HELP;
}
