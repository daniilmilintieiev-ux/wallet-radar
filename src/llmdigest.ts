import { Anomaly } from "./types.js";
import { digestAnomalies } from "./digest.js";

/**
 * Optional LLM digest: one chat-completion call per anomaly batch, with a
 * deterministic template fallback. Provider-agnostic — any OpenAI-compatible
 * /chat/completions endpoint (OpenAI, OpenRouter, Groq, local llama.cpp...).
 * Best-effort: a missing key or a failed call never breaks the watch loop.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Extra request fields (e.g. Ollama "options": {"num_thread": 8}). */
  options?: Record<string, unknown>;
  /** Path appended to baseUrl (default "chat/completions"; Ollama native: "chat"). */
  path?: string;
}

/** Read the LLM config from the environment; null when no key is set. */
export function llmConfigFromEnv(): LlmConfig | null {
  const apiKey = process.env.RADAR_LLM_KEY;
  if (!apiKey) return null;
  let options: Record<string, unknown> | undefined;
  const rawOptions = process.env.RADAR_LLM_OPTIONS;
  if (rawOptions) {
    try {
      options = JSON.parse(rawOptions) as Record<string, unknown>;
    } catch {
      options = undefined;
    }
  }
  let path: string | undefined;
  const rawPath = process.env.RADAR_LLM_PATH;
  if (rawPath && rawPath.trim()) path = rawPath.trim();
  return {
    baseUrl: process.env.RADAR_LLM_BASE ?? "https://api.openai.com/v1",
    apiKey,
    model: process.env.RADAR_LLM_MODEL ?? "gpt-4o-mini",
    timeoutMs: timeoutMsFromEnv(),
    options,
    path,
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

function timeoutMsFromEnv(): number {
  const raw = process.env.RADAR_LLM_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Deterministic prompt — same input, same request, easy to test. */
export function buildPrompt(wallet: string, riskScore: number, anomalies: Anomaly[]): string {
  const lines = anomalies.map(
    (a) => `- [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`,
  );
  return [
    `Wallet: ${wallet}`,
    `Risk score: ${riskScore}/100`,
    "Anomalies:",
    ...lines,
  ].join("\n");
}

const SYSTEM_PROMPT =
  "You are a Solana wallet risk analyst. Summarize the detected wallet anomalies " +
  "in 1-2 short plain-English sentences for a busy trader. No markdown, no bullet " +
  "lists, no preamble. Name the most important signals and what to watch next.";

/**
 * Call the chat-completions endpoint. Returns the digest text, or null on any
 * failure (bad status, network error, timeout, empty content).
 */
export async function llmDigest(
  wallet: string,
  riskScore: number,
  anomalies: Anomaly[],
  cfg: LlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15_000);
    const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/${cfg.path ?? "chat/completions"}`;
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        max_tokens: 500,
        stream: false,
        ...(cfg.options ? { options: cfg.options } : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "/no_think\n" + buildPrompt(wallet, riskScore, anomalies) },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      message?: { content?: string };
    };
    const text =
      data.choices?.[0]?.message?.content?.trim() ?? data.message?.content?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

export interface DigestResult {
  digest: string;
  source: "llm" | "template";
}

/** LLM digest when configured and reachable, template otherwise. Never throws. */
export async function bestEffortDigest(
  wallet: string,
  riskScore: number,
  anomalies: Anomaly[],
  cfg: LlmConfig | null,
  fetchImpl?: typeof fetch,
): Promise<DigestResult> {
  const template = digestAnomalies(anomalies);
  if (!cfg) return { digest: template, source: "template" };
  const text = await llmDigest(wallet, riskScore, anomalies, cfg, fetchImpl);
  return text ? { digest: text, source: "llm" } : { digest: template, source: "template" };
}
