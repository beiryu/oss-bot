import type { Config } from './config.js';
import { ACTIVE_STATES, type Db } from './db.js';
import { parsePatch } from './git.js';
import { loadPatch, sendableAsDrafted, stripComments, whyOf } from './orchestrator.js';

// The inbox as one pinned issue in the private desk repo, for runs on GitHub Actions. The bot
// alone writes it; you decide by commenting /approve, /reject and the rest, and the bot answers
// each comment with what it did and the run log. Nothing is posted upstream without a command.

export const DASHBOARD_MARK = '<!-- oss-bot:dashboard -->';
export const DASHBOARD_TITLE = 'oss-bot';
/** The bot's own replies on the dashboard carry this, so they are never read back as commands. */
export const REPLY_MARK = '<!-- oss-bot:reply -->';

export type Command =
  | { cmd: 'approve'; id: string; why?: number; text?: string }
  | { cmd: 'reject'; id: string; reason: string }
  | { cmd: 'allow'; repo: string }
  | { cmd: 'block'; repo: string; reason: string }
  | { cmd: 'pause' }
  | { cmd: 'resume' };

/**
 * One command per line: `/approve 12 [--why 2]`, `/approve a5`, `/reject 12|a5 [reason…]`,
 * `/allow o/r`, `/block o/r [reason…]`, `/pause`, `/resume`. The lines after an `/approve`, up to
 * the next command, are your own text: the PR's reason, or the reply to post.
 */
export function parseCommands(comment: string): Command[] {
  const out: Command[] = [];
  let text: string[] | null = null;
  const close = () => {
    const last = out.at(-1);
    if (text && last?.cmd === 'approve' && text.join('\n').trim()) last.text = text.join('\n').trim();
    text = null;
  };
  for (const line of comment.replace(/\r\n/g, '\n').split('\n')) {
    if (!/^\s*\//.test(line)) { text?.push(line); continue; }
    close();
    let m = /^\s*\/approve\s+(a?\d+)(?:\s+--why\s+(\d+))?\s*$/i.exec(line);
    if (m) { out.push({ cmd: 'approve', id: m[1].toLowerCase(), ...(m[2] ? { why: Number(m[2]) } : {}) }); text = []; continue; }
    m = /^\s*\/reject\s+(a?\d+)\b\s*(.*)$/i.exec(line);
    if (m) { out.push({ cmd: 'reject', id: m[1].toLowerCase(), reason: m[2].trim() }); continue; }
    m = /^\s*\/allow\s+([\w.-]+\/[\w.-]+)\s*$/i.exec(line);
    if (m) { out.push({ cmd: 'allow', repo: m[1] }); continue; }
    m = /^\s*\/block\s+([\w.-]+\/[\w.-]+)\s*(.*)$/i.exec(line);
    if (m) { out.push({ cmd: 'block', repo: m[1], reason: m[2].trim() }); continue; }
    m = /^\s*\/(pause|resume)\s*$/i.exec(line);
    if (m) out.push({ cmd: m[1].toLowerCase() as 'pause' | 'resume' });
  }
  close();
  return out;
}

// Text from agents, issues and PRs is untrusted: it must not be able to write a marker the parser would read.
const safe = (s: string) => s.replace(/<!--/g, '<!- -');
const esc = (s: string) => safe(s).replace(/\r?\n/g, ' ').trim();
// Headings inside a fold would render as big as the dashboard's own; bold lines read better there.
const demote = (s: string) => s.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '**$1**');
// Inside a list item every line must be indented, or the item ends and the fold renders empty.
const details = (summary: string, body: string) => {
  const inner = body.trim().split('\n').map((l) => (l ? `  ${l}` : '')).join('\n');
  return `\n  <details><summary>${summary}</summary>\n\n${inner}\n\n  </details>\n`;
};
const quote = (s: string) => demote(safe(s)).trim().split('\n').map((l) => `> ${l}`).join('\n');
const fence = (s: string, max = 2500) => `~~~~diff\n${s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s}\n~~~~`;
const code = (s: string) => `\`${s}\``;

function diffStat(patch: string): string {
  try {
    return parsePatch(patch).map((f) => `${f.path} +${f.added} -${f.removed}`).join(', ');
  } catch {
    return '(diff not readable)';
  }
}

export interface DashboardInfo {
  runUrl?: string;
  monthCostUsd?: number;
  tokenExpiry?: string | null;
  notes?: string[];            // one-off lines for this render (a command that failed, ...)
  now?: number;
}

/** What waits for you, one block each, with the command to type. Pure apart from the patch files of old issues. */
export function needsYouBlocks(db: Db, cfg: Config): string[] {
  const out: string[] = [];
  const link = (repo: string, n: number) => `[${repo}#${n}](https://github.com/${repo}/issues/${n})`;
  for (const r of db.repos().filter((r) => r.policy_status === 'pending' && cfg.repos.some((c) => c.full_name === r.full_name))) {
    out.push(`- **repo mới** [${r.full_name}](https://github.com/${r.full_name}): đọc quy định về AI/đóng góp rồi ${code(`/allow ${r.full_name}`)} hoặc ${code(`/block ${r.full_name} lý do`)}`
      + (r.policy_excerpts ? details('Trích quy định', quote(r.policy_excerpts.slice(0, 5000))) : ''));
  }
  for (const i of db.allIssues()) {
    if (i.state === 'awaiting_claim') {
      const rc = cfg.repos.find((r) => r.full_name === i.repo);
      out.push(`- **${i.id} · claim** ${link(i.repo, i.number)} ${esc(i.title)} · score ${i.score ?? '?'}\n`
        + `  ${rc?.claim_comment ? `sẽ comment ${code(rc.claim_comment)} trên issue` : 'không đăng gì; bot bắt đầu làm'} · `
        + `${code(`/approve ${i.id}`)} · ${code(`/reject ${i.id} lý do`)}`
        + (i.triage_reason ? details('Vì sao chọn', quote(i.triage_reason)) : ''));
    }
    if (i.state === 'awaiting_pr_approval') {
      const why = whyOf(i);
      let patch = '';
      try { patch = loadPatch(i); } catch { /* an old issue whose work dir is gone */ }
      const how = why.length === 1 ? `${code(`/approve ${i.id}`)} (lý do 1)`
        : why.length ? why.map((_, k) => code(`/approve ${i.id} --why ${k + 1}`)).join(' · ')
        : `${code(`/approve ${i.id}`)} + dòng dưới là lý do bằng lời của bạn`;
      out.push(`- **${i.id} · mở PR** ${link(i.repo, i.number)} ${esc(i.pr_title ?? i.title)}\n`
        + `  ${how} · ${code(`/reject ${i.id} lý do`)}\n  ${esc(diffStat(patch))}`
        + details('Bản nháp PR', [
          `**${esc(i.pr_title ?? '')}**`, '', quote(i.pr_body ?? ''), '',
          ...why.map((w, k) => `${k + 1}. ${esc(w.en)}\n   _${esc(w.vi)}_`),
          ...(why.length ? ['', `Muốn tự viết: ${code(`/approve ${i.id}`)} rồi xuống dòng viết lý do của bạn.`] : []),
        ].join('\n'))
        + (patch ? details('Diff', fence(patch)) : ''));
    }
  }
  for (const a of db.pendingActions()) {
    const i = db.issue(a.issue_id);
    const pr = db.prForIssue(i.id);
    const target = pr ? `[${i.repo}#${pr.number}](${pr.url})` : link(i.repo, i.number);
    const what = a.kind === 'rebase' ? 'rebase (force-push lên fork)' : a.kind === 'fix' ? 'fix cho review' : 'trả lời review';
    const own = !sendableAsDrafted(a);
    const msg = stripComments(a.message).trim();
    out.push(`- **a${a.id} · ${what}** ${target}\n`
      + `  ${own ? `repo cần trả lời bằng lời của bạn: ${code(`/approve a${a.id}`)} rồi xuống dòng viết câu trả lời`
        : `${code(`/approve a${a.id}`)} (gửi đúng bản nháp) hoặc kèm câu trả lời của bạn ở dòng dưới`} · ${code(`/reject a${a.id}`)}`
      + (a.patch ? `\n  ${esc(diffStat(a.patch))}` : '')
      + (msg ? details(a.kind === 'rebase' ? 'Cách rebase' : own ? 'Agent hiểu review thế nào (không đăng)' : 'Bản nháp trả lời', quote(msg)) : '')
      + (a.patch ? details('Diff mới', fence(a.patch)) : ''));
  }
  return out;
}

/** The dashboard body. Pure: reads the state only. */
export function renderDashboard(db: Db, cfg: Config, info: DashboardInfo): string {
  const now = info.now ?? Date.now();
  const L: string[] = [
    DASHBOARD_MARK, '',
    `_Cập nhật ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC${info.runUrl ? ` · [log](${info.runUrl})` : ''}`
      + ` · $${(info.monthCostUsd ?? 0).toFixed(2)} tháng này_`, '',
  ];
  if (db.get('paused')) L.push('> ⏸ Đang tạm dừng — `/resume`', '');
  for (const n of info.notes ?? []) L.push(`> ${esc(n)}`, '');
  if (info.tokenExpiry) {
    const days = Math.round((new Date(info.tokenExpiry).getTime() - now) / 86_400_000);
    if (days <= 21) L.push(`> ⚠️ OSS_BOT_TOKEN ${days <= 0 ? 'đã hết hạn' : `hết hạn sau ${days} ngày`}`, '');
  }

  const todo = needsYouBlocks(db, cfg);
  L.push(`### Cần bạn${todo.length ? ` (${todo.length})` : ''}`, '', ...(todo.length ? todo : ['_Không có._']), '');

  const blocked = new Map<string, string>();
  for (const i of db.blockedIssues()) if (!blocked.has(i.repo)) blocked.set(i.repo, i.blocked!);
  if (blocked.size) {
    L.push('### Repo bị chặn', '');
    for (const [repo, why] of blocked) L.push(`- ${repo}: ${esc(why.slice(0, 200))} — bot tự thử lại khi main có commit mới`);
    L.push('');
  }

  const prs = db.openPrsWithIssue();
  if (prs.length) {
    L.push('### PR đang mở', '');
    for (const p of prs) {
      const ci = p.ci_state === 'success' ? '✅' : p.ci_state === 'failure' ? '❌' : p.ci_state === 'pending' ? '⏳'
        : p.ci_state === 'awaiting_approval' ? '⏸' : '·';
      const extra = [
        p.review_decision === 'APPROVED' ? 'approved' : p.review_decision === 'CHANGES_REQUESTED' ? 'changes requested' : '',
        p.mergeable === 'CONFLICTING' ? 'conflict' : p.merge_state === 'BEHIND' ? 'behind' : '',
      ].filter(Boolean).join(' · ');
      L.push(`- [${p.repo}#${p.number}](${p.url}) ${ci} ${esc(p.title)}${extra ? ` · ${extra}` : ''}`);
    }
    L.push('');
  }

  const working = db.allIssues().filter((i) => (ACTIVE_STATES as string[]).includes(i.state));
  const queued = db.allIssues().filter((i) => i.state === 'triaged').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (working.length || queued.length) {
    L.push('### Đang làm / hàng chờ', '');
    for (const i of working) L.push(`- ${i.repo}#${i.number} ${esc(i.title)} · ${i.blocked ? 'blocked' : `${i.state} (lần ${i.attempts + 1})`}`);
    for (const i of queued.slice(0, 10)) L.push(`- ${i.repo}#${i.number} ${esc(i.title)} · chờ, score ${(i.score ?? 0).toFixed(2)}`);
    if (queued.length > 10) L.push(`- … và ${queued.length - 10} issue khác`);
    L.push('');
  }
  L.push('<details><summary>Lệnh</summary>', '',
    '- `/approve 12` · `/approve 12 --why 2` · `/approve a5` — các dòng sau lệnh là lời của bạn (lý do PR, hoặc câu trả lời review)',
    '- `/reject 12 lý do` · `/reject a5`',
    '- `/allow owner/repo` · `/block owner/repo lý do` · `/pause` · `/resume`',
    '', 'Mỗi comment chạy một lượt; bot trả lời ✅/❌ kèm log.', '</details>');
  // GitHub caps an issue body at 65536 characters.
  const body = L.join('\n');
  return body.length > 65_000 ? `${body.slice(0, 64_000)}\n\n… (cắt bớt: quá giới hạn của GitHub; xem log)` : body;
}

/**
 * True when the dashboard changed in a way worth an edit: everything but the timestamp line.
 */
export function dashboardChanged(before: string, after: string): boolean {
  const strip = (s: string) => s.replace(/_Cập nhật [^\n]*_/g, '').replace(/OSS_BOT_TOKEN (đã hết hạn|hết hạn sau \d+ ngày)/g, '').trim();
  return strip(before) !== strip(after);
}
