/**
 * codingIntent — deterministic detection of natural-language coding intent in comments.
 *
 * This module does NOT use AI. It uses lightweight pattern matching to identify
 * comments that likely express a request to generate code. The actual code
 * generation still goes through the existing AI path when the user explicitly
 * requests it (Fix with BotX).
 *
 * Philosophy:
 * - Conservative: only flag clear imperative coding requests
 * - Language-aware: uses comment syntax and language-specific keywords
 * - Safe: ordinary comments (TODO, author, notes) are never flagged
 * - No false positives for documentation-style comments
 */

export interface CodingIntentResult {
    /** True when the comment appears to be a coding request. */
    isCodingIntent: boolean;
    /** The extracted intent text, normalized for generation. */
    intentText?: string;
    /** Confidence level (0-1) for telemetry only. */
    confidence: number;
    /** The original comment text. */
    originalComment: string;
    /** Line number (1-based) of the comment. */
    line: number;
}

/**
 * Imperative verbs that strongly indicate a coding request.
 * These are verbs that typically start a request to write/implement/create code.
 */
const CODING_VERBS = [
    'create',
    'write',
    'implement',
    'add',
    'generate',
    'build',
    'make',
    'define',
    'declare',
    'calculate',
    'compute',
    'check',
    'validate',
    'verify',
    'parse',
    'read',
    'load',
    'fetch',
    'get',
    'retrieve',
    'print',
    'output',
    'display',
    'show',
    'convert',
    'transform',
    'format',
    'sort',
    'filter',
    'map',
    'reduce',
    'find',
    'search',
    'query',
    'execute',
    'run',
    'run the',
    'run a',
    'implement a',
    'implement an',
    'write a',
    'write an',
    'create a',
    'create an',
    'add a',
    'add an',
    'build a',
    'build an',
    'make a',
    'make an',
    'define a',
    'define an',
];

/**
 * Phrases that indicate this is NOT a coding request (documentation/notes).
 * These override any verb matches.
 */
const NON_CODING_PHRASES = [
    'todo',
    'fixme',
    'hack',
    'bug',
    'note',
    'author',
    'copyright',
    'license',
    'configuration',
    'config',
    'settings',
    'parameters',
    'args',
    'arguments',
    'returns',
    'return',
    'param',
    'description',
    'summary',
    'example',
    'usage',
    'see also',
    'reference',
    'link',
    'url',
    'version',
    'deprecated',
    'experimental',
    'internal',
    'private',
    'public',
    'protected',
    'override',
    'abstract',
    'static',
    'final',
    'const',
    'readonly',
    'mutable',
    'immutable',
    'thread-safe',
    'thread safe',
    'performance',
    'optimization',
    'refactor',
    'cleanup',
    'clean up',
    'refactor',
    'rename',
    'remove',
    'delete',
    'unused',
    'dead code',
    'temporary',
    'temp',
    'debug',
    'test',
    'spec',
    'mock',
    'stub',
    'fixture',
    'benchmark',
    'profile',
];

/**
 * Language-specific comment patterns and verb adjustments.
 */
interface LanguageConfig {
    /** Single-line comment prefix (e.g., #, //, --) */
    singleLinePrefix: string;
    /** Multi-line comment open/close (e.g., open=, close=) */
    multiLineDelimiters?: { open: string; close: string };
    /** Additional language-specific coding verbs */
    extraVerbs?: string[];
    /** Language-specific non-coding phrases */
    extraNonCoding?: string[];
}

/**
 * Language configurations keyed by VS Code languageId.
 * Falls back to generic if language not explicitly listed.
 */
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
    python: {
        singleLinePrefix: '#',
        extraVerbs: ['def', 'class', 'import', 'from', 'lambda', 'yield', 'await', 'async'],
    },
    javascript: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['function', 'const', 'let', 'var', 'async', 'await', 'export', 'import'],
    },
    typescript: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['interface', 'type', 'enum', 'const', 'let', 'async', 'await', 'export', 'import'],
    },
    java: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['public', 'private', 'protected', 'static', 'final', 'class', 'interface', 'enum', 'void', 'return'],
    },
    c: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['int', 'void', 'char', 'float', 'double', 'struct', 'typedef', 'define', 'include'],
    },
    cpp: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['class', 'template', 'namespace', 'public', 'private', 'protected', 'virtual', 'override'],
    },
    csharp: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['public', 'private', 'protected', 'static', 'class', 'interface', 'void', 'async', 'await'],
    },
    go: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['func', 'package', 'import', 'var', 'const', 'type', 'struct', 'interface'],
    },
    rust: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['fn', 'let', 'mut', 'struct', 'enum', 'impl', 'trait', 'mod', 'use', 'pub'],
    },
    kotlin: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['fun', 'val', 'var', 'class', 'data', 'object', 'companion', 'interface'],
    },
    php: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['function', 'class', 'interface', 'trait', 'namespace', 'use', 'public', 'private', 'protected'],
    },
    ruby: {
        singleLinePrefix: '#',
        extraVerbs: ['def', 'class', 'module', 'require', 'include', 'extend', 'attr_accessor', 'attr_reader'],
    },
    swift: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['func', 'var', 'let', 'class', 'struct', 'protocol', 'extension', 'import'],
    },
    dart: {
        singleLinePrefix: '//',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['void', 'class', 'function', 'import', 'library', 'part', 'mixin', 'abstract'],
    },
    sql: {
        singleLinePrefix: '--',
        multiLineDelimiters: { open: '/*', close: '*/' },
        extraVerbs: ['select', 'insert', 'update', 'delete', 'create', 'drop', 'alter', 'join', 'where', 'group by', 'order by'],
    },
    shell: {
        singleLinePrefix: '#',
        extraVerbs: ['echo', 'read', 'if', 'then', 'else', 'fi', 'for', 'while', 'do', 'done', 'function'],
    },
};

/**
 * Normalizes a languageId to our config key.
 */
function normalizeLanguageId(languageId: string): string {
    const id = languageId.toLowerCase();
    // Common aliases
    if (id === 'js' || id === 'jsx') return 'javascript';
    if (id === 'ts' || id === 'tsx') return 'typescript';
    if (id === 'py') return 'python';
    if (id === 'rb') return 'ruby';
    if (id === 'sh' || id === 'bash' || id === 'zsh') return 'shell';
    if (id === 'c++' || id === 'cxx' || id === 'cc') return 'cpp';
    if (id === 'c#') return 'csharp';
    if (id === 'golang') return 'go';
    if (id === 'rs') return 'rust';
    if (id === 'kt') return 'kotlin';
    if (id === 'pl') return 'perl';
    return id;
}

/**
 * Extracts the text content of a comment line, stripping the comment prefix.
 */
function extractCommentText(line: string, config: LanguageConfig): string {
    const prefix = config.singleLinePrefix;
    const trimmed = line.trimStart();
    if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
    }
    // Multi-line comment content (simplified - just strip delimiters)
    if (config.multiLineDelimiters) {
        const open = config.multiLineDelimiters.open;
        const close = config.multiLineDelimiters.close;
        let text = line.trim();
        if (text.startsWith(open)) text = text.slice(open.length);
        if (text.endsWith(close)) text = text.slice(0, -close.length);
        return text.trim();
    }
    return trimmed;
}

/**
 * Checks if text contains a non-coding phrase that overrides intent.
 */
function hasNonCodingOverride(text: string, config: LanguageConfig): boolean {
    const lower = text.toLowerCase();
    for (const phrase of NON_CODING_PHRASES) {
        if (lower.includes(phrase)) return true;
    }
    if (config.extraNonCoding) {
        for (const phrase of config.extraNonCoding) {
            if (lower.includes(phrase.toLowerCase())) return true;
        }
    }
    return false;
}

/**
 * Canonical first-program phrases learners write as bare task comments, e.g.
 * `# hello world` meaning "write a hello-world program". Kept deliberately
 * tiny and exact: anything longer or less canonical stays non-intent, so the
 * conservative default is preserved for ordinary prose comments.
 */
const BARE_PROGRAM_TASKS = [
    'hello world',
    'hello, world',
    'fizzbuzz',
    'fizz buzz',
    'fibonacci',
];

/**
 * Matches a bare program-task comment: the whole comment (after stripping
 * trailing punctuation) is exactly a canonical task phrase, optionally
 * followed by the word "program". Returns the matched phrase, if any.
 */
function matchBareProgramTask(text: string): string | undefined {
    const normalized = text.toLowerCase().replace(/[!.:;]+$/g, '').trim();
    if (normalized.split(/\s+/).filter((word) => word.length > 0).length > 4) {
        return undefined;
    }
    for (const task of BARE_PROGRAM_TASKS) {
        if (normalized === task || normalized === `${task} program` || normalized === `${task} programme`) {
            return task;
        }
    }
    return undefined;
}

/**
 * Checks if text contains a strong coding verb/phrase.
 */
function hasCodingVerb(text: string, config: LanguageConfig): boolean {
    const lower = text.toLowerCase();
    const verbs = [...CODING_VERBS, ...(config.extraVerbs || [])];
    for (const verb of verbs) {
        // Word boundary check for multi-word phrases
        if (verb.includes(' ')) {
            if (lower.includes(verb)) return true;
        } else {
            // Single word: check word boundary
            const regex = new RegExp(`\\b${verb}\\b`, 'i');
            if (regex.test(lower)) return true;
        }
    }
    return false;
}

/**
 * Analyzes a comment line for coding intent.
 *
 * @param line - The full source line (including comment prefix)
 * @param lineNumber - 1-based line number
 * @param languageId - VS Code languageId (e.g., 'python', 'javascript')
 * @returns CodingIntentResult with detection result and confidence
 */
export function detectCodingIntent(
    line: string,
    lineNumber: number,
    languageId: string
): CodingIntentResult {
    const normalizedId = normalizeLanguageId(languageId);
    const config = LANGUAGE_CONFIGS[normalizedId] || { singleLinePrefix: '//' };

    const commentText = extractCommentText(line, config);
    if (!commentText) {
        return { isCodingIntent: false, confidence: 0, originalComment: line, line: lineNumber };
    }

    // Skip if it's clearly non-coding
    if (hasNonCodingOverride(commentText, config)) {
        return { isCodingIntent: false, confidence: 0, originalComment: line, line: lineNumber };
    }

    // Check for strong coding intent
    const hasVerb = hasCodingVerb(commentText, config);
    if (!hasVerb) {
        // No verb: the only remaining intent shape is a bare canonical
        // first-program comment such as `# hello world`.
        const bareTask = matchBareProgramTask(commentText);
        if (!bareTask) {
            return { isCodingIntent: false, confidence: 0, originalComment: line, line: lineNumber };
        }
        return {
            isCodingIntent: true,
            intentText: commentText,
            confidence: 0.35,
            originalComment: line,
            line: lineNumber,
        };
    }

    // Confidence based on verb strength and context
    let confidence = 0.6; // Base confidence for verb match
    const lower = commentText.toLowerCase();

    // Higher confidence for explicit request patterns
    const requestPatterns = [
        /^(create|write|implement|add|generate|make|build)\s+(a|an|the)?\s+\w+/i,
        /^(how to|how do i|can you|please)\s+(create|write|implement|make|build)\s+/i,
    ];
    for (const pattern of requestPatterns) {
        if (pattern.test(commentText)) {
            confidence = Math.min(confidence + 0.3, 0.95);
            break;
        }
    }

    // Slightly lower confidence for bare verb without clear object
    const words = commentText.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) {
        confidence = Math.max(confidence - 0.15, 0.3);
    }

    return {
        isCodingIntent: true,
        intentText: commentText,
        confidence,
        originalComment: line,
        line: lineNumber,
    };
}

/**
 * Scans a full document for coding intent comments.
 * Returns all detected intents, ordered by line number.
 */
export function scanDocumentForCodingIntents(
    documentText: string,
    languageId: string
): CodingIntentResult[] {
    const lines = documentText.split(/\r?\n/);
    const results: CodingIntentResult[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const result = detectCodingIntent(line, i + 1, languageId);
        if (result.isCodingIntent) {
            results.push(result);
        }
    }

    return results;
}

/**
 * Checks if a specific line has coding intent.
 * Convenience wrapper for single-line checks.
 */
export function hasCodingIntentAtLine(
    documentText: string,
    lineNumber: number,
    languageId: string
): CodingIntentResult | null {
    const lines = documentText.split(/\r?\n/);
    if (lineNumber < 1 || lineNumber > lines.length) return null;
    const result = detectCodingIntent(lines[lineNumber - 1], lineNumber, languageId);
    return result.isCodingIntent ? result : null;
}

export default {
    detectCodingIntent,
    scanDocumentForCodingIntents,
    hasCodingIntentAtLine,
};