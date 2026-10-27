import type { Config } from './config.js';

let held: string[] | null = null;
/**
 * From now on notify() only collects its messages (returned by release()): the Actions agent
 * job has no notification credentials, so it hands them over to the publish job in the state.
 */
export function holdNotifications() { held = []; }
export function releaseNotifications(): string[] { const out = held ?? []; held = null; return out; }

/** Sends to Telegram/Slack when configured; always logs locally too. */
export async function notify(cfg: Config, text: string) {
  console.log(`[notify] ${text}`);
  if (held) { held.push(text); return; }
  const tasks: Promise<unknown>[] = [];
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  // From the environment on Actions, where the config file is public.
  const chat = cfg.notify.telegram_chat_id ?? process.env.TELEGRAM_CHAT_ID;
  if (tgToken && chat) {
    tasks.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    }));
  }
  const slack = cfg.notify.slack_webhook_env && process.env[cfg.notify.slack_webhook_env];
  if (slack) {
    tasks.push(fetch(slack, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') console.error(`[notify] failed: ${r.reason}`);
}
