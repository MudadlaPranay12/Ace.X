// robot-brain/src/ai/gemini.ts
import * as vscode from 'vscode';
import { Logger } from "../utils/logger";
import type { ExplanationLength } from "../learning/skillProfile";
import type { CommandLanguage } from '../commands/commandTypes';
import {
  GEMINI_API_URL,
  GEMINI_MODEL,
  GEMINI_CHAT_API_URL,
  GEMINI_TIMEOUT_MS,
  GEMINI_CHAT_TIMEOUT_MS,
  GEMINI_CODE_TIMEOUT_MS,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_CHAT_MAX_TOKENS,
} from "../config/gemini";

export type ExpressionType = "IDLE" | "THINKING" | "HAPPY" | "CONFUSED" | "HELPFUL" | "ALERT";

export interface MultiErrorAnalysisResult {
  summary: string;
  expression: ExpressionType;
  /** 'fallback' = deterministic text after a failed/blocked call, not Gemini. */
  source?: 'gemini' | 'fallback';
  fixes: {
    line: number;
    description: string;
    suggestedCode: string;
  }[];
}

export interface DiagnosticEntry {
  line: number;
  column: number;
  message: string;
  severity: string;
  code?: string;
}

export class GeminiApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GeminiApiError";
  }
}

const VALID_EXPRESSIONS: readonly ExpressionType[] = [
  "IDLE", "THINKING", "HAPPY", "CONFUSED", "HELPFUL", "ALERT"
];

/** How much the model should write, per effective verbosity (botx.verbosity). */
const LENGTH_GUIDANCE: Record<ExplanationLength, string> = {
  SHORT: "one short sentence",
  MEDIUM: "one to two sentences",
  DETAILED: "three to five sentences covering the cause and the fix",
};

/** Same guidance as prose for prompts that are not JSON-constrained. */
const LENGTH_PROSE: Record<ExplanationLength, string> = {
  SHORT: "Answer in one or two short sentences.",
  MEDIUM: "Answer in a short paragraph: the cause, the fix, and one sentence of why.",
  DETAILED: "Answer in detail: walk through the cause step by step and explain the fix thoroughly.",
};

export class GeminiAgentEngine {
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private apiErrorHandler: ((status: number) => void) | undefined;

  constructor(apiKey: string, options?: { model?: string; timeoutMs?: number }) {
    this.apiKey = apiKey;
    this.model = options?.model ?? GEMINI_MODEL;
    this.timeoutMs = options?.timeoutMs ?? GEMINI_TIMEOUT_MS;
  }

  setApiErrorHandler(handler: (status: number) => void): void {
    this.apiErrorHandler = handler;
  }

  public async analyzeMultipleErrors(
    fileName: string,
    fileContent: string,
    errors: DiagnosticEntry[],
    resolvedDependencies?: string,
    options?: { explanationLength?: ExplanationLength }
  ): Promise<MultiErrorAnalysisResult> {
    if (!this.apiKey) {
      throw new Error("Gemini API key not found");
    }

    const prompt = this.buildPrompt(fileName, fileContent, errors, resolvedDependencies, options?.explanationLength);

    try {
      const data = await this.callGemini(prompt);
      const result = this.normalizeResult(data);
      Logger.info("AI", {
        "Event": "Gemini multi-error analysis complete",
        "File": fileName,
        "Errors": String(errors.length),
        "Fixes": String(result.fixes.length),
        "Expression": result.expression
      });
      return { ...result, source: 'gemini' };
    } catch (err) {
      if (err instanceof GeminiApiError && (err.status === 401 || err.status === 429)) {
        this.apiErrorHandler?.(err.status);
      }
      const reason = err instanceof Error ? err.message : String(err);
      Logger.info("AI", {
        "Event": "Gemini multi-error analysis failed",
        "File": fileName,
        "Reason": reason
      });
      return {
        source: 'fallback',
        summary: errors.length > 0
          ? `I found an issue: ${errors[0].message}`
          : "I found some issues in your file.",
        expression: "CONFUSED",
        fixes: []
      };
    }
  }

  private buildPrompt(
    fileName: string,
    fileContent: string,
    errors: DiagnosticEntry[],
    resolvedDependencies?: string,
    explanationLength?: ExplanationLength
  ): string {
    const errorLines = errors
      .map((e, idx) => `${idx + 1}. Line ${e.line} (col ${e.column}): [${e.severity}] ${e.message}`)
      .join("\n");

    const dependenciesBlock = resolvedDependencies
      ? `Resolved Project Dependencies & Interfaces:\n${resolvedDependencies}\n`
      : "";

    // Verbosity reaches prompt construction here rather than merely being
    // stored: AUTO already resolved to a length via the learning profile.
    const lengthLine = explanationLength
      ? `Response length: ${LENGTH_GUIDANCE[explanationLength]}.`
      : "Response length: one to two sentences.";

    return `
You are Ace.X, a helpful paired-programming AI assistant inside a small desktop robot.
Analyze EVERY diagnostic listed below for the file ${fileName} in a single pass — do not only focus on the first one.

File: ${fileName}

File Context:
\`\`\`
${fileContent || "(file content unavailable)"}
\`\`\`

${dependenciesBlock}
All Diagnostics Found (${errors.length}):
${errorLines}

${lengthLine}

Respond ONLY with valid JSON in the following format:
{
  "summary": "Overview of what went wrong across all diagnostics, at the response length requested above.",
  "expression": "IDLE" | "THINKING" | "HAPPY" | "CONFUSED" | "HELPFUL" | "ALERT",
  "fixes": [
    {
      "line": <line_number>,
      "description": "Short explanation of the fix",
      "suggestedCode": "Exact correct code replacement for that block"
    }
  ]
}

Rules:
- "summary" must match the requested response length, stay friendly and beginner-focused.
- Provide one "fixes" entry per distinct diagnostic where a fix is possible. Keep "suggestedCode" as a precise replacement snippet.
- "expression" should reflect the overall state: "HAPPY" if issues are trivial/fixed, "CONFUSED" if unclear, "HELPFUL" for straightforward fixes, "ALERT" for serious problems.
- When "Resolved Project Dependencies & Interfaces" is present, use it to explain CROSS-FILE errors. A diagnostic may be caused by a mismatch between the code in ${fileName} and an imported interface or function signature in the resolved dependency files (e.g. "Error on line 12 is due to interface mismatch in types.ts").
`;
  }

  private async callGemini(prompt: string): Promise<Record<string, unknown>> {
    const url = `${GEMINI_API_URL}/${this.model}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
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

  private normalizeResult(data: Record<string, unknown>): MultiErrorAnalysisResult {
    const fixes = Array.isArray(data["fixes"]) ? data["fixes"] : [];
    const normalizedFixes = fixes
      .map((fix) => {
        const record = fix as Record<string, unknown>;
        return {
          line: Number(record["line"] ?? 0) || 0,
          description: String(record["description"] ?? ""),
          suggestedCode: String(record["suggestedCode"] ?? "")
        };
      })
      .filter((fix) => fix.line > 0 && (fix.description || fix.suggestedCode));

    return {
      summary: String(data["summary"] ?? "I found some issues worth fixing.").slice(0, 1500),
      expression: this.toValidExpression(data["expression"]),
      fixes: normalizedFixes
    };
  }

  private toValidExpression(value: unknown): ExpressionType {
    if (typeof value === "string" && (VALID_EXPRESSIONS as readonly string[]).includes(value)) {
      return value as ExpressionType;
    }
    return "CONFUSED";
  }
}

const EVE_SYSTEM_PROMPT = `You are Eve, a friendly and knowledgeable AI coding assistant embedded inside a VS Code extension called Ace.X. You live inside a small 3D robot avatar. Keep your responses concise (2-4 sentences max), helpful, and warm in tone. You can help with code questions, debugging, explanations, and general programming advice. If you don't know something, say so honestly.`;

/**
 * The system prompt plus the requested explanation length. Explicit requests
 * honour botx.verbosity (AUTO already resolved to a length through the learning
 * profile), so an explicit ask receives the level of explanation asked for.
 */
function eveSystemPrompt(verbosity?: ExplanationLength): string {
  if (!verbosity) {
    return EVE_SYSTEM_PROMPT;
  }
  return `${EVE_SYSTEM_PROMPT} ${LENGTH_PROSE[verbosity]}`;
}

/**
 * One reply from Eve, with success/failure as data rather than something a
 * caller has to infer.
 *
 * `failed` exists because the Ask Companion path drives a robot's face from it:
 * a robot that smiles while reading "Invalid API key" is worse than useless. It
 * has to be a structured field, not something reconstructed later by matching the
 * prose — string sniffing silently breaks the moment a message is reworded, and
 * the case that matters most (no API key configured) does not even share a
 * prefix shape with the others.
 *
 * Failures are still returned as readable sentences rather than thrown, because
 * every caller wants to show the user what went wrong.
 */
interface EveReply {
    /** Display text. Never prefixed with a speaker label. */
    text: string;
    /** True when `text` explains why Eve could not answer. */
    failed: boolean;
}

/**
 * The single Gemini call site. Both chat consumers go through here, so there is
 * one request shape, one timeout, and one place that knows the API's error
 * vocabulary.
 */
async function requestEve(userMessage: string, options?: { verbosity?: ExplanationLength }): Promise<EveReply> {
  const config = vscode.workspace.getConfiguration('botx');
  const apiKey = config.get<string>('geminiApiKey', '');

  if (!apiKey) {
    return {
      text: 'Eve needs an API key to respond. Set it via the "Ace.X: Set API Key" command or in Settings under botx.geminiApiKey.',
      failed: true,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, GEMINI_CHAT_TIMEOUT_MS);

  try {
    const response = await fetch(`${GEMINI_CHAT_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: eveSystemPrompt(options?.verbosity) }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: GEMINI_CHAT_MAX_TOKENS
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401) {
        return { text: 'Eve: Invalid API key. Please check your Gemini API key in Settings.', failed: true };
      }
      if (response.status === 429) {
        return { text: 'Eve: Rate limit hit — try again in a moment.', failed: true };
      }
      return { text: `Eve: API error (${response.status}). Please try again.`, failed: true };
    }

    const data = await response.json() as Record<string, unknown>;
    const candidates = data.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    const text = candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return { text: 'Eve: I received an empty response. Could you rephrase?', failed: true };
    }

    Logger.info('AI', { Event: 'Eve chat response', Input: userMessage.slice(0, 80), Output: text.slice(0, 80) });
    return { text, failed: false };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { text: 'Eve: Request timed out. Please try again.', failed: true };
    }
    const reason = err instanceof Error ? err.message : String(err);
    Logger.info('AI', { Event: 'Eve chat failed', Reason: reason });
    return { text: 'Eve: Something went wrong. Please try again.', failed: true };
  }
}

/**
 * Chat reply for display in the BotX output channel or an information message,
 * prefixed with Eve's name so the source of the text is unambiguous.
 */
export async function chatWithEve(userMessage: string): Promise<string> {
  const { text } = await requestEve(userMessage);
  return text.startsWith('Eve: ') ? text : `Eve: ${text}`;
}

/**
 * Chat reply for the Robot Body caption: no speaker prefix (the companion is
 * right there), plus the success flag the face expression is chosen from.
 */
export async function askEve(userMessage: string, options?: { verbosity?: ExplanationLength }): Promise<EveReply> {
  const reply = await requestEve(userMessage, options);
  return { text: reply.text.replace(/^Eve:\s*/, ''), failed: reply.failed };
}

export interface GeneratedCodeReply { code: string; failed: boolean; error?: string }

/** The existing Gemini provider, with a code-shaped response contract for #write. */
export async function generateCode(
  instruction: string,
  language: CommandLanguage,
  context: string,
  signal?: AbortSignal,
): Promise<GeneratedCodeReply> {
  const apiKey = vscode.workspace.getConfiguration('botx').get<string>('geminiApiKey', '');
  if (!apiKey) { return { code: '', failed: true, error: 'Eve needs a Gemini API key to generate code.' }; }
  // Honor a signal that was already aborted before we started: report the
  // user's cancellation rather than a fabricated provider failure.
  if (signal?.aborted) { return { code: '', failed: true, error: 'Code generation was cancelled.' }; }
  const prompt = `Generate only complete ${language} source code for this request. Return one Markdown code fence and no explanation outside it. Do not read secrets, execute commands, modify files, or include unrelated languages.\nRequest: ${instruction}\nEditor context:\n${context || '(none)'}`;
  const controller = new AbortController();
  // Distinct finite budget from chat: code generation is slower, and this must
  // stay below the Body's request guard so a legitimate slow response is never
  // mistaken for a dropped connection.
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, GEMINI_CODE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(`${GEMINI_CHAT_API_URL}?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: GEMINI_CHAT_MAX_TOKENS } }), signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { return { code: '', failed: true, error: 'The Gemini API key was rejected. Check it in Settings.' }; }
      if (response.status === 429) { return { code: '', failed: true, error: 'Gemini is rate limiting requests (429). Try again in a moment.' }; }
      return { code: '', failed: true, error: `Gemini API error (${response.status}).` };
    }
    clearTimeout(timeoutId);
    const data = await response.json() as Record<string, any>;
    const code = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof code !== 'string' || !code.trim()) { return { code: '', failed: true, error: 'The provider returned an empty code response.' }; }
    return { code, failed: false };
  } catch (error) {
    // Cancellation wins over timeout: a user-initiated abort must read as
    // cancelled even if the timer fired in the same tick.
    if (signal?.aborted) { return { code: '', failed: true, error: 'Code generation was cancelled.' }; }
    if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
      return { code: '', failed: true, error: `Code generation timed out after ${Math.round(GEMINI_CODE_TIMEOUT_MS / 1000)}s. Please try again.` };
    }
    return { code: '', failed: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}
