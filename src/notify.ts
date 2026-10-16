import type { Config } from './config.js';

/** Sends to Telegram/Slack when configured; always logs locally too. */
export async function notify(cfg: Config, text: string) {
  console.log(`[notify] ${text}`);
  const tasks: Promise<unknown>[] = [];
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken && cfg.notify.telegram_chat_id) {
    tasks.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.notify.telegram_chat_id, text: text.slice(0, 4000), disable_web_page_preview: true }),
    }));
  }
  const slack = cfg.notify.slack_webhook_env && process.env[cfg.notify.slack_webhook_env];
  if (slack) {
    tasks.push(fetch(slack, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') console.error(`[notify] failed: ${r.reason}`);
}
