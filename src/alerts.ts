import { Anomaly } from "./types.js";

/** A place where alert messages can be delivered. */
export interface AlertSink {
  send(text: string, payload?: AlertPayload): Promise<void>;
}

export interface AlertPayload {
  wallet: string;
  risk: number;
  anomalies: Anomaly[];
}

/** Prints alerts to stdout. Always works, no config needed. */
export class ConsoleSink implements AlertSink {
  async send(text: string): Promise<void> {
    console.log(text);
  }
}

/**
 * Telegram bot alerts. Best-effort: a failed send is logged to stderr and
 * swallowed — alerting must never break the watch loop.
 */
const ALERT_FETCH_TIMEOUT_MS = 10_000;

export class TelegramSink implements AlertSink {
  constructor(
    private token: string,
    private chatId: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`telegram alert failed: ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`telegram alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Webhook alerts. Best-effort: a failed send is logged to stderr and
 * swallowed — alerting must never break the watch loop.
 * Posts compact JSON {wallet, risk, anomalies:[]}.
 */
export class WebhookSink implements AlertSink {
  constructor(
    private url: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: string, payload?: AlertPayload): Promise<void> {
    try {
      const body = payload
        ? { wallet: payload.wallet, risk: payload.risk, anomalies: payload.anomalies }
        : { text };
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`webhook alert failed: ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`webhook alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Broadcasts alerts to multiple sinks in parallel. */
export class MultiSink implements AlertSink {
  constructor(private sinks: AlertSink[]) {}

  async send(text: string, payload?: AlertPayload): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.send(text, payload)));
  }
}

/** Pick a sink from the environment: TG, webhook, or console fallback. */
export function makeSink(fetchImpl: typeof fetch = fetch): AlertSink {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  const webhookUrl = process.env.WEBHOOK_URL;

  const sinks: AlertSink[] = [];
  if (token && chatId) sinks.push(new TelegramSink(token, chatId, fetchImpl));
  if (webhookUrl) sinks.push(new WebhookSink(webhookUrl, fetchImpl));

  if (sinks.length === 1) return sinks[0];
  if (sinks.length > 1) return new MultiSink(sinks);
  return new ConsoleSink();
}

/** One compact, human/agent-readable message for a batch of anomalies. */
export function formatAlert(
  wallet: string,
  riskScore: number,
  anomalies: Anomaly[],
  digest?: string,
): string {
  const head = `wallet-radar: ${wallet} — risk ${riskScore}/100, ${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"}`;
  const body = anomalies
    .map((a) => `- [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`)
    .join("\n");
  const digestLine = digest ? `\n${digest}` : "";
  return `${head}\n${body}${digestLine}`;
}
