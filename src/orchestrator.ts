import { spawnSync } from 'node:child_process';
import { execa } from 'execa';
import { appendFileSync, closeSync, existsSync, openSync, readSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentError, fillTemplate, runAgent, safeTestVars } from './agent.js';
import { type Config, repoConfig, type RepoConfig } from './config.js';
import type { Db, Issue, PendingAction, Pr } from './db.js';
import { housekeeping } from './housekeeping.js';
import { cmd, needsYou } from './inbox.js';
import { runGate, hashTestFiles, focusedTestCommand, repairPathVars, staticChecks } from './gate.js';
import {
  agentDir, AGENT_META, applyPatch, ensureMirror, freshClone, git, issueDir, mirrorDir, parsePatch,
  prepareAgentWorkdir, readAgentFile,
} from './git.js';
import * as gh from './github.js';
import { notify } from './notify.js';
import { aiPolicyExcerpts, formatExcerpts } from './policy.js';
import { runInSandbox, tail } from './sandbox.js';

export interface Ctx { cfg: Config; db: Db; runId: string | null }

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const NOT_FEASIBLE = 'triage: not feasible';
const OWN_REPLY = '<!-- oss-bot: your reply goes above this line -->';
const OWN_WORDS = '<!-- oss-bot: replace this line with why you are making this change, in your own words -->';
const PICK_WHY = '<!-- oss-bot: keep ONE reason below and delete the other, or write your own. Comment lines like this one are removed before posting. -->';
type Why = { en: string; vi: string };

/** Keeps untrusted text from closing the tag it is wrapped in inside a prompt. */
const untrusted = (s: string) => s.replace(/<\/?untrusted/gi, '&lt;untrusted').slice(0, 20_000);

// ---------------------------------------------------------------- run lock & budget

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync('data', { recursive: true });
  const lock = 'data/run.lock';
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive) throw new Error(`another run is in progress (pid ${pid})`);
  }
  writeFileSync(lock, String(process.pid));
  return fn().finally(() => rmSync(lock, { force: true }));
}

// ---------------------------------------------------------------- main loop

export async function runOnce(ctx: Ctx, opts: { dry: boolean; repo?: string; issue?: number; triageOnly?: boolean }) {
  const { cfg, db } = ctx;
  if (db.get('paused')) return log('paused; `oss-bot resume` to continue');
  // Without the model credential every agent call would fail and skip its issue.
  if (!process.env[cfg.sandbox.auth_env]) {
    throw new Error(`${cfg.sandbox.auth_env} is not set; run \`source .env\` in this terminal first`);
  }
  // Docker's disk image grows on the host; running out corrupts every container's storage.
  mkdirSync('work', { recursive: true });
  const fs = statfsSync('work');
  const freeGb = (fs.bavail * fs.bsize) / 2 ** 30;
  if (freeGb < cfg.limits.min_free_disk_gb) {
    throw new Error(`only ${freeGb.toFixed(1)} GB free on disk (need ${cfg.limits.min_free_disk_gb}); free some space first`);
  }

  const events: string[] = [];
  const heads = new Map<string, string>();

  for (const rc of cfg.repos) {
    if (opts.repo && rc.full_name !== opts.repo) continue;
    db.upsertRepo(rc.full_name, rc.fork);
    const repo = db.repo(rc.full_name)!;
    if (repo.status !== 'active') continue;
    log(`${rc.full_name}: refreshing mirror`);
    heads.set(rc.full_name, await ensureMirror(rc.full_name, rc.default_branch));
    if (repo.policy_status === null) {
      const ex = formatExcerpts(aiPolicyExcerpts(mirrorDir(rc.full_name)));
      db.setRepoPolicy(rc.full_name, 'pending', ex);
      await notify(cfg, `oss-bot: new repo ${rc.full_name}. Read its AI/contribution rules, then run `
        + `\`oss-bot repo allow ${rc.full_name}\` or \`oss-bot repo block ${rc.full_name}\`.\n\n${ex.slice(0, 3000)}`);
    }
  }
  const allowed = (r: string) => db.repo(r)?.status === 'active' && db.repo(r)?.policy_status === 'allowed' && heads.has(r);

  // 1. Follow-up on open PRs first.
  for (const pr of opts.triageOnly ? [] : db.openPrs()) {
    if (!allowed(pr.repo)) continue;
    try {
      const e = await followUp(ctx, pr.issue_id);
      if (e) events.push(e);
    } catch (e) {
      events.push(`follow-up on ${pr.url} failed: ${(e as Error).message}`);
    }
  }

  // 2. Find work: a specific issue, or discover and triage.
  if (opts.issue && opts.repo) {
    if (!allowed(opts.repo)) throw new Error(`${opts.repo} is not allowed yet (oss-bot repo allow ${opts.repo})`);
    const e = await targetIssue(ctx, repoConfig(cfg, opts.repo), opts.issue, opts.dry);
    if (e) events.push(e);
  } else {
    for (const rc of cfg.repos) {
      if (!allowed(rc.full_name) || (opts.repo && rc.full_name !== opts.repo)) continue;
      // Scoring alone takes no slot, so --triage-only ignores the open-PR and in-flight limits.
      if (!opts.triageOnly && db.openPrCount(rc.full_name) >= cfg.limits.max_open_prs_per_repo) continue;
      if (!opts.triageOnly && db.inFlightCount(rc.full_name) > 0) continue;
      try {
        const e = await discoverAndTriage(ctx, rc, !!opts.triageOnly);
        if (e) events.push(e);
      } catch (e) {
        events.push(`${rc.full_name}: discovery failed: ${(e as Error).message}`);
      }
    }
  }

  // 3. Advance in-progress issues.
  const candidates = opts.triageOnly ? [] : opts.issue && opts.repo
    ? [db.issueByNumber(opts.repo, opts.issue)].filter((i): i is Issue => !!i)
    : db.nextIssues(opts.repo);
  for (const issue of candidates) {
    if (!allowed(issue.repo)) continue;
    try {
      const e = await advance(ctx, issue.id);
      if (e) events.push(e);
    } catch (e) {
      db.skip(issue.id, `error: ${(e as Error).message}`);
      events.push(`#${issue.number} skipped after error: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  await housekeeping(cfg, db, log);
  const cost = ctx.runId ? db.costForRun(ctx.runId) : 0;
  const summary = [`oss-bot run finished ($${cost.toFixed(2)})`, ...events].join('\n• ');
  const todo = needsYou(db, cfg);
  if (events.length || todo.length) await notify(cfg, todo.length ? `${summary}\n\nCần bạn:\n${todo.join('\n')}` : summary);
  else log(summary);
}

// ---------------------------------------------------------------- discovery & triage

/**
 * Cheap ordering before spending triage credits: bug reports first, feature requests and
 * questions last. Triage still decides; this only picks which issues it sees first.
 */
export function triagePriority(issue: { title: string }): number {
  const t = issue.title.toLowerCase();
  if (/^\s*(\[?(feature|feat|enhancement|question|docs?|documentation)\b|feat\()/.test(t)) return 0;
  if (/\b(bug|fix|fails?|failing|crash|panic|hangs?|error|wrong|incorrect|silently|drops?|leaks?|broken|regression)\b/.test(t)) return 2;
  return 1;
}

async function discoverAndTriage(ctx: Ctx, rc: RepoConfig, triageOnly = false): Promise<string | null> {
  const { cfg, db } = ctx;

  // Already-triaged issues waiting for a free slot come first; re-check that they are still free.
  for (const t of triageOnly ? [] : db.issuesInState('triaged', rc.full_name).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const gi = await gh.getIssue(rc.full_name, t.number);
    const why = await unavailable(rc, gi);
    if (why) { db.skip(t.id, why); continue; }
    return promote(ctx, rc, t);
  }

  const issues = await gh.listOpenIssues(rc.full_name, rc.labels);
  db.markScanned(rc.full_name);
  const fresh: Issue[] = [];
  const passed: Record<string, number> = {};
  for (const gi of issues) {
    if (db.issueByNumber(rc.full_name, gi.number)) { passed['already seen'] = (passed['already seen'] ?? 0) + 1; continue; }
    const why = await unavailable(rc, gi);
    if (why) { passed[why] = (passed[why] ?? 0) + 1; continue; } // not recorded: it may become available later
    db.insertDiscovered({ repo: rc.full_name, number: gi.number, title: gi.title, body: gi.body ?? '', url: gi.url });
    fresh.push(db.issueByNumber(rc.full_name, gi.number)!);
  }
  log(`${rc.full_name}: ${issues.length} open issues, ${fresh.length} new candidates` +
    (Object.keys(passed).length ? ` (passed over: ${Object.entries(passed).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''));

  let best: Issue | null = null;
  const scored: Issue[] = [];
  for (const issue of [...fresh, ...db.issuesInState('discovered', rc.full_name)]
    .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i)
    .sort((a, b) => triagePriority(b) - triagePriority(a) || b.number - a.number)
    .slice(0, triageOnly ? undefined : cfg.limits.max_triage_per_run)) { // --triage-only scores the whole queue
    // Leftovers from earlier runs may have been taken, closed or aged out since.
    if (!fresh.includes(issue)) {
      const why = await unavailable(rc, await gh.getIssue(rc.full_name, issue.number));
      if (why) { db.skip(issue.id, why); continue; }
    }
    const t = await triage(ctx, rc, issue);
    scored.push(t);
    if (t.state === 'triaged' && (!best || (t.score ?? 0) > (best.score ?? 0))) best = t;
  }
  if (triageOnly) {
    if (!scored.length) return `${rc.full_name}: nothing new to triage`;
    return `${rc.full_name}: triaged ${scored.length}:\n` + scored
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((t) => `  ${t.state === 'triaged' ? '      ' : '[no]  '}${(t.score ?? 0).toFixed(2)} #${t.number} (id ${t.id}) ${t.title.slice(0, 70)}`)
      .join('\n');
  }
  return best ? promote(ctx, rc, best) : null;
}

/** Reason an issue is not available to work on, or null. Cheap checks before any LLM call. */
async function unavailable(rc: RepoConfig, gi: gh.GhIssue & { state?: string }): Promise<string | null> {
  if (gi.state && gi.state !== 'OPEN') return 'issue closed';
  const names = gi.labels.map((l) => l.name);
  if (rc.labels.length && !rc.labels.some((l) => names.includes(l))) return 'no wanted label';
  const skip = rc.skip_labels.find((l) => names.includes(l));
  if (skip) return `label "${skip}"`;
  const me = await gh.currentUser();
  if (gi.assignees.some((a) => a.login !== me)) return 'assigned to someone else';
  if (gi.createdAt < daysAgo(rc.max_issue_age_days)) return 'too old';
  if (await gh.linkedOpenPrCount(rc.full_name, gi.number) > 0) return 'has an open linked PR';
  return null;
}

async function triage(ctx: Ctx, rc: RepoConfig, issue: Issue): Promise<Issue> {
  const { db } = ctx;
  log(`#${issue.number}: triage`);
  try {
    const r = await runAgent(ctx, {
      agent: 'triage', issueId: issue.id, workdir: mirrorDir(rc.full_name), readOnly: true,
      vars: {
        ...issueVars(rc, issue),
      },
    });
    // The score only orders the queue; an issue is dropped only when the agent finds it
    // cannot be done here at all (out of scope, needs real infrastructure, no unit test).
    if (!r.feasible) {
      db.update(issue.id, { score: r.score, triage_reason: r.reason });
      return db.skip(issue.id, `${NOT_FEASIBLE}: ${r.reason}`);
    }
    return db.transition(issue.id, 'triaged', { score: r.score, triage_reason: r.reason });
  } catch (e) {
    if (e instanceof AgentError) return db.skip(issue.id, (e as Error).message);
    throw e;
  }
}

/** Takes the repo's pipeline slot: wait for the human to approve the claim, or go straight on. */
async function promote(ctx: Ctx, rc: RepoConfig, issue: Issue): Promise<string | null> {
  if (rc.claim_comment) {
    ctx.db.transition(issue.id, 'awaiting_claim');
    const msg = `oss-bot: ${rc.full_name}#${issue.number} "${issue.title}" scored ${issue.score?.toFixed(2)}.\n`
      + `${issue.triage_reason}\n${issue.url}\nClaim it with \`oss-bot approve ${issue.id}\` `
      + `(posts "${rc.claim_comment}") or \`oss-bot reject ${issue.id}\`.`;
    await notify(ctx.cfg, msg);
    return `#${issue.number} waiting for claim approval`;
  }
  ctx.db.transition(issue.id, 'claimed');
  // What happens to it next (PR ready, skipped) is reported on its own; this alone is noise.
  log(`#${issue.number}: picked`);
  return null;
}

/** `run --issue N`: put one issue into the pipeline, skipping discovery. */
async function targetIssue(ctx: Ctx, rc: RepoConfig, number: number, dry: boolean): Promise<string | null> {
  const { db } = ctx;
  let issue = db.issueByNumber(rc.full_name, number);
  if (!issue) {
    const gi = await gh.getIssue(rc.full_name, number);
    const why = await unavailable(rc, gi);
    if (why) return `#${number}: not available (${why})`;
    db.insertDiscovered({ repo: rc.full_name, number, title: gi.title, body: gi.body ?? '', url: gi.url });
    issue = db.issueByNumber(rc.full_name, number)!;
  }
  if (issue.state === 'discovered') issue = await triage(ctx, rc, issue);
  // You picked this issue yourself: earlier verdicts inform, they do not decide.
  if (issue.state === 'skipped') {
    const why = await unavailable(rc, await gh.getIssue(rc.full_name, number));
    if (why) return `#${number}: not available (${why})`;
    log(`#${number}: working on it as asked (skipped earlier: ${issue.skip_reason?.slice(0, 160)})`);
    issue = db.transition(issue.id, 'triaged', { skip_reason: null, attempts: 0, feedback: null, blocked: null });
  }
  if (issue.blocked) {
    log(`#${number}: retrying as asked (was blocked: ${issue.blocked.slice(0, 160)})`);
    issue = db.update(issue.id, { blocked: null });
  }
  if (issue.state === 'triaged' || issue.state === 'awaiting_claim') {
    // A dry issue is worked on without claiming; `approve pr` still requires the claim.
    if (dry) issue = db.transition(issue.id, 'claimed', { dry: 1 });
    else return promote(ctx, rc, issue);
  }
  return null;
}

// ---------------------------------------------------------------- pipeline

function issueVars(rc: RepoConfig, issue: Issue): Record<string, string> {
  return {
    repo: rc.full_name, number: String(issue.number), title: untrusted(issue.title).replace(/"/g, "'"),
    issue_body: untrusted(issue.body || '(empty)'), default_branch: rc.default_branch,
    triage_reason: issue.triage_reason ?? '',
    repo_notes: rc.notes.trim() ? `Project-specific conventions you must follow:\n${rc.notes.trim()}` : '',
    forbidden_paths: rc.forbidden_paths.length ? rc.forbidden_paths.join(', ') : '(none)',
  };
}

async function advance(ctx: Ctx, id: number): Promise<string | null> {
  const { cfg, db } = ctx;
  for (;;) {
    const issue = db.issue(id);
    if (issue.blocked) return `#${issue.number} blocked: ${issue.blocked}`;
    const rc = repoConfig(cfg, issue.repo);
    log(`#${issue.number}: ${issue.state} (attempt ${issue.attempts})`);
    switch (issue.state) {
      case 'claimed': {
        if (rc.claim_comment && !issue.dry) {
          const gi = await gh.getIssue(issue.repo, issue.number);
          const me = await gh.currentUser();
          if (gi.assignees.some((a) => a.login !== me)) { db.skip(id, 'assigned to someone else'); return `#${issue.number} lost to another assignee`; }
          if (rc.require_assignment && !gi.assignees.some((a) => a.login === me)) return `#${issue.number} claimed, waiting to be assigned`;
        }
        await reproduce(ctx, rc, issue);
        break;
      }
      case 'reproduced': await code(ctx, rc, issue); break;
      case 'coded': await gate(ctx, rc, issue); break;
      case 'gated': await review(ctx, rc, issue); break;
      case 'reviewed': {
        await writePr(ctx, rc, issue);
        const done = db.issue(id);
        await notify(cfg, `oss-bot: PR ready for review — ${issue.repo}#${issue.number} "${done.pr_title}"\n`
          + `Inspect: \`oss-bot show ${id}\`  Open it: \`oss-bot ${cmd.pr(id)}\`  Drop it: \`oss-bot reject ${id}\``);
        return `#${issue.number} ready for PR approval`;
      }
      case 'skipped': return `#${issue.number} skipped: ${issue.skip_reason}`;
      default: return null;
    }
  }
}

async function exportPatch(cfg: Config, issue: Issue): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(issue.base_sha ?? '')) throw new Error('missing base sha');
  const dir = agentDir(issue.repo, issue.number);
  // git runs inside the sandbox: the clone's .git is agent-writable, so the host never runs git in it.
  const r = await runInSandbox(cfg, dir,
    `G='git -c core.fsmonitor=false -c core.hooksPath=/dev/null'; $G add -A && $G diff --cached --binary ${issue.base_sha} > ${AGENT_META}/PATCH.diff`, 10);
  if (r.exitCode !== 0) throw new Error(`could not export patch: ${r.output}`);
  return readAgentFile(dir, `${AGENT_META}/PATCH.diff`);
}

async function reproduce(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const { cfg, db } = ctx;
  const base = await git(mirrorDir(rc.full_name), ['rev-parse', 'HEAD']);
  const dir = await prepareAgentWorkdir(issue.repo, issue.number, base);
  const r = await runAgent(ctx, {
    agent: 'reproducer', issueId: issue.id, workdir: dir,
    vars: {
      ...issueVars(rc, issue), focused_test: rc.focused_test,
      feedback: issue.feedback
        ? `Earlier attempts were rejected. If the feedback below criticises the test, write a better one:\n<feedback>\n${untrusted(issue.feedback)}\n</feedback>`
        : '',
    },
  });
  // The coder and reviewer read this: it often says why a test is impossible (e.g. nothing agreed to build yet).
  writeFileSync(join(issueDir(issue.repo, issue.number), 'REPRO_NOTES.txt'), r.notes);
  if (!r.reproduced || r.testFiles.length === 0 || !safeTestVars(r.testVars)) {
    // Not every issue is a bug a test can show; carry on without a regression test.
    log(`#${issue.number}: no regression test (${r.notes.slice(0, 160)})`);
    await prepareAgentWorkdir(issue.repo, issue.number, base); // drop anything the reproducer left
    rmSync(join(issueDir(issue.repo, issue.number), 'REPRO.diff'), { force: true });
    return db.transition(issue.id, 'reproduced', { base_sha: base, test_files: '[]', test_vars: '{}', test_hashes: '{}' });
  }

  const withBase = db.update(issue.id, {
    base_sha: base, test_files: JSON.stringify(r.testFiles), test_vars: JSON.stringify(repairPathVars(r.testVars, r.testFiles)),
  });
  const reproPatch = await exportPatch(cfg, withBase);
  const files = parsePatch(reproPatch).map((f) => f.path);
  const nonTest = files.filter((f) => !r.testFiles.includes(f));
  if (nonTest.length) return db.skip(issue.id, `reproducer changed non-test files: ${nonTest.join(', ')}`);
  if (!r.testFiles.every((f) => files.includes(f))) return db.skip(issue.id, 'reported test files are not in the diff');
  focusedTestCommand(rc, withBase); // throws on unfilled variables
  writeFileSync(join(issueDir(issue.repo, issue.number), 'REPRO.diff'), reproPatch);
  db.transition(issue.id, 'reproduced', { test_hashes: JSON.stringify(hashTestFiles(withBase)) });
}

function reproNotes(issue: Issue): string {
  const file = join(issueDir(issue.repo, issue.number), 'REPRO_NOTES.txt');
  const notes = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return notes ? `\nNotes from the agent that tried to reproduce it:\n<untrusted_notes>\n${untrusted(notes)}\n</untrusted_notes>` : '';
}

function testSection(rc: RepoConfig, issue: Issue): string {
  const files: string[] = JSON.parse(issue.test_files ?? '[]');
  if (!files.length) {
    return 'There is no regression test for this issue: do what it asks, and add or update tests\n'
      + 'where the change has behaviour to test.' + reproNotes(issue);
  }
  return `A regression test that currently fails has already been written:\n${files.map((f) => `- ${f}`).join('\n')}\n`
    + `Run it with: \`${focusedTestCommand(rc, issue)}\`\n\n`
    + 'Do not change or remove any line of that regression test: the fix is judged by it\n'
    + 'passing unchanged. You may ADD test cases (in the same files or new ones) to cover new\n'
    + 'branches of your fix.';
}

async function code(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const { db } = ctx;
  const feedback = issue.feedback
    ? `Previous attempts were rejected. Address ALL of this feedback, not only the latest:\n<feedback>\n${untrusted(issue.feedback)}\n</feedback>`
    : '';
  const r = await runAgent(ctx, {
    agent: 'coder', issueId: issue.id, workdir: agentDir(issue.repo, issue.number),
    vars: {
      ...issueVars(rc, issue), feedback,
      test_section: testSection(rc, issue),
    },
  });
  // Giving up is a judgement about the issue, not a slip: another paid attempt would read the same.
  if (!r.done) return db.skip(issue.id, `coder gave up: ${r.summary}`);
  db.transition(issue.id, 'coded', { summary: r.summary });
}

async function gate(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const vars = JSON.stringify(repairPathVars(JSON.parse(issue.test_vars ?? '{}'), JSON.parse(issue.test_files ?? '[]')));
  if (vars !== (issue.test_vars ?? '{}')) issue = ctx.db.update(issue.id, { test_vars: vars });
  const patch = await exportPatch(ctx.cfg, issue);
  const g = await runGate(ctx.cfg, rc, issue, patch, log);
  if (!g.ok && g.kind === 'environment') return blockOnEnvironment(ctx, issue, g.step ?? '', g.reason);
  if (!g.ok) return retry(ctx, issue, `CI gate failed: ${g.reason}`);
  // From here on the canonical patch is a host-owned copy outside the agent's tree.
  writeFileSync(join(issueDir(issue.repo, issue.number), 'PATCH.diff'), patch);
  ctx.db.transition(issue.id, 'gated');
}

async function reviewDir(issue: Issue): Promise<string> {
  const patch = readFileSync(join(issueDir(issue.repo, issue.number), 'PATCH.diff'), 'utf8');
  const dir = join(issueDir(issue.repo, issue.number), 'review');
  await freshClone(issue.repo, issue.base_sha!, dir);
  await applyPatch(dir, patch);
  mkdirSync(join(dir, AGENT_META), { recursive: true });
  writeFileSync(join(dir, AGENT_META, 'PATCH.diff'), patch);
  return dir;
}

function reviewTestStatus(issue: Issue): string {
  const files: string[] = JSON.parse(issue.test_files ?? '[]');
  if (!files.length) {
    return 'No regression test was written for this issue (redoTest does not apply; tests the\n'
      + 'change adds are the coder\'s and are judged like the rest of the change).' + reproNotes(issue);
  }
  return `The regression test, written before the fix and failing on the base:\n${files.map((f) => `- ${f}`).join('\n')}`;
}

async function review(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const r = await runAgent(ctx, {
    agent: 'reviewer', issueId: issue.id, workdir: await reviewDir(issue), readOnly: true,
    vars: {
      ...issueVars(rc, issue),
      test_status: reviewTestStatus(issue),
      feedback: issue.feedback
        ? `Earlier rounds sent the change back with this feedback:\n<feedback>\n${untrusted(issue.feedback)}\n</feedback>`
        : '',
    },
  });
  if (r.verdict === 'reject') {
    const reasons = `- ${r.reasons.join('\n- ')}`;
    // Another attempt would read the same: e.g. the maintainers have not agreed on what to build.
    if (!r.retryable) return ctx.db.skip(issue.id, `Reviewer: no rework can fix this:\n${reasons}`);
    // The coder may not touch the regression test, so test complaints go back to the reproducer.
    // Without one there is nothing for the reproducer to rewrite.
    const redoTest = r.redoTest && JSON.parse(issue.test_files ?? '[]').length > 0;
    return retry(ctx, issue, `Reviewer rejected${redoTest ? ' (the test must be rewritten)' : ''}:\n${reasons}`,
      redoTest ? 'claimed' : 'reproduced');
  }
  ctx.db.transition(issue.id, 'reviewed');
}

async function writePr(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const r = await runAgent(ctx, {
    agent: 'pr-writer', issueId: issue.id, workdir: await reviewDir(issue), readOnly: true,
    vars: { ...issueVars(rc, issue), summary: issue.summary ?? '' },
  });
  writeFileSync(join(issueDir(issue.repo, issue.number), 'WHY.json'), JSON.stringify(r.why, null, 1));
  ctx.db.transition(issue.id, 'awaiting_pr_approval', { pr_title: r.title, pr_body: r.body });
}

/**
 * A gate step that fails on the unpatched base says nothing about the change: the issue
 * keeps its state and attempts, is left out of `nextIssues` until `repo doctor` clears it,
 * and the human hears about it once.
 */
async function blockOnEnvironment(ctx: Ctx, issue: Issue, step: string, reason: string) {
  const why = `gate broken on base: ${step}`.slice(0, 500);
  ctx.db.update(issue.id, { blocked: why });
  log(`#${issue.number}: blocked (${why})`);
  await notify(ctx.cfg, `oss-bot: ${issue.repo} — ${why}\n${tail(reason, 20)}\n`
    + `Nothing wrong with the change; the step fails on the base too. Check the gate: \`oss-bot repo doctor ${issue.repo} --fix\``);
  return `#${issue.number} blocked: ${why}`;
}

function retry(ctx: Ctx, issue: Issue, feedback: string, from: 'claimed' | 'reproduced' = 'reproduced') {
  const attempts = issue.attempts + 1;
  if (attempts >= ctx.cfg.limits.max_attempts) {
    return ctx.db.skip(issue.id, `gave up after ${attempts} attempts; last: ${feedback}`);
  }
  log(`#${issue.number}: retry ${attempts}: ${feedback.slice(0, 200)}`);
  // Keep every rejection: a later gate failure must not hide what the reviewer asked for.
  const history = `${issue.feedback ? `${issue.feedback}\n\n` : ''}Attempt ${attempts}:\n${feedback}`;
  return ctx.db.transition(issue.id, from, { attempts, feedback: history.slice(-12_000) });
}

// ---------------------------------------------------------------- follow-up

async function followUp(ctx: Ctx, issueId: number): Promise<string | null> {
  const { cfg, db } = ctx;
  const issue = db.issue(issueId);
  const pr = db.prForIssue(issueId)!;
  const rc = repoConfig(cfg, issue.repo);

  const snap = await gh.prSnapshot(issue.repo, pr.number);
  db.updatePr(issueId, {
    head_sha: snap.headSha, mergeable: snap.mergeable, merge_state: snap.mergeState, ci_state: snap.ci,
    review_decision: snap.reviewDecision, snapshot_at: new Date().toISOString(),
  });
  if (snap.state !== 'open') {
    db.updatePr(issueId, { state: snap.state });
    db.transition(issueId, snap.state === 'merged' ? 'done' : 'closed');
    if (snap.state === 'merged') {
      await notify(cfg, `🎉 oss-bot: ${pr.url} was merged.`);
    } else {
      const last = (await gh.prCommentsSince(issue.repo, pr.number, '1970-01-01T00:00:00Z', rc.review_bots)).slice(-3);
      await notify(cfg, `oss-bot: ${pr.url} was CLOSED without being merged.\n\n`
        + (last.map((c) => `@${c.author}: ${c.body.slice(0, 300)}`).join('\n\n') || '(no comments)'));
    }
    return `PR ${pr.url} ${snap.state}`;
  }
  // The issue closed under the PR: maybe fixed another way, maybe no longer wanted. Said once.
  if (!db.get(`issue-closed:${issueId}`)) {
    const gi = await gh.getIssue(issue.repo, issue.number);
    if (gi.state !== 'OPEN') {
      db.set(`issue-closed:${issueId}`, gi.state);
      await notify(cfg, `oss-bot: ${issue.url} was closed while ${pr.url} is still open. Check whether the PR is still wanted.`);
    }
  }
  if (issue.blocked) return `PR ${pr.url}: waiting for repo doctor (${issue.blocked})`;
  const pending = db.pendingActionFor(issueId);

  // 1. Conflicts with the base branch: rebase, gate, queue the push for approval.
  if (snap.mergeable === 'CONFLICTING') {
    if (pending) return `PR ${pr.url}: conflicts with ${rc.default_branch}, but a draft is still pending`;
    return prepareRebase(ctx, rc, issue, pr, 'conflict');
  }
  // Out of date but mergeable: only worth a push once it is approved and the base is all that
  // blocks the merge. Earlier, every push would restart CI approval and the race with main;
  // while a maintainer still has to let CI run, a push only makes them do it again.
  // Once per PR head: a rejected draft is not offered again until the PR changes.
  if (snap.mergeState === 'BEHIND' && snap.reviewDecision === 'APPROVED' && snap.ci !== 'awaiting_approval' && !pending
    && db.get(`behind-drafted:${issueId}`) !== snap.headSha) {
    db.set(`behind-drafted:${issueId}`, snap.headSha);
    return prepareRebase(ctx, rc, issue, pr, 'behind');
  }

  // 2. New review comments, and CI that failed on a commit not looked at yet.
  const comments = await gh.prCommentsSince(issue.repo, pr.number, pr.last_seen_at, rc.review_bots);
  const ciFailed = snap.ci === 'failure' && pr.ci_seen_sha !== snap.headSha;
  if (comments.length === 0 && !ciFailed) return null;
  if (pending) return `PR ${pr.url}: new activity, previous draft still pending`;

  const parts = comments.map((c) => `[${c.kind}] @${c.author}${c.path ? ` on ${c.path}:${c.line}` : ''}:\n${c.body}`);
  if (ciFailed) {
    let failed = await gh.failedCheckDetails(issue.repo, snap.headSha);
    if (!failed.length) {
      failed = snap.checks.filter((c) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion))
        .map((c) => ({ name: c.name, summary: `(no details${c.url ? `; ${c.url}` : ''})` }));
    }
    for (const f of failed) parts.push(`[ci] check "${f.name}" failed on the PR's latest commit:\n${f.summary}`);
  }
  const text = parts.join('\n\n');
  const patch = readFileSync(join(issueDir(issue.repo, issue.number), 'PATCH.diff'), 'utf8');
  const dir = await prepareAgentWorkdir(issue.repo, issue.number, issue.base_sha!);
  await applyPatch(dir, patch); // host applies before the agent touches the dir

  const r = await runAgent(ctx, {
    agent: 'followup', issueId, workdir: dir, vars: { ...issueVars(rc, issue), comments: untrusted(text) },
  });
  const seen = () => db.updatePr(issueId, {
    ...(comments.length ? { last_seen_at: comments[comments.length - 1].createdAt } : {}),
    ...(ciFailed ? { ci_seen_sha: snap.headSha } : {}),
  });

  if (r.action === 'wait') { seen(); return null; }
  if (r.action === 'human') {
    // Something only the contributor can do (sign a CLA, ask for a workflow run): waiting silently would stall the PR.
    seen();
    await notify(cfg, `oss-bot: ${pr.url} needs you:\n${r.message.slice(0, 1500)}`);
    return `PR ${pr.url}: needs you (${r.message.split('\n')[0].slice(0, 120)})`;
  }
  if (r.action === 'close') {
    seen();
    await notify(cfg, `oss-bot: ${pr.url} — reviewer seems to reject the PR:\n${text.slice(0, 1500)}`);
    return `PR ${pr.url}: looks rejected`;
  }
  let newPatch: string | null = null;
  if (r.action === 'fix') {
    newPatch = await exportPatch(cfg, issue);
    const g = await runGate(cfg, rc, issue, newPatch, log);
    if (!g.ok && g.kind === 'environment') {
      // The comments stay unseen: once the gate works again the next run drafts the fix anew.
      await blockOnEnvironment(ctx, issue, g.step ?? '', g.reason);
      return `PR ${pr.url}: follow-up fix blocked by the environment`;
    }
    if (!g.ok) {
      seen();
      await notify(cfg, `oss-bot: ${pr.url} — drafted fix failed the gate (${g.reason.slice(0, 500)}). Handle manually.`);
      return `PR ${pr.url}: follow-up fix failed the gate`;
    }
  }
  seen();
  // A bot (or CI) needs no answer: a fix that only addresses those goes out as a commit alone.
  const botsOnly = comments.every((c) => gh.isBot(c.author));
  if (botsOnly && !newPatch) return null;
  const message = botsOnly
    ? `\n\n${OWN_REPLY}\nOnly bot comments or CI here, so no reply is needed: leave the space above empty to push the\n`
      + `commit without commenting. What the agent changed (for you only, never posted):\n\n${r.message}\n`
    : rc.draft_replies ? r.message
    : `\n\n${OWN_REPLY}\n${issue.repo} requires review answers in your own words. Write your reply above the marker line;\n`
      + `the marker and everything below it are removed. What the agent understood (for you only, never posted):\n\n${r.message}\n`;
  const actionId = db.addAction(issueId, newPatch ? 'fix' : 'reply', message, newPatch);
  const what = [comments.length ? 'review comments' : '', ciFailed ? 'failed CI' : ''].filter(Boolean).join(' and ');
  await notify(cfg, `oss-bot: ${pr.url} has new ${what}. Drafted ${newPatch ? 'a fix and ' : ''}${botsOnly ? 'no reply (bots/CI only)' : 'a reply'}.\n`
    + `Inspect: \`oss-bot show a${actionId}\`  Send: \`oss-bot ${cmd.followup(actionId)}\``);
  return `PR ${pr.url}: follow-up drafted`;
}

/**
 * The PR no longer merges: re-apply PATCH.diff on today's default branch (git 3-way first, the
 * follow-up agent on a real conflict), run the gate there, and queue a `rebase` action. The
 * push happens only after `approve`. One attempt per base commit.
 */
async function prepareRebase(ctx: Ctx, rc: RepoConfig, issue: Issue, pr: Pr, why: 'conflict' | 'behind'): Promise<string> {
  const { cfg, db } = ctx;
  const newBase = await git(mirrorDir(issue.repo), ['rev-parse', 'HEAD']);
  const key = `rebase-tried:${issue.id}`;
  if (why === 'conflict' && db.get(key) === newBase) return `PR ${pr.url}: conflicts with ${rc.default_branch}; the rebase attempt on this base needs your help`;
  if (why === 'conflict') db.set(key, newBase);
  const dir = issueDir(issue.repo, issue.number);
  const patch = readFileSync(join(dir, 'PATCH.diff'), 'utf8');
  const onNew = { ...issue, base_sha: newBase };
  const work = join(dir, 'rebase');
  await freshClone(issue.repo, newBase, work);
  let newPatch: string;
  let how: string;
  try {
    await applyPatch(work, patch, true);
    newPatch = `${await git(work, ['diff', '--cached', '--binary', 'HEAD'])}\n`;
    how = 'git re-applied it cleanly (3-way)';
  } catch (e) {
    log(`#${issue.number}: rebase conflict, asking the agent`);
    const agentWork = await prepareAgentWorkdir(issue.repo, issue.number, newBase);
    writeFileSync(join(agentWork, AGENT_META, 'PATCH.diff'), patch);
    const r = await runAgent(ctx, {
      agent: 'followup', issueId: issue.id, workdir: agentWork,
      vars: {
        ...issueVars(rc, issue),
        comments: `[system] The PR no longer applies on ${rc.default_branch}: ${String((e as Error).message).slice(0, 500)}\n`
          + `The PR's current diff is in /work/.oss-bot/PATCH.diff. Re-apply that same change, including its test, onto the code now in /work. Choose "fix".`,
      },
    });
    if (r.action !== 'fix') {
      await notify(cfg, `oss-bot: ${pr.url} conflicts with ${rc.default_branch} and the agent could not re-apply it:\n${r.message.slice(0, 800)}`);
      return `PR ${pr.url}: rebase needs you`;
    }
    newPatch = await exportPatch(cfg, onNew);
    how = `the agent re-applied it: ${r.message}`;
  }
  const g = await runGate(cfg, rc, onNew, newPatch, log, { rebase: true });
  if (!g.ok && g.kind === 'environment') {
    await blockOnEnvironment(ctx, issue, g.step ?? '', g.reason);
    return `PR ${pr.url}: rebase blocked by the environment`;
  }
  if (!g.ok) {
    await notify(cfg, `oss-bot: ${pr.url} — the rebased change fails the gate (${g.reason.slice(0, 600)}). Handle manually.`);
    return `PR ${pr.url}: rebased change fails the gate`;
  }
  const id = db.addAction(issue.id, 'rebase', `Rebase onto ${rc.default_branch} @ ${newBase.slice(0, 10)}: ${how}`, newPatch, newBase);
  await notify(cfg, (why === 'conflict'
    ? `oss-bot: ${pr.url} conflicts with ${rc.default_branch}. Rebased and gated; ${how.slice(0, 300)}\n`
    : `oss-bot: ${pr.url} is approved but behind ${rc.default_branch}, which blocks the merge. Rebased and gated.\n`
      + `Pushing may dismiss the approval if the repo dismisses stale reviews; a maintainer can also press "Update branch".\n`)
    + `Push it: \`oss-bot ${cmd.followup(id)}\`  Inspect: \`oss-bot show a${id}\``);
  return `PR ${pr.url}: rebase drafted`;
}

// ---------------------------------------------------------------- human-approved actions

export async function approveClaim(ctx: Ctx, id: number) {
  const issue = ctx.db.issue(id);
  const rc = repoConfig(ctx.cfg, issue.repo);
  if (issue.claimed_at) throw new Error('already claimed');
  if (!['awaiting_claim', ...(issue.dry ? ['claimed', 'reproduced', 'coded', 'gated', 'reviewed', 'awaiting_pr_approval'] : [])].includes(issue.state)) {
    throw new Error(`issue is ${issue.state}`);
  }
  // Repos without a claim convention: approving just lets the bot start working.
  if (rc.claim_comment) await gh.commentOnIssue(issue.repo, issue.number, rc.claim_comment);
  ctx.db.update(id, { claimed_at: new Date().toISOString(), dry: 0, ...(issue.state === 'awaiting_claim' ? { state: 'claimed' as const } : {}) });
  console.log(rc.claim_comment ? `Posted "${rc.claim_comment}" on ${issue.url}` : `Claimed ${issue.url} (nothing posted)`);
}

export function editInEditor(path: string) {
  // Not `vi`: macOS vi runs Vim in compatible mode, which exits 1 after any error message
  // shown while editing (a mistyped command), even when the file was saved normally.
  const editor = process.env.VISUAL || process.env.EDITOR || 'vim';
  // $EDITOR may carry flags ("code -w"), so it goes through the shell; the path is quoted.
  const r = spawnSync(`${editor} '${path.replace(/'/g, `'\\''`)}'`, { stdio: 'inherit', shell: true });
  if (r.status === 0) return;
  // Vim also exits non-zero after any error shown during the session (a stale swap-file
  // warning, a mistyped command) even when the file was saved, so ask instead of guessing.
  process.stdout.write(`The editor exited with ${r.status}. Use ${path} as saved? [y/N] `);
  if (!/^y/i.test(readTtyLine())) {
    throw new Error(`nothing was posted. Your edits stay in ${path}; run the same command again to continue from them`);
  }
}

/** One line from the terminal, read synchronously (stdin may be a pipe under npm). */
function readTtyLine(): string {
  const fd = openSync('/dev/tty', 'r');
  try {
    const buf = Buffer.alloc(1);
    let line = '';
    while (readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]);
    return line.trim();
  } finally {
    closeSync(fd);
  }
}

export async function approvePr(ctx: Ctx, id: number) {
  const { cfg, db } = ctx;
  const issue = db.issue(id);
  const rc = repoConfig(cfg, issue.repo);
  if (issue.state !== 'awaiting_pr_approval') throw new Error(`issue is ${issue.state}, not awaiting_pr_approval`);
  if (rc.claim_comment && !issue.claimed_at) throw new Error(`claim the issue first: oss-bot approve claim ${id}`);
  if (db.openPrCount(issue.repo) >= cfg.limits.max_open_prs_per_repo) throw new Error('open PR limit for this repo reached');
  const gi = await gh.getIssue(issue.repo, issue.number);
  const me = await gh.currentUser();
  if (gi.state !== 'OPEN') throw new Error('the issue has been closed meanwhile');
  if (rc.claim_comment && rc.require_assignment && !gi.assignees.some((a) => a.login === me)) {
    throw new Error(`you are not assigned to ${issue.url} yet; wait for the maintainers' bot after the claim`);
  }

  const dir = issueDir(issue.repo, issue.number);
  const patch = readFileSync(join(dir, 'PATCH.diff'), 'utf8');
  const fixed = staticChecks(patch, rc);
  if (!fixed.ok) throw new Error(fixed.reason);

  const bodyFile = join(dir, 'PR_BODY.md');
  if (!existsSync(bodyFile)) {
    // The disclosure comes from what the runtime reported, never from an agent's own claim.
    const models = db.modelsForIssue(issue.id);
    const tool = models ? `${rc.agent_disclosure} (model${models.length > 1 ? 's' : ''}: ${models.join(', ')})` : rc.agent_disclosure;
    writeFileSync(bodyFile, `${issue.pr_title}\n\n${issue.pr_body}\n\n${whyBlock(readWhy(dir))}\n\n`
      + `AI disclosure: this change was drafted with ${tool}. I reviewed and tested it myself.\n`);
  }
  console.log(`Opening ${bodyFile}. The first line is the PR title. Pick one reason (or write your own).`);
  editInEditor(bodyFile);
  const edited = readFileSync(bodyFile, 'utf8');
  if (edited.includes(OWN_WORDS)) throw new Error('the "own words" placeholder is still there; PR not opened');
  if (readWhy(dir).length > 1 && readWhy(dir).every((w) => edited.includes(w.en))) {
    throw new Error('both suggested reasons are still there; keep one. PR not opened');
  }
  const [title, ...rest] = stripComments(edited).split('\n');
  const body = rest.join('\n').trim();
  if (!title.trim() || !body) throw new Error('empty title or body');

  // Push from a host-made clone; the agent never had access to this directory.
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
  const branch = rc.branch_prefix + fillTemplate(rc.branch_name, { number: String(issue.number), slug });
  const push = join(dir, 'push');
  await freshClone(issue.repo, issue.base_sha!, push);
  await git(push, ['checkout', '-b', branch]);
  await applyPatch(push, patch);
  const who = await gh.gitIdentity(signingKey(cfg));
  // Same keyword as the PR body: "Refs" keeps the issue open when the change only partly covers it.
  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issue.number}\\b`, 'i').test(body);
  await git(push, [...who, 'commit', ...(rc.signoff ? ['--signoff'] : []), '-m', title.trim(), '-m', `${closes ? 'Fixes' : 'Refs'} #${issue.number}`]);
  if (rc.after_commit.length) writeFileSync(join(dir, 'PATCH.diff'), await afterCommit(cfg, rc, push, issue.base_sha!, who));
  await git(push, ['remote', 'add', 'fork', `https://github.com/${rc.fork}.git`]);

  // A previous approve may have pushed and then failed before or while opening the PR.
  const head = `${rc.fork.split('/')[0]}:${branch}`;
  const existing = await gh.openPrForHead(issue.repo, head);
  const remote = (await git(push, [...who, 'ls-remote', '--heads', 'fork', branch])).split(/\s+/)[0];
  if (!remote) {
    await git(push, [...who, 'push', '-u', 'fork', branch]);
  } else {
    await git(push, [...who, 'fetch', '--quiet', 'fork', branch]);
    const same = (await git(push, ['rev-parse', 'FETCH_HEAD^{tree}'])) === (await git(push, ['rev-parse', 'HEAD^{tree}']));
    if (same) {
      // Same content, different commit: adopt the pushed one so later follow-ups build on it.
      await git(push, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    } else {
      if (existing) throw new Error(`${existing.url} already exists with different content; update it by hand`);
      // Our own branch, never in a PR: replace it, but only if it is still what we just saw.
      await git(push, [...who, 'push', '-u', `--force-with-lease=${branch}:${remote}`, 'fork', branch]);
    }
  }

  const pr = existing ?? await gh.createPr({ repo: issue.repo, base: rc.default_branch, head, title: title.trim(), body });
  db.insertPr(id, pr.url, pr.number);
  db.transition(id, 'pr_open', { branch });
  console.log(`Opened ${pr.url}`);
}

/** Follows the PR title's Conventional Commits prefix, e.g. "fix(tool): address review feedback". */
function readWhy(dir: string): Why[] {
  const f = join(dir, 'WHY.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

// The reasons go in as plain lines; their Vietnamese meaning sits in a comment that never posts.
export function whyBlock(why: Why[]): string {
  if (!why.length) return OWN_WORDS;
  return [PICK_WHY, ...why.map((w, i) => `<!-- ${i + 1}: ${w.vi.replace(/-->/g, '')} -->\n${w.en}`)].join('\n\n');
}

export const stripComments = (text: string) =>
  text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');

/**
 * Runs the repo's `after_commit` commands on the commit just made in `push` and folds what they
 * change into it. They run in the sandbox on a separate full-history clone; the host only reads
 * back a diff (it never runs git in a tree a container wrote to). Returns the PR's full diff.
 */
/** The SSH signing key from config, with ~ expanded; checked so a typo fails before anything is pushed. */
export function signingKey(cfg: Config): string | undefined {
  const k = cfg.commit_signing_key?.replace(/^~(?=\/)/, homedir());
  if (k && !existsSync(k)) throw new Error(`commit_signing_key ${k} does not exist`);
  return k;
}

export async function afterCommit(cfg: Config, rc: RepoConfig, push: string, base: string, who: string[]): Promise<string> {
  if (rc.after_commit.length) {
    log(`after_commit: ${rc.after_commit.join(' && ')}`);
    // Generators that read git dates need the whole history, which the mirror does not keep.
    await git(push, [...who, 'fetch', '-q', '--unshallow', `https://github.com/${rc.full_name}.git`, rc.default_branch]).catch(() => '');
    const gen = join(push, '..', 'after-commit');
    rmSync(gen, { recursive: true, force: true });
    await execa('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '-q', '--no-hardlinks', `file://${resolve(push)}`, gen]);
    mkdirSync(join(gen, AGENT_META), { recursive: true });
    appendFileSync(join(gen, '.git', 'info', 'exclude'), `\n/${AGENT_META}/\n`);
    const r = await runInSandbox(cfg, gen, `git config --global --add safe.directory /work; ${rc.after_commit.join(' && ')} `
      + `&& git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null diff --cached --binary HEAD > ${AGENT_META}/AFTER.diff`);
    if (r.exitCode !== 0) throw new Error(`after_commit failed; nothing pushed:\n${r.output}`);
    const extra = readAgentFile(gen, `${AGENT_META}/AFTER.diff`);
    if (extra.trim()) {
      const fixed = staticChecks(extra, { ...rc, allowed_paths: [] });
      if (!fixed.ok) throw new Error(`after_commit produced a change the gate rejects (${fixed.reason}); nothing pushed`);
      await applyPatch(push, extra);
      await git(push, [...who, 'commit', '-q', '--amend', '--no-edit']);
      log(`after_commit: folded ${parsePatch(extra).map((f) => f.path).join(', ')} into the commit`);
    }
  }
  return `${await git(push, ['diff', '--binary', base, 'HEAD'])}\n`;
}

/** Replaces the PR branch with one commit of the rebased patch; refuses if the branch moved since the bot last pushed it. */
async function approveRebase(ctx: Ctx, action: PendingAction, issue: Issue, pr: Pr) {
  const { cfg, db } = ctx;
  const rc = repoConfig(cfg, issue.repo);
  const fixed = staticChecks(action.patch!, rc);
  if (!fixed.ok) throw new Error(fixed.reason);
  const dir = issueDir(issue.repo, issue.number);
  const push = join(dir, 'push');
  const who = await gh.gitIdentity(signingKey(cfg));
  await freshClone(issue.repo, action.base_sha!, push);
  await git(push, ['checkout', '-q', '-B', issue.branch!]); // freshClone leaves HEAD detached; push needs the branch
  await git(push, ['remote', 'add', 'fork', `https://github.com/${rc.fork}.git`]);
  await git(push, [...who, 'fetch', '--quiet', '--depth', '50', 'fork', issue.branch!]);
  const remoteSha = await git(push, ['rev-parse', 'FETCH_HEAD']);
  // The branch must still be exactly old base + PATCH.diff: never overwrite someone else's commit.
  await git(push, ['read-tree', '--reset', '-u', issue.base_sha!]);
  await applyPatch(push, readFileSync(join(dir, 'PATCH.diff'), 'utf8'));
  const unknown = await git(push, ['diff', '--cached', '--name-only', 'FETCH_HEAD']);
  if (unknown) {
    throw new Error(`the PR branch has changes the bot did not make (${unknown.split('\n').join(', ')}); `
      + `rebase by hand or run: oss-bot reject a${action.id}`);
  }
  await git(push, ['read-tree', '--reset', '-u', action.base_sha!]);
  await applyPatch(push, action.patch!);
  await git(push, [...who, 'commit', ...(rc.signoff ? ['--signoff'] : []), '-m', issue.pr_title ?? `Fix #${issue.number}`, '-m', `Fixes #${issue.number}`]);
  const full = await afterCommit(cfg, rc, push, action.base_sha!, who);
  await git(push, [...who, 'push', `--force-with-lease=${issue.branch}:${remoteSha}`, 'fork', `HEAD:refs/heads/${issue.branch}`]);
  writeFileSync(join(dir, 'PATCH.diff'), full);
  db.update(issue.id, { base_sha: action.base_sha });
  db.updatePr(issue.id, { head_sha: await git(push, ['rev-parse', 'HEAD']), mergeable: 'UNKNOWN', ci_state: 'pending' });
  db.setActionStatus(action.id, 'done');
  console.log(`Rebased ${pr.url} onto ${action.base_sha!.slice(0, 10)} and force-pushed ${issue.branch}`);
}

export function followupCommitMessage(dir: string, draftTitle: string | null): string {
  const body = join(dir, 'PR_BODY.md');
  const title = existsSync(body) ? readFileSync(body, 'utf8').split('\n')[0] : draftTitle ?? '';
  const m = /^(\w+(?:\([^)]*\))?)!?:/.exec(title.trim());
  return m ? `${m[1]}: address review feedback` : 'Address review feedback';
}

export async function approveFollowup(ctx: Ctx, actionId: number) {
  const { cfg, db } = ctx;
  const action = db.action(actionId);
  if (action.status !== 'pending') throw new Error(`action is ${action.status}`);
  const issue = db.issue(action.issue_id);
  const pr = db.prForIssue(issue.id)!;
  const dir = issueDir(issue.repo, issue.number);
  if (action.kind === 'rebase') return approveRebase(ctx, action, issue, pr);

  const msgFile = join(dir, `REPLY_${actionId}.md`);
  writeFileSync(msgFile, action.message);
  editInEditor(msgFile);
  let message = readFileSync(msgFile, 'utf8');
  const cut = message.indexOf(OWN_REPLY);
  if (cut >= 0) message = message.slice(0, cut);
  message = message.trim();
  if (!message && !action.patch) throw new Error('empty reply; nothing sent');

  if (action.patch) {
    const rc = repoConfig(cfg, issue.repo);
    const fixed = staticChecks(action.patch, rc);
    if (!fixed.ok) throw new Error(fixed.reason);
    const push = join(dir, 'push');
    const who = await gh.gitIdentity(signingKey(cfg));
    // Build on what is on the fork now, and only if it is exactly the patch we last pushed:
    // a commit made elsewhere (e.g. "Commit suggestion" on GitHub) must not be overwritten.
    await git(push, [...who, 'fetch', '--quiet', 'fork', issue.branch!]);
    await git(push, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    await git(push, ['read-tree', '--reset', '-u', issue.base_sha!]);
    await applyPatch(push, readFileSync(join(dir, 'PATCH.diff'), 'utf8'));
    const unknown = await git(push, ['diff', '--cached', '--name-only', 'FETCH_HEAD']);
    await git(push, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    if (unknown) {
      throw new Error(`the PR branch has changes the bot did not make (${unknown.split('\n').join(', ')}); `
        + `apply the follow-up by hand or run: oss-bot reject a${actionId}`);
    }
    // Reset the tree to base, apply the full new patch: the commit holds exactly the delta.
    await git(push, ['read-tree', '--reset', '-u', issue.base_sha!]);
    await applyPatch(push, action.patch);
    await git(push, [...who, 'commit', ...(rc.signoff ? ['--signoff'] : []), '-m', followupCommitMessage(dir, issue.pr_title)]);
    const full = await afterCommit(cfg, rc, push, issue.base_sha!, who);
    await git(push, [...who, 'push', 'fork', `HEAD:refs/heads/${issue.branch}`]);
    writeFileSync(join(dir, 'PATCH.diff'), full);
  }
  if (message) await gh.commentOnIssue(issue.repo, pr.number, message);
  db.setActionStatus(actionId, 'done');
  console.log(`Follow-up sent on ${pr.url}:${action.patch ? ' commit pushed' : ''}${message ? ' reply posted' : ''}`);
}
