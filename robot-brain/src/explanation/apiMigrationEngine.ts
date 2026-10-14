import { Logger } from "../utils/logger";
import { GeminiApiError, type ExpressionType } from "../ai/gemini";
import { GEMINI_API_URL, GEMINI_MODEL, GEMINI_TIMEOUT_MS } from "../config/gemini";

export interface ApiMigrationRequest {
    fileName: string;
    language: string;
    line: number;
    deprecatedLine: string;
    methodSignature: string;
    packageName: string;
    installedVersion?: string;
    targetVersion?: string;
    fileContent: string;
    surroundingCode: string;
}

export interface ApiMigrationResult {
    migratedCode: string;
    summary: string;
    expression: ExpressionType;
}

const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
const MAX_OUTPUT_TOKENS = 1024;

const VALID_EXPRESSIONS: readonly string[] = [
    "IDLE", "THINKING", "HAPPY", "CONFUSED", "HELPFUL", "ALERT"
];

/**
 * Migrates a deprecated API call to modern syntax while preserving the
 * original runtime behavior. Sends the deprecated line, method signature,
 * target package version, and surrounding code context to Gemini; falls back
 * to the original line when the AI is unavailable.
 */
export class ApiMigrationEngine {
    private apiKeyRetriever: (() => Promise<string | undefined>) | undefined;
    private apiErrorHandler: ((status: number) => void) | undefined;

    setApiKeyRetriever(retriever: () => Promise<string | undefined>): void {
        this.apiKeyRetriever = retriever;
    }

    setApiErrorHandler(handler: (status: number) => void): void {
        this.apiErrorHandler = handler;
    }

    private notifyApiError(err: unknown): void {
        if (err instanceof GeminiApiError && (err.status === 401 || err.status === 429)) {
            this.apiErrorHandler?.(err.status);
        }
    }

    public async migrateApiCall(request: ApiMigrationRequest): Promise<ApiMigrationResult> {
        Logger.info("API MIGRATION ENGINE", {
            "Event": "Migrating API call",
            "File": request.fileName.split(/[\\/]/).pop() || request.fileName,
            "Line": String(request.line),
            "Symbol": request.methodSignature
        });

        const prompt = this.buildPrompt(request);

        try {
            const data = await this.callGemini(prompt);
            const migratedCode = this.normalizeMigratedCode(data["migratedCode"], request.deprecatedLine);
            const result: ApiMigrationResult = {
                migratedCode,
                summary: String(data["summary"] ?? "Migrated the deprecated API call to modern syntax.").slice(0, 500),
                expression: this.toValidExpression(data["expression"])
            };
            Logger.info("API MIGRATION ENGINE", {
                "Event": "Migration complete",
                "Migrated length": String(result.migratedCode.length),
                "Expression": result.expression
            });
            return result;
        } catch (err) {
            this.notifyApiError(err);
            const reason = err instanceof Error ? err.message : String(err);
            Logger.info("API MIGRATION ENGINE", {
                "Event": "Migration failed",
                "Reason": reason
            });
            return {
                migratedCode: request.deprecatedLine,
                summary: `I could not reach the AI to migrate this API call — the line is unchanged. Review it manually.`,
                expression: "CONFUSED"
            };
        }
    }

    private buildPrompt(request: ApiMigrationRequest): string {
        const fileName = request.fileName.split(/[\\/]/).pop() || request.fileName;
        const language = request.language || "code";
        const versionLine = [
            request.packageName,
            request.installedVersion ? `installed ${request.installedVersion}` : "installed version unknown",
            request.targetVersion ? `→ target ${request.targetVersion}` : ""
        ].filter(Boolean).join(" · ");

        return [
            "You are Ace.X, a paired-programming assistant embedded in a small desktop robot.",
            `Migrate a deprecated API call in ${fileName} (${language}) to modern syntax while preserving its runtime behavior.`,
            "",
            `Library: ${versionLine}`,
            `Deprecated symbol: ${request.methodSignature}`,
            `Deprecated line ${request.line}:`,
            "```",
            request.deprecatedLine,
            "```",
            "",
            "Surrounding code context:",
            "```",
            request.surroundingCode,
            "```",
            "",
            "Rules:",
            "- Replace the deprecated call with its modern equivalent (e.g. ReactDOM.render → createRoot().render, url.parse → new URL).",
            "- Preserve variable names, arguments, and surrounding logic exactly — only the deprecated API changes.",
            "- If the surrounding context is too small to be sure, keep the change minimal and safe.",
            "- Respond ONLY with valid JSON:",
            '{ "summary": "1-2 sentence explanation of the migration", "migratedCode": "the exact replacement for the deprecated line (may span multiple lines)", "expression": "IDLE" | "THINKING" | "HAPPY" | "CONFUSED" | "HELPFUL" | "ALERT" }',
            "",
            "- The \"migratedCode\" field must be raw code, NOT wrapped in markdown code fences."
        ].join("\n");
    }

    private async callGemini(prompt: string): Promise<Record<string, unknown>> {
        const apiKey = await this.resolveApiKey();
        if (!apiKey) {
            throw new Error("Gemini API key not found");
        }

        const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => { controller.abort(); }, GEMINI_TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: MAX_OUTPUT_TOKENS
                    }
                }),
                signal: controller.signal
            });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            throw new Error(`Gemini API request failed: ${String(fetchError)}`);
        }

        clearTimeout(timeoutId);

        if (!response.ok) {
            if (response.status === 401 || response.status === 429) {
                const reason = response.status === 401
                    ? `Gemini API unauthorized (${response.status})`
                    : `Gemini API quota exceeded (${response.status})`;
                throw new GeminiApiError(response.status, reason);
            }
            throw new Error(`Gemini API error: ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength === '0') {
            throw new Error('Gemini API returned empty response body');
        }

        const responseText = await response.text();
        if (!responseText || responseText.trim().length === 0) {
            throw new Error('Gemini API returned empty response body');
        }

        let data: Record<string, unknown>;
        try {
            data = JSON.parse(responseText) as Record<string, unknown>;
        } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.error('[BotX Network Error] Failed to parse API response:', msg, 'Raw response:', responseText.slice(0, 200));
            throw new Error(`Invalid JSON from Gemini API: ${responseText.slice(0, 100)}`);
        }
        const candidate = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;

        if (!candidate || candidate.length === 0) {
            throw new Error("Empty Gemini response");
        }

        const text = candidate[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new Error("No text in Gemini response");
        }

        const jsonStart = text.indexOf("{");
        const jsonEnd = text.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) {
            throw new Error("Invalid JSON in Gemini response");
        }

        try {
            return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
        } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.error('[BotX Network Error] Failed to parse Gemini inner JSON:', msg);
            throw new Error(`Invalid JSON in Gemini response text: ${text.slice(jsonStart, jsonStart + 100)}`);
        }
    }

    private normalizeMigratedCode(value: unknown, fallback: string): string {
        if (typeof value !== "string") {
            return fallback;
        }
        let code = value.trim();
        const fence = code.match(/^```(?:[A-Za-z0-9_-]*)?\n?([\s\S]*?)\n?```$/);
        if (fence) {
            code = fence[1].trim();
        }
        return code || fallback;
    }

    private async resolveApiKey(): Promise<string | undefined> {
        if (this.apiKeyRetriever) {
            const apiKey = await this.apiKeyRetriever();
            if (apiKey) {
                return apiKey;
            }
        }
        return process.env[GEMINI_API_KEY_ENV];
    }

    private toValidExpression(value: unknown): ExpressionType {
        if (typeof value === "string" && VALID_EXPRESSIONS.includes(value)) {
            return value as ExpressionType;
        }
        return "CONFUSED";
    }
}
