#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { adoptPrs } from './adopt.js';
import { ciAgent, ciPublish, pullState, pushState } from './ci.js';
import { loadConfig, repoConfig } from './config.js';
import { doctor } from './doctor.js';
import { addRepo, listRepos, removeRepo } from './onboard.js';
import { refreshSnapshots, renderInbox } from './inbox.js';
import { Db } from './db.js';
import { issueDir } from './git.js';
import { expectUser } from './github.js';
import { approveClaim, approveFollowup, approvePr, loadPatch, runOnce, withLock, type Ctx } from './orchestrator.js';

const program = new Command('oss-bot')
  .option('-c, --config <path>', 'config file', 'config.yaml')
  .option('--state <file>', 'keep state in this JSON file instead of data/state.db (loaded at start, saved at exit)');

let stateFileDb: Db | undefined;
/** The state file's database: in memory, filled from the file if it exists, written back when the process ends. */
function stateDb(file: string): Db {
  if (stateFileDb) return stateFileDb;
  const db = stateFileDb = new Db(':memory:');
  if (existsSync(file)) db.importJson(JSON.parse(readFileSync(file, 'utf8')));
  // 'exit' fires after process.exit() too, so a run that failed still keeps what it got done.
  process.on('exit', () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(db.exportJson(), null, 1)}\n`);
  });
  return db;
}

function ctx(runId: string | null = null): Ctx {
  const cfg = loadConfig(program.opts().config);
  expectUser(cfg.github_user);
  const state = program.opts().state as string | undefined;
  return { cfg, db: state ? stateDb(state) : new Db(), runId };
}
const days = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

program.command('run')
  .description('one pass: follow up open PRs, triage new issues, advance the pipeline')
  .option('--dry', 'work on an issue without claiming it first (approve pr still requires the claim)')
  .option('--repo <owner/name>')
  .option('--issue <number>', 'work on this issue only (needs --repo)', Number)
  .option('--triage-only', 'discover and score every waiting issue; no follow-ups, no claims, no code')
  .option('--followup-only', 'only follow up open PRs (reviews, CI, conflicts, merges); no triage, no new work')
  .action(async (o) => {
    if (o.issue && !o.repo) throw new Error('--issue needs --repo');
    if (o.issue && o.triageOnly) throw new Error('--triage-only scores new issues; it does not take --issue');
    if (o.followupOnly && (o.triageOnly || o.issue)) throw new Error('--followup-only takes neither --triage-only nor --issue');
    await withLock(() => runOnce(ctx(randomUUID()), {
      dry: !!o.dry, repo: o.repo, issue: o.issue, triageOnly: !!o.triageOnly, followupOnly: !!o.followupOnly,
    }));
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
  if (i.patch || existsSync(join(issueDir(i.repo, i.number), 'PATCH.diff'))) console.log(`\n--- patch\n${loadPatch(i)}`);
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
async function approveAny(c: Ctx, id: string): Promise<string> {
  if (isAction(id)) return approveFollowup(c, actionId(id));
  const i = c.db.issue(Number(id));
  if (i.state === 'awaiting_claim') return approveClaim(c, i.id);
  if (i.state === 'awaiting_pr_approval') return approvePr(c, i.id);
  const a = c.db.pendingActionFor(i.id);
  if (a) return approveFollowup(c, a.id);
  throw new Error(`issue ${id} is ${i.state}${i.blocked ? ` (blocked: ${i.blocked})` : ''}; nothing waits for your approval. \`oss-bot inbox\` lists what does.`);
}
program.command('approve <id>').description('send what the bot prepared: the claim or PR of an issue, or a<n> for a drafted reply/fix/rebase')
  .action(async (id) => console.log(await approveAny(ctx(), id)));
program.command('reject <id> [reason...]').description('drop an issue (or a<n>: discard a drafted action)').action((id, reason) => {
  const { db } = ctx();
  if (isAction(id)) return db.setActionStatus(actionId(id), 'rejected');
  db.skip(Number(id), `rejected by human: ${(reason ?? []).join(' ') || 'no reason'}`);
});

// Older spellings, kept working but out of --help.
const approve = program.command('approve-old', { hidden: true });
approve.command('claim <id>').action(async (id) => console.log(await approveClaim(ctx(), Number(id))));
approve.command('pr <id>').action(async (id) => console.log(await approvePr(ctx(), Number(id))));
approve.command('followup <actionId>').action(async (id) => console.log(await approveFollowup(ctx(), Number(id))));
program.command('show-action <id>', { hidden: true }).action((id) => showAction(ctx().db, Number(id)));
program.command('reject-action <id>', { hidden: true }).action((id) => ctx().db.setActionStatus(Number(id), 'rejected'));

program.command('pr').command('adopt [urls...]')
  .description('track PRs you opened earlier (by hand or before this state.db): all untracked ones in the configured repos, or the given URLs')
  .action(async (urls) => withLock(async () => { for (const l of await adoptPrs(ctx(), urls ?? [])) console.log(l); }));

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
const state = program.command('state').description('move state between data/state.db and a JSON file');
state.command('export <file>').description('write data/state.db as JSON (what --state and the Actions runs use)').action((file) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(new Db().exportJson(), null, 1)}\n`);
  console.log(`wrote ${file}`);
});
state.command('import <file>').description('replace data/state.db with the JSON file').action((file) => {
  new Db().importJson(JSON.parse(readFileSync(file, 'utf8')));
  console.log(`data/state.db now holds ${file}`);
});

// GitHub Actions (.github/workflows/oss-bot.yml). All of these need --state <file>.
const ci = program.command('ci').description('the steps of a run on GitHub Actions');
const stateFile = () => {
  const f = program.opts().state as string | undefined;
  if (!f) throw new Error('ci commands need --state <file>');
  return f;
};
ci.command('state-pull').description('write the state branch\'s state.json to --state (none yet: an empty state)')
  .requiredOption('--repo <owner/name>', 'the repo holding the state branch')
  .action(async (o) => {
    const { json } = await pullState(o.repo);
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    if (json) writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`);
    console.log(json ? `state from ${json.exported_at}` : 'no state branch yet: starting empty');
  });
ci.command('state-push').description('save --state as a commit on the state branch (to seed it from `state export`)')
  .requiredOption('--repo <owner/name>', 'the repo holding the state branch')
  .action(async (o) => {
    const file = stateFile();
    expectUser(loadConfig(program.opts().config).github_user); // pushed as you, whichever gh account is active
    const head = await pushState(o.repo, JSON.parse(readFileSync(file, 'utf8')), await pullState(o.repo));
    console.log(head ? `state saved: ${head.slice(0, 10)}` : 'state unchanged');
  });
ci.command('agent').description('one pass with the read-only token: everything up to the drafts')
  .option('--minutes <n>', 'start no new step after this long (the job timeout must leave room for one)', Number, 150)
  .action(async (o) => { stateFile(); await ciAgent(ctx(randomUUID()), { minutes: o.minutes }); });
ci.command('publish').description('carry out your dashboard commands, render the dashboard, notify, save the state')
  .requiredOption('--repo <owner/name>', 'the repo holding the state branch')
  .requiredOption('--desk <owner/name>', 'the repo with the dashboard issue')
  .option('--run-url <url>')
  .action(async (o) => {
    stateFile();
    const c = ctx(randomUUID());
    const previous = await pullState(o.repo);
    try {
      await ciPublish(c, { desk: o.desk, runUrl: o.runUrl, deskToken: process.env.DESK_TOKEN || undefined });
    } finally {
      // Agent output is kept for `show`; the Actions log has the rest, so a head is enough.
      const head = await pushState(o.repo, c.db.exportJson({ resultChars: 4000 }), previous);
      console.log(head ? `state saved: ${head.slice(0, 10)}` : 'state unchanged');
    }
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
