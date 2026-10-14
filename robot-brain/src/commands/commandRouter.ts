import { commandHelpText } from './commandHelp';
import type { ParsedCommand } from './commandTypes';

export interface CommandReply { text: string; failed: boolean }

/** Extension-owned adapters, not another AI or editor engine. */
export interface CommandHandlers {
    chat(text: string): Promise<CommandReply>;
    ask(question: string, useEditorContext: boolean): Promise<CommandReply>;
    fix(): Promise<CommandReply>;
    whatChanged(): CommandReply;
    write(input: ParsedCommand): Promise<CommandReply>;
    validate?(input: ParsedCommand): Promise<CommandReply>;
}

export async function routeCommand(input: ParsedCommand, handlers: CommandHandlers): Promise<CommandReply> {
    if (input.kind === 'ordinary') { return handlers.chat(input.instruction); }
    if (input.unknownCommand || !input.command) {
        return { failed: true, text: `${input.unknownCommand ? `Unknown command: #${input.unknownCommand}.` : 'Expected a command name immediately after #.'}\n${commandHelpText()}` };
    }
    if (input.malformed) {
        return { failed: true, text: `Incomplete or malformed #${input.command.replace('_', ' ')} command. ${input.command === 'write' ? 'Example: #write py code to check prime.' : input.command === 'teach' ? 'Example: #teach recursion.' : 'Try #help for syntax.'}` };
    }
    switch (input.command) {
        case 'help': return { text: commandHelpText(), failed: false };
        case 'write': return handlers.write(input);
        case 'what_changed': return handlers.whatChanged();
        case 'fix':
            if (!/^(this|it|this issue|current issue|this error)?$/i.test(input.instruction)) {
                return { failed: true, text: 'Fix targets an active diagnostic. Use #fix this for the existing approval workflow; custom edits are not enabled in Phase 1.' };
            }
            return handlers.fix();
        case 'test':
            return handlers.validate ? handlers.validate(input) : handlers.ask('Discuss a test plan and relevant test cases. This request is advisory because no validation executor is connected.', true);
        default: {
            const directives = {
                explain: 'Explain the supplied code or question, grounding claims in provided context.',
                debug: 'Analyze the reported bug and suggest diagnostic steps. Do not claim to have executed a debugger.',
                teach: 'Teach the requested concept at the configured explanation depth, using a small example.',
                test: 'Discuss a test plan and relevant test cases. Do not execute tests or claim tests passed.',
                review: 'Review the supplied code for concrete correctness and maintainability concerns.',
            };
            return handlers.ask(`${directives[input.command]}\nThis request is advisory: do not claim files were changed, saved, executed, or tested.\nRequest: ${input.instruction || 'the current code'}${input.language ? `\nRequested language: ${input.language}` : ''}`, input.command !== 'teach');
        }
    }
}
