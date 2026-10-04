import type { Llm } from "../types.ts";
import { createFakeLlm } from "./fake.ts";
import { createGeminiLlm } from "./gemini.ts";

export function createLlm(env: { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; GEMINI_FALLBACK_MODELS?: string }): Llm {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return createFakeLlm();
  const fallbacks = env.GEMINI_FALLBACK_MODELS?.split(",").map((m) => m.trim()).filter(Boolean);
  return createGeminiLlm({ apiKey, model: env.GEMINI_MODEL?.trim() || undefined, fallbackModels: fallbacks?.length ? fallbacks : undefined });
}

export { createFakeLlm } from "./fake.ts";
export { createGeminiLlm } from "./gemini.ts";
