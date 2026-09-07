import { Anomaly } from "./types.js";

/** A place where alert messages can be delivered. */
export interface AlertSink {
  send(text: string): Promise<void>;
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
export class TelegramSink implements AlertSink {
  constructor(
    private token: string,
    private chatId: string,
  ) {}

  async send(text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`telegram alert failed: ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`telegram alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Pick a sink from the environment: TG when both vars are set, console otherwise. */
export function makeSink(): AlertSink {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (token && chatId) return new TelegramSink(token, chatId);
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
