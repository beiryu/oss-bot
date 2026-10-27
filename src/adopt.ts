import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from './config.js';
import { ensureMirror, freshClone, git, issueDir, mirrorDir, parsePatch } from './git.js';
import * as gh from './github.js';
import type { GhPr } from './github.js';
import type { Ctx } from './orchestrator.js';

// Brings PRs opened before this state.db existed (or by hand) under follow-up: the bot then
// tracks CI, reviews, conflicts and merges for them like for the PRs it opened itself.

/** Adopts one PR; returns what happened, one line. */
async function adoptOne(ctx: Ctx, rc: RepoConfig, pr: GhPr, me: string): Promise<string> {
  const { db } = ctx;
  const forkOwner = rc.fork.split('/')[0];
  if (pr.headRepositoryOwner.login.toLowerCase() !== forkOwner.toLowerCase()) {
    return `${pr.url}: head is not on ${rc.fork}, skipped`;
  }
  const linked = pr.closingIssuesReferences.map((i) => i.number);
  if (linked.length !== 1) {
    return `${pr.url}: links ${linked.length ? `${linked.length} issues` : 'no issue'} (needs exactly one "Fixes #N"), skipped`;
  }
  const number = linked[0];
  const existing = db.issueByNumber(rc.full_name, number);
  if (existing && db.prForIssue(existing.id)) return `${pr.url}: already tracked`;

  // PATCH.diff must be exactly base + patch = PR head, as follow-up fixes and rebases check it
  // against the fork branch before pushing. The merge base keeps a merged-in main out of it.
  const cmp = await gh.compareMergeBase(rc.full_name, rc.default_branch, `${forkOwner}:${pr.headRefName}`);
  const mirror = mirrorDir(rc.full_name);
  await ensureMirror(rc.full_name, rc.default_branch);
  // Under a tag: a clone of the mirror (push dir, rebases) only carries commits a ref reaches.
  await git(mirror, ['fetch', '--quiet', '--depth', '1', 'origin', `+${cmp}:refs/tags/oss-bot-base-${cmp.slice(0, 12)}`]);
  await git(mirror, ['fetch', '--quiet', '--depth', '1', 'origin', `refs/pull/${pr.number}/head`]);
  const head = await git(mirror, ['rev-parse', 'FETCH_HEAD']);
  if (head !== pr.headRefOid) return `${pr.url}: head moved while adopting (${head.slice(0, 10)}), try again`;
  const patch = `${await git(mirror, ['diff', '--binary', cmp, head])}\n`;
  parsePatch(patch); // the same checks every bot patch passes

  const dir = issueDir(rc.full_name, number);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PATCH.diff'), patch);
  // First line is the title: follow-up commit messages take their Conventional Commits prefix from it.
  writeFileSync(join(dir, 'PR_BODY.md'), `${pr.title}\n\n${pr.body}\n`);
  const push = join(dir, 'push');
  await freshClone(rc.full_name, cmp, push);
  await git(push, ['checkout', '-q', '-B', pr.headRefName]);
  await git(push, ['remote', 'add', 'fork', `https://github.com/${rc.fork}.git`]);

  if (!existing) {
    const gi = await gh.getIssue(rc.full_name, number);
    db.insertDiscovered({ repo: rc.full_name, number, title: gi.title, body: gi.body ?? '', url: gi.url });
  }
  const issue = db.issueByNumber(rc.full_name, number)!;
  db.transition(issue.id, 'pr_open', {
    base_sha: cmp, branch: pr.headRefName, pr_title: pr.title, pr_body: pr.body, patch, pr_text: `${pr.title}\n\n${pr.body}\n`,
    claimed_at: issue.claimed_at ?? pr.createdAt, skip_reason: null, blocked: null, dry: 0,
  });
  // What came before your last comment, review reply or commit was handled by hand; anything
  // after it (e.g. a "request changes" nobody answered yet) gets a drafted answer on the next run.
  db.insertPr(issue.id, pr.url, pr.number, { openedAt: pr.createdAt, lastSeenAt: await gh.myLastActivity(rc.full_name, pr.number, me) });
  return `${pr.url}: adopted as #${number} (${patch.split('\n').length} diff lines)`;
}

/** `pr adopt`: the given PR URLs, or every open PR of yours in the configured repos that no row tracks yet. */
export async function adoptPrs(ctx: Ctx, urls: string[]): Promise<string[]> {
  const { cfg, db } = ctx;
  const me = await gh.currentUser();
  const tracked = new Set(db.openPrs().map((p) => p.url));
  const out: string[] = [];
  const wanted = urls.map((u) => {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(u);
    if (!m) throw new Error(`not a PR URL: ${u}`);
    return { repo: m[1], number: Number(m[2]) };
  });
  for (const rc of cfg.repos) {
    const mine = wanted.length ? wanted.filter((w) => w.repo === rc.full_name).map((w) => w.number) : null;
    if (mine && !mine.length) continue;
    for (const pr of await gh.myOpenPrs(rc.full_name, me)) {
      if (mine && !mine.includes(pr.number)) continue;
      if (tracked.has(pr.url)) { if (mine) out.push(`${pr.url}: already tracked`); continue; }
      try {
        out.push(await adoptOne(ctx, rc, pr, me));
      } catch (e) {
        out.push(`${pr.url}: failed: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  for (const w of wanted) {
    if (!cfg.repos.some((r) => r.full_name === w.repo)) out.push(`${w.repo}#${w.number}: repo is not configured, skipped`);
  }
  return out.length ? out : ['nothing to adopt: every open PR of yours in the configured repos is tracked'];
}
