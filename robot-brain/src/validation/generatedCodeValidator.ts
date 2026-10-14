import type { CommandLanguage } from '../commands/commandTypes';

export interface CodeValidationResult {
    valid: boolean;
    code: string;
    language: CommandLanguage;
    error?: string;
}

const LANGUAGE_MARKERS: Partial<Record<CommandLanguage, RegExp>> = {
    python: /(?:\bdef\s+\w+|\bclass\s+\w+|\bimport\s+\w+|\bfrom\s+\w+\s+import\b|\bif\s+|\bfor\s+|\bwhile\s+|\bprint\s*\(|\breturn\b)/,
    javascript: /(?:\b(?:const|let|var|function|class|import|export)\b|=>|console\.log\s*\()/,
    typescript: /(?:\b(?:const|let|var|function|class|interface|type|import|export)\b|=>|:\s*(?:string|number|boolean)\b)/,
    java: /(?:\b(?:public|private|protected|class|interface|static|void|import)\b|System\.out\.)/,
    c: /(?:#include|\b(?:int|void|char|struct|printf|scanf)\b)/,
    cpp: /(?:#include|\b(?:std::|int|void|class|vector|cout|cin)\b)/,
    csharp: /(?:\b(?:using|namespace|class|public|private|static|void|string)\b|Console\.)/,
    go: /(?:\b(?:package|func|import|type|struct|go)\b)/,
    rust: /(?:\b(?:fn|let|mut|struct|impl|use|pub|println!)\b)/,
    kotlin: /(?:\b(?:fun|val|var|class|object|import|println)\b)/,
    ruby: /(?:\b(?:def|class|module|require|puts|end)\b)/,
    php: /(?:<\?php|\$\w+|\b(?:function|class|echo)\b)/,
    swift: /(?:\b(?:func|let|var|class|struct|import|print)\b)/,
    dart: /(?:\b(?:void|class|final|var|import|Future)\b)/,
    sql: /(?:\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|FROM|WHERE|JOIN)\b)/i,
    shell: /(?:^#!.*sh|\b(?:echo|if|then|fi|for|do|done)\b|\$\w+)/,
};

function stripCodeFence(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:[\w+#-]+)?\s*\n([\s\S]*?)\n?```$/);
    return (fenced ? fenced[1] : trimmed).trim();
}

export function validateGeneratedCode(raw: string, language: CommandLanguage): CodeValidationResult {
    const code = stripCodeFence(String(raw ?? ''));
    if (!code) { return { valid: false, code: '', language, error: 'The provider returned an empty code response.' }; }
    if (code.length > 100_000) { return { valid: false, code, language, error: 'The generated code is too large to insert safely.' }; }
    if (/^(?:here(?:'s| is)|sure|of course|i can|the code is)\b/i.test(code)) {
        return { valid: false, code, language, error: 'The provider returned prose instead of a code block.' };
    }
    if (language === 'python' && /\b(?:public\s+class|System\.out|#include|function\s+\w+)\b/.test(code)) {
        return { valid: false, code, language, error: 'The response appears to be for a different language.' };
    }
    const marker = LANGUAGE_MARKERS[language];
    if (marker && !marker.test(code)) {
        return { valid: false, code, language, error: `The response does not look like ${language} code.` };
    }
    return { valid: true, code, language };
}
