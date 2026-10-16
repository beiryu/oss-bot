#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, repoConfig } from './config.js';
import { doctor } from './doctor.js';
import { addRepo, listRepos, removeRepo } from './onboard.js';
import { refreshSnapshots, renderInbox } from './inbox.js';
import { Db } from './db.js';
import { issueDir } from './git.js';
import { expectUser } from './github.js';
import { approveClaim, approveFollowup, approvePr, runOnce, withLock, type Ctx } from './orchestrator.js';

const program = new Command('oss-bot').option('-c, --config <path>', 'config file', 'config.yaml');

function ctx(runId: string | null = null): Ctx {
  const cfg = loadConfig(program.opts().config);
  expectUser(cfg.github_user);
  return { cfg, db: new Db(), runId };
}
const days = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

program.command('run')
  .description('one pass: follow up open PRs, triage new issues, advance the pipeline')
  .option('--dry', 'work on an issue without claiming it first (approve pr still requires the claim)')
  .option('--repo <owner/name>')
  .option('--issue <number>', 'work on this issue only (needs --repo)', Number)
  .option('--triage-only', 'discover and score every waiting issue; no follow-ups, no claims, no code')
  .action(async (o) => {
    if (o.issue && !o.repo) throw new Error('--issue needs --repo');
    if (o.issue && o.triageOnly) throw new Error('--triage-only scores new issues; it does not take --issue');
    await withLock(() => runOnce(ctx(randomUUID()), { dry: !!o.dry, repo: o.repo, issue: o.issue, triageOnly: !!o.triageOnly }));
  });

program.command('inbox').description('what needs you, how open PRs are doing, what the bot is working on')
  .option('--refresh', 'ask GitHub about every open PR first (no agents, no cost)')
  .action(async (o) => {
    const c = ctx();
    if (o.refresh) await refreshSnapshots(c.db, c.cfg);
    console.log(renderInbox(c.db, c.cfg));
  });

program.command('status').description('issues, PRs and pending actions')
  .option('--all', 'also show skipped, done and closed issues')
  .action((o) => {
  const { db } = ctx();
  if (db.get('paused')) console.log('** PAUSED **');
  const repos = db.repos();
  console.table(repos.map((r) => ({ repo: r.full_name, status: r.status, policy: r.policy_status, scanned: r.last_scanned })));
  const all = db.allIssues();
  const issues = o.all ? all : all.filter((i) => !['skipped', 'done', 'closed'].includes(i.state));
  if (issues.length < all.length) console.log(`(${all.length - issues.length} skipped/done/closed issues hidden; --all shows them)`);
  // In-flight work first, then the queue by triage score: the order the bot picks issues in.
  const waiting = (i: { state: string }) => ['discovered', 'triaged'].includes(i.state);
  issues.sort((a, b) => Number(waiting(a)) - Number(waiting(b)) || (b.score ?? -1) - (a.score ?? -1));
  console.table(issues.slice(0, 30).map((i) => ({
    id: i.id, issue: `${i.repo}#${i.number}`, state: i.state, score: i.score, tries: i.attempts, dry: i.dry,
    note: (i.blocked ? `BLOCKED: ${i.blocked}` : i.skip_reason ?? i.title).slice(0, 60),
  })));
  const actions = db.pendingActions();
  if (actions.length) console.table(actions.map((a) => ({ action: a.id, issue: a.issue_id, kind: a.kind, at: a.created_at })));
});

const isAction = (id: string) => /^a\d+$/i.test(id);
const actionId = (id: string) => Number(id.slice(1));
function showAction(db: Db, id: number) {
  const a = db.action(id);
  console.log(`${a.kind} for issue ${a.issue_id} (${a.status})\n\n${a.message}`);
  if (a.patch) console.log(`\n--- full new patch${a.base_sha ? ` (on ${a.base_sha.slice(0, 10)})` : ''}\n${a.patch}`);
}

program.command('show <id>').description('an issue (triage, diff, PR draft, drafts, agent log), or a<n> for one drafted action').action((id) => {
  const { db } = ctx();
  if (isAction(id)) return showAction(db, actionId(id));
  const i = db.issue(Number(id));
  console.log(`${i.repo}#${i.number} ${i.title}\n${i.url}\nstate: ${i.state}  score: ${i.score}  attempts: ${i.attempts}`);
  if (i.blocked) console.log(`\nBLOCKED: ${i.blocked}`);
  if (i.triage_reason) console.log(`\ntriage: ${i.triage_reason}`);
  if (i.skip_reason) console.log(`\nskipped: ${i.skip_reason}`);
  if (i.summary) console.log(`\ncoder summary:\n${i.summary}`);
  if (i.feedback) console.log(`\nlast feedback to coder:\n${i.feedback}`);
  const patch = join(issueDir(i.repo, i.number), 'PATCH.diff');
  if (existsSync(patch)) console.log(`\n--- PATCH.diff\n${readFileSync(patch, 'utf8')}`);
  if (i.pr_title) console.log(`\n--- PR draft\n${i.pr_title}\n\n${i.pr_body}`);
  const pr = db.prForIssue(i.id);
  if (pr) console.log(`\n--- PR ${pr.url}  ${pr.state}  CI: ${pr.ci_state ?? '?'}  review: ${pr.review_decision ?? '?'}  mergeable: ${pr.mergeable ?? '?'}`);
  for (const a of db.pendingActions().filter((a) => a.issue_id === i.id)) {
    console.log(`\n--- drafted ${a.kind} (approve a${a.id} / reject a${a.id} / show a${a.id})\n${a.message.slice(0, 600)}`);
  }
  console.log('\n--- agent calls (newest first)');
  for (const c of db.lastCalls(i.id)) {
    console.log(`${c.started_at} ${c.agent} ok=${c.ok} $${(c.cost_usd ?? 0).toFixed(3)} ${Math.round(c.duration_ms / 1000)}s`);
    if (!c.ok) console.log(`   ${JSON.parse(c.result_json).error?.slice(0, 400)}`);
  }
});

/** `approve <id>` works out what the issue waits for; `a<n>` is a drafted reply/fix/rebase. */
async function approveAny(c: Ctx, id: string) {
  if (isAction(id)) return approveFollowup(c, actionId(id));
  const i = c.db.issue(Number(id));
  if (i.state === 'awaiting_claim') return approveClaim(c, i.id);
  if (i.state === 'awaiting_pr_approval') return approvePr(c, i.id);
  const a = c.db.pendingActionFor(i.id);
  if (a) return approveFollowup(c, a.id);
  throw new Error(`issue ${id} is ${i.state}${i.blocked ? ` (blocked: ${i.blocked})` : ''}; nothing waits for your approval. \`oss-bot inbox\` lists what does.`);
}
program.command('approve <id>').description('send what the bot prepared: the claim or PR of an issue, or a<n> for a drafted reply/fix/rebase')
  .action((id) => approveAny(ctx(), id));
program.command('reject <id> [reason...]').description('drop an issue (or a<n>: discard a drafted action)').action((id, reason) => {
  const { db } = ctx();
  if (isAction(id)) return db.setActionStatus(actionId(id), 'rejected');
  db.skip(Number(id), `rejected by human: ${(reason ?? []).join(' ') || 'no reason'}`);
});

// Older spellings, kept working but out of --help.
const approve = program.command('approve-old', { hidden: true });
approve.command('claim <id>').action((id) => approveClaim(ctx(), Number(id)));
approve.command('pr <id>').action((id) => approvePr(ctx(), Number(id)));
approve.command('followup <actionId>').action((id) => approveFollowup(ctx(), Number(id)));
program.command('show-action <id>', { hidden: true }).action((id) => showAction(ctx().db, Number(id)));
program.command('reject-action <id>', { hidden: true }).action((id) => ctx().db.setActionStatus(Number(id), 'rejected'));

program.command('pause').description('stop runs until resume').action(() => ctx().db.set('paused', '1'));
program.command('resume').action(() => ctx().db.set('paused', null));

const repo = program.command('repo').description('add, remove, list and check repositories');
repo.command('add <url>').description('fork, read the rules, draft and test the config, write repos/<owner>__<name>.yaml after you confirm')
  .option('--yes', 'accept the proposal without asking')
  .action(async (url, o) => {
    const c = ctx('onboard');
    console.log(await addRepo(c, url, { configPath: program.opts().config, yes: !!o.yes }));
  });
repo.command('remove <name>').description('delete its config, records without an open PR, and work dirs; prints the fork-delete command')
  .option('--yes', 'do not ask')
  .action(async (name, o) => console.log(await removeRepo(ctx(), name, { configPath: program.opts().config, yes: !!o.yes })));
repo.command('list').description('configured repos with their state').action(() => { const c = ctx(); console.log(listRepos(c.cfg, c.db)); });
repo.command('allow <name>', { hidden: true }).action((name) => {
  const { db, cfg } = ctx();
  const r = cfg.repos.find((x) => x.full_name === name);
  if (!r) throw new Error(`${name} is not configured`);
  db.upsertRepo(name, r.fork);
  db.setRepoPolicy(name, 'allowed');
  db.setRepoStatus(name, 'active');
});
repo.command('block <name> [reason...]', { hidden: true }).action((name, reason) => {
  const { db, cfg } = ctx();
  const r = cfg.repos.find((x) => x.full_name === name);
  db.upsertRepo(name, r?.fork ?? '');
  db.setRepoStatus(name, 'blocked', (reason ?? []).join(' ') || null);
});
repo.command('doctor <name>')
  .description('run the gate on the unpatched base; --fix lets an agent propose one that works here')
  .option('--fix', 'ask an agent for a working gate and write it to repos/<owner>__<name>.yaml after you confirm')
  .option('--yes', 'write the proposal without asking (for scripts)')
  .action(async (name, o) => {
    const c = ctx();
    console.log(await doctor(c, repoConfig(c.cfg, name), { fix: !!o.fix, yes: !!o.yes, configPath: program.opts().config }));
  });
repo.command('policy <name>', { hidden: true }).action((name) => {
  console.log(ctx().db.repo(name)?.policy_excerpts ?? '(not scanned yet; run once)');
});
program.command('cost').description('spend by agent over the last 7 and 30 days').action(() => {
  const { db } = ctx();
  for (const d of [7, 30]) {
    console.log(`\nlast ${d} days: $${db.costSince(days(d)).toFixed(2)}`);
    console.table(db.costByAgent(days(d)));
  }
});

program.parseAsync().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
