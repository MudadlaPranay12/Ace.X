/**
 * Centralized Gemini model configuration.
 * Single source of truth for the model name used across all AI engines.
 */
export const GEMINI_MODEL = "gemini-3.8-flash";

export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_CHAT_API_URL = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent`;
export const GEMINI_GENERATE_API_URL = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent`;

export const GEMINI_TIMEOUT_MS = 15000;
export const GEMINI_CHAT_TIMEOUT_MS = 60000;
// Code generation legitimately takes longer than a chat turn (larger output,
// reasoning over editor context). It gets its own finite budget, kept well
// below the Robot Body's request guard (see robot-body/renderer.js) so the
// guard can never expire first and surface a misleading "No response
// received" while the Brain is still legitimately working.
export const GEMINI_CODE_TIMEOUT_MS = 60000;
export const GEMINI_MAX_OUTPUT_TOKENS = 2048;
export const GEMINI_CHAT_MAX_TOKENS = 1024;