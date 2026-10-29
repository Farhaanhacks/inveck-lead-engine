import { log } from './log';

const recent = new Map<string, number>();
const QUIET_MS = 10 * 60_000;

/**
 * Sends a short plain-text alert to ALERT_WEBHOOK_URL (a Slack or Discord incoming webhook) when one is configured.
 * Best effort: it never throws, never blocks the work it reports on, and repeats of the same alert within ten minutes are dropped.
 * Alerts carry a title and a reason only, never credentials or article text.
 */
export async function sendAlert(alert: { key: string; title: string; detail?: string }): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const now = Date.now();
  if ((recent.get(alert.key) ?? 0) > now - QUIET_MS) return;
  recent.set(alert.key, now);
  const link = process.env.APP_URL ? `\n${process.env.APP_URL.replace(/\/$/, '')}/studio` : '';
  const text = `Inveck blog: ${alert.title}${alert.detail ? `\n${alert.detail.slice(0, 400)}` : ''}${link}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(5000) });
    if (!res.ok) log('warn', 'alert.rejected', { status: res.status });
  } catch (e) {
    log('warn', 'alert.failed', { message: e instanceof Error ? e.message : String(e) });
  }
}

export function resetAlertMemory() {
  recent.clear();
}
