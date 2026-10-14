import * as vscode from 'vscode';
import * as path from 'path';
import type * as tsModule from 'typescript';

/**
 * Lazy access to the TypeScript Compiler API.
 *
 * WHY THIS EXISTS
 * ---------------
 * `typescript` is a build-time dependency of this extension, not a shipped one.
 * It is ~23 MB and nothing else at runtime needs it, so it is deliberately kept
 * out of the VSIX. That means a plain top-level `import * as ts from
 * 'typescript'` is a latent production failure: the module is required during
 * activation (astDependencyResolver and importInspector are both imported
 * eagerly), the require throws `Cannot find module 'typescript'`, and the whole
 * extension fails to activate — taking the companion with it.
 *
 * TypeScript resolution therefore happens here, on first actual use, and is
 * allowed to fail:
 *
 *   1. A real `typescript` package on the resolution path (development, or an
 *      install where it happens to be present). Cheapest and most accurate.
 *   2. The copy VS Code already ships inside its own built-in
 *      `vscode.typescript-language-features` extension. This is the same
 *      compiler the editor uses for its language service, so it is guaranteed
 *      present in every VS Code build and stays current with the host.
 *   3. Nothing — callers degrade instead of throwing.
 *
 * Degradation is intentional and silent-but-logged: AST dependency resolution
 * and deprecation scanning both enrich error explanations. Losing them degrades
 * the quality of an explanation; it must never prevent the extension from
 * starting, and it must never be the reason a user's error goes unexplained.
 * Every consumer checks for null and falls back to its non-AST path.
 */

export type TypeScriptApi = typeof tsModule;

const BUNDLED_EXTENSION_ID = 'vscode.typescript-language-features';

let cached: TypeScriptApi | null | undefined;

/**
 * Resolves the TypeScript Compiler API, or null when it cannot be found.
 * The result (including a null result) is cached — this is called per AST parse,
 * not per parse *operation*, and a failed require must not be retried on every
 * keystroke-triggered scan.
 */
export function loadTypeScript(): TypeScriptApi | null {
    if (cached !== undefined) {
        return cached;
    }

    cached = resolveFromNodeModules() ?? resolveFromVsCodeBundle();

    if (!cached) {
        console.warn(
            '[BotX] TypeScript Compiler API unavailable — AST-based analysis ' +
            '(dependency resolution, deprecation scanning) is disabled. Error ' +
            'explanations will be less specific. This does not affect the ' +
            'companion, sensors, or the decision pipeline.'
        );
    }

    return cached;
}

function resolveFromNodeModules(): TypeScriptApi | null {
    try {
        return require('typescript') as TypeScriptApi;
    } catch {
        return null;
    }
}

/**
 * VS Code bundles the TypeScript language service in a built-in extension.
 * Its `node_modules` directory is the only reliable place to find the compiler
 * at runtime without shipping our own copy.
 */
function resolveFromVsCodeBundle(): TypeScriptApi | null {
    try {
        const bundled = vscode.extensions.getExtension(BUNDLED_EXTENSION_ID);
        if (!bundled) {
            return null;
        }
        const entry = path.join(bundled.extensionPath, 'node_modules', 'typescript');
        return require(entry) as TypeScriptApi;
    } catch {
        return null;
    }
}