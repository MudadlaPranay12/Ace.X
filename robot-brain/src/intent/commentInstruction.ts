import * as crypto from 'node:crypto';

export type CommentInstructionLanguage = 'python' | 'javascript' | 'typescript' | 'java';

export interface CommentInstruction {
    fileUri: string;
    id: string;
    language: CommentInstructionLanguage;
    text: string;
    startLine: number;
    endLine: number;
    startCharacter: number;
    endCharacter: number;
    raw: string;
}

interface Syntax { linePrefix?: string; block?: { open: string; close: string } }

const SYNTAX: Record<CommentInstructionLanguage, Syntax> = {
    python: { linePrefix: '#' },
    javascript: { linePrefix: '//', block: { open: '/*', close: '*/' } },
    typescript: { linePrefix: '//', block: { open: '/*', close: '*/' } },
    java: { linePrefix: '//', block: { open: '/*', close: '*/' } },
};

function languageOf(languageId: string): CommentInstructionLanguage | undefined {
    const normalized = languageId.toLowerCase();
    if (normalized === 'py' || normalized === 'python') return 'python';
    if (['js', 'javascript'].includes(normalized)) return 'javascript';
    if (['ts', 'typescript'].includes(normalized)) return 'typescript';
    if (normalized === 'java') return 'java';
    return undefined;
}

function explicitText(raw: string, syntax: Syntax): string | undefined {
    let text = raw.trim();
    if (syntax.linePrefix && text.startsWith(syntax.linePrefix)) text = text.slice(syntax.linePrefix.length).trim();
    if (syntax.block) {
        if (text.startsWith(syntax.block.open)) text = text.slice(syntax.block.open.length).trim();
        if (text.endsWith(syntax.block.close)) text = text.slice(0, -syntax.block.close.length).trim();
        text = text.replace(/^\*\s?/gm, '').trim();
    }
    const match = text.match(/^Eve\s*:\s*(\S[\s\S]*?)\s*$/i);
    return match?.[1]?.trim() || undefined;
}

function stableId(fileUri: string, startLine: number, endLine: number, text: string): string {
    return crypto.createHash('sha256').update(`${fileUri}\0${startLine}\0${endLine}\0${text}`).digest('hex').slice(0, 24);
}

/** Parses only explicit Eve markers in the supported comment syntaxes. */
export function parseCommentInstructions(documentText: string, languageId: string, fileUri = ''): CommentInstruction[] {
    const language = languageOf(languageId);
    if (!language) return [];
    const syntax = SYNTAX[language];
    const lines = documentText.split(/\r?\n/);
    const results: CommentInstruction[] = [];
    // Fail closed for multiline string constructs until a full language parser
    // can establish whether a marker is code or a quoted example.
    if (documentText.includes('```') || documentText.includes('"""') || documentText.includes("'''" ) || documentText.includes('`')) return [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();
        const isLine = Boolean(syntax.linePrefix && trimmed.startsWith(syntax.linePrefix));
        const isBlockStart = Boolean(syntax.block && trimmed.startsWith(syntax.block.open));
        if (!isLine && !isBlockStart) continue;

        let end = index;
        let raw = line;
        if (isBlockStart && syntax.block && !trimmed.includes(syntax.block.close, syntax.block.open.length)) {
            while (end + 1 < lines.length && !lines[end].includes(syntax.block.close)) {
                end += 1;
                raw += `\n${lines[end]}`;
            }
            if (!lines[end].includes(syntax.block.close)) continue;
        }
        const text = raw.trim().startsWith('/**') ? undefined : explicitText(raw, syntax);
        if (text && /^(write|implement|create|add|generate)\s+\S.+/i.test(text) && !text.includes('Eve:')) {
            results.push({ fileUri, id: stableId(fileUri, index, end, text), language, text, startLine: index, endLine: end, startCharacter: 0, endCharacter: lines[end].length, raw });
        }
        index = end;
    }
    return results;
}
