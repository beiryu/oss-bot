import { repoConfig } from './config.js';
import type { StateJson } from './db.js';
import { DASHBOARD_MARK, DASHBOARD_TITLE, REPLY_MARK, dashboardChanged, needsYouBlocks, parseCommands, renderDashboard, type Command } from './dashboard.js';
import { ensureMirror } from './git.js';
import * as gh from './github.js';
import { holdNotifications, notify, releaseNotifications } from './notify.js';
import { approveClaim, approveFollowup, approvePr, runOnce, whyOf, type Ctx } from './orchestrator.js';

// oss-bot on GitHub Actions, from one central repo (this one) over every repos/*.yaml. One run
// is one pass in two jobs (.github/workflows/oss-bot.yml):
//   agent    the job's read-only token and the model credential: `run` up to the drafts, nothing
//            posted anywhere; hands over a state file.
//   publish  your PAT, no model credential: carries out the commands you commented on the
//            dashboard (the only way anything reaches an upstream repo), renders the dashboard,
//            sends the notifications and saves the state on the branch oss-bot/state.

export const STATE_BRANCH = 'oss-bot/state';
const STATE_FILE = 'state.json';
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// ---------------------------------------------------------------- state on a branch

export async function pullState(repo: string): Promise<{ json: StateJson | null; head: string | null }> {
  const head = await gh.refSha(repo, STATE_BRANCH);
  if (!head) return { json: null, head: null };
  return { json: JSON.parse(await gh.fileAtRef(repo, STATE_FILE, STATE_BRANCH)) as StateJson, head };
}

const sameState = (a: StateJson | null, b: StateJson) => !!a && JSON.stringify({ ...a, exported_at: '' }) === JSON.stringify({ ...b, exported_at: '' });

/** Saves the state as one commit on the state branch (created as an orphan the first time). Returns the new head, or null when nothing changed. */
export async function pushState(repo: string, json: StateJson, previous: { json: StateJson | null; head: string | null }): Promise<string | null> {
  if (sameState(previous.json, json)) return null;
  const text = `${JSON.stringify(json, null, 1)}\n`;
  const message = `state: ${json.exported_at}`;
  if (previous.head) {
    return gh.createCommitOnBranch(repo, STATE_BRANCH, previous.head, { headline: message, body: '' },
      { additions: [{ path: STATE_FILE, contents: Buffer.from(text).toString('base64') }], deletions: [] });
  }
  // An orphan branch: tree → parentless commit → ref.
  const tree = await gh.ghPost<{ sha: string }>(`repos/${repo}/git/trees`, { tree: [{ path: STATE_FILE, mode: '100644', type: 'blob', content: text }] });
  const commit = await gh.ghPost<{ sha: string }>(`repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [] });
  await gh.createRef(repo, STATE_BRANCH, commit.sha);
  return commit.sha;
}

// ---------------------------------------------------------------- agent job

export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const HELD = 'held-notifications';

/** One pass without write access: everything up to the drafts. Notifications wait in the state for the publish job. */
export async function ciAgent(ctx: Ctx, opts: { minutes: number }) {
  gh.assumeUser(ctx.cfg.github_user);
  ctx.deadline = Date.now() + opts.minutes * 60_000;
  holdNotifications();
  try {
    await runOnce(ctx, { dry: false });
  } finally {
    const held = [...JSON.parse(ctx.db.get(HELD) ?? '[]') as string[], ...releaseNotifications()];
    ctx.db.set(HELD, held.length ? JSON.stringify(held) : null);
  }
}

// ---------------------------------------------------------------- publish job

/** One readable line for a failure: a git/gh command line is noise, its exit code and stderr are not. */
export function shortError(e: unknown): string {
  const msg = (e as Error).message ?? String(e);
  const cmd = /^Command failed with exit code (\d+): (git|gh)\b.*?\b(checkout|fetch|push|apply|clone|commit|api|pr|issue)\b/.exec(msg);
  const stderr = ((e as { stderr?: string }).stderr ?? msg.split('\n').slice(1).join('\n')).trim().split('\n').filter(Boolean).pop();
  if (cmd) return `${cmd[2]} ${cmd[3]} failed (exit ${cmd[1]})${stderr ? `: ${stderr.slice(0, 160)}` : ''}`;
  return msg.split('\n')[0].slice(0, 300);
}

const label = (c: Command) => 'id' in c ? `${c.cmd} ${c.id}` : 'repo' in c ? `${c.cmd} ${c.repo}` : c.cmd;

/** Carries out one command; returns what was done, in one line, or throws with why not. */
export async function applyCommand(ctx: Ctx, c: Command): Promise<string> {
  const { cfg, db } = ctx;
  if (c.cmd === 'pause') { db.set('paused', '1'); return 'tạm dừng: không chạy agent cho tới `/resume`'; }
  if (c.cmd === 'resume') { db.set('paused', null); return 'chạy lại từ lượt sau'; }
  if (c.cmd === 'allow' || c.cmd === 'block') {
    const r = repoConfig(cfg, c.repo);
    db.upsertRepo(r.full_name, r.fork);
    if (c.cmd === 'block') { db.setRepoStatus(r.full_name, 'blocked', c.reason || null); return `${r.full_name} bị chặn`; }
    db.setRepoPolicy(r.full_name, 'allowed');
    db.setRepoStatus(r.full_name, 'active');
    return `${r.full_name} được phép; lượt sau bắt đầu triage`;
  }
  const action = c.id.startsWith('a');
  const n = Number(action ? c.id.slice(1) : c.id);
  if (c.cmd === 'reject') {
    if (action) {
      if (db.action(n).status !== 'pending') throw new Error(`a${n} is already ${db.action(n).status}`);
      db.setActionStatus(n, 'rejected');
      return `bỏ bản nháp a${n}`;
    }
    const i = db.issue(n);
    db.skip(n, `rejected by human: ${c.reason || 'no reason'}`);
    return `bỏ ${i.repo}#${i.number}`;
  }
  // approve: the push and PR steps clone from the repo's mirror, which a fresh runner lacks.
  const issue = action ? db.issue(db.action(n).issue_id) : db.issue(n);
  await ensureMirror(issue.repo, repoConfig(cfg, issue.repo).default_branch);
  const followup = (id: number) => approveFollowup(ctx, id, c.text ? { text: c.text } : { asDrafted: true });
  if (action) return followup(n);
  if (issue.state === 'awaiting_claim') return approveClaim(ctx, n);
  if (issue.state === 'awaiting_pr_approval') {
    const why = c.why ?? (!c.text && whyOf(issue).length === 1 ? 1 : undefined);
    if (why === undefined && !c.text) {
      throw new Error(`chọn một lý do (\`/approve ${n} --why N\`) hoặc viết lý do của bạn ở các dòng dưới lệnh`);
    }
    return approvePr(ctx, n, { why, text: c.text });
  }
  const a = db.pendingActionFor(n);
  if (a) return followup(a.id);
  throw new Error(`issue ${n} is ${issue.state}${issue.blocked ? ` (blocked: ${issue.blocked})` : ''}; nothing waits for your approval`);
}

export interface PublishOpts { desk: string; runUrl?: string }

/** The dashboard issue in the desk, by the number on record or by its mark; null when there is none yet. */
async function findDashboard(ctx: Ctx, desk: string): Promise<{ number: number; body: string } | null> {
  const key = `dashboard:${desk}`;
  const known = ctx.db.get(key);
  if (known) {
    const i = await gh.getIssue(desk, Number(known)).catch(() => null);
    if (i?.state === 'OPEN') return { number: i.number, body: i.body ?? '' };
  }
  const found = (await gh.findIssuesByBody(desk, 'oss-bot:dashboard')).find((i) => i.body.includes(DASHBOARD_MARK));
  if (found) { ctx.db.set(key, String(found.number)); return found; }
  return null;
}

export async function ciPublish(ctx: Ctx, opts: PublishOpts): Promise<void> {
  const { cfg, db } = ctx;
  const { desk } = opts;
  const me = (await gh.currentUser()).toLowerCase(); // the PAT's owner, checked against github_user
  const notes: string[] = [];
  const dash = await findDashboard(ctx, desk);

  // 1. Your commands, each comment handled once (by comment id) and answered with what was done.
  let decided = false;
  if (dash) {
    const doneKey = `dashboard-last-comment:${desk}`;
    const lastDone = Number(db.get(doneKey) ?? 0);
    const comments = await gh.issueComments(desk, dash.number);
    // First run on this dashboard: earlier comments are history, not orders.
    const fresh = lastDone ? comments.filter((c) => c.id > lastDone && c.author.toLowerCase() === me && !c.body.includes(REPLY_MARK)) : [];
    for (const c of fresh) {
      const cmds = parseCommands(c.body);
      if (!cmds.length) continue;
      decided = true;
      const results: string[] = [];
      for (const cmd of cmds) {
        try { results.push(`✅ ${label(cmd)}: ${await applyCommand(ctx, cmd)}`); }
        catch (e) { results.push(`❌ ${label(cmd)}: ${shortError(e)}`); }
      }
      for (const r of results) log(r);
      await gh.commentOnIssue(desk, dash.number, `${REPLY_MARK}\n${results.join('\n')}${opts.runUrl ? `\n\n[log](${opts.runUrl})` : ''}`)
        .catch((e) => log(`reply failed: ${(e as Error).message}`));
    }
    db.set(doneKey, String(Math.max(lastDone, comments.at(-1)?.id ?? 0, 1)));
  }

  // 2. The dashboard.
  const body = renderDashboard(db, cfg, {
    runUrl: opts.runUrl, notes, monthCostUsd: db.costSince(monthStart()), tokenExpiry: await gh.tokenExpiry(),
  });
  let number = dash?.number;
  if (!dash) {
    const created = await gh.createIssue(desk, { title: DASHBOARD_TITLE, body });
    number = created.number;
    db.set(`dashboard:${desk}`, String(created.number));
    db.set(`dashboard-last-comment:${desk}`, '1');
    await gh.pinIssue(desk, created.number).catch(() => undefined);
    log(`dashboard #${created.number} created`);
  } else if (decided || dashboardChanged(dash.body, body)) {
    await gh.editIssueBody(desk, dash.number, body);
    log(`dashboard #${dash.number} updated`);
  }

  // 3. Notifications: what the agent job held back, and a nudge when the list of decisions changed.
  const url = `https://github.com/${desk}/issues/${number}`;
  const held: string[] = JSON.parse(db.get('held-notifications') ?? '[]');
  const todo = needsYouBlocks(db, cfg);
  const todoKey = todo.map((t) => t.split('\n')[0]).join('\n');
  const changed = todoKey !== (db.get('notified-dashboard') ?? '');
  db.set('notified-dashboard', todoKey || null);
  if (held.length || (todo.length && changed)) {
    const nudge = todo.length ? `${todo.length} việc cần bạn: ${url}` : `Dashboard: ${url}`;
    await notify(cfg, [...held.map((h) => h.split('\n')[0].slice(0, 300)), nudge].join('\n• '));
  }
  db.set('held-notifications', null);
}
