import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'yaml';
import { runAgent } from './agent.js';
import { type Config, type RepoConfig, RepoConfigSchema, repoFile, writeRepoConfig } from './config.js';
import { formatSteps, probeRepo } from './doctor.js';
import { ensureMirror, mirrorDir, slug } from './git.js';
import * as gh from './github.js';
import { editInEditor, type Ctx } from './orchestrator.js';
import { aiPolicyExcerpts, formatExcerpts } from './policy.js';

// `repo add`: fork, mirror, read the project's rules, let the scout agent draft the config,
// prove the gate runs here, show everything, and only then write the file (and the fork).
// `repo remove`: the reverse, except the fork, which the human deletes.

/** The scout writes YAML-ish values; accept the obvious variants (notes as lines, lists as one string). */
export function normalizeScoutConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (Array.isArray(out.notes)) out.notes = out.notes.map(String).join('\n');
  for (const k of ['labels', 'skip_labels', 'forbidden_paths', 'allowed_paths', 'gate', 'review_bots']) {
    if (typeof out[k] === 'string') out[k] = [out[k]];
  }
  for (const k of ['claim_comment', 'focused_test']) if (out[k] === null || out[k] === '') delete out[k];
  return out;
}

export function parseRepoArg(input: string): string {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m || m[1] === 'orgs') throw new Error(`not a GitHub repository: ${input}`);
  return `${m[1]}/${m[2]}`;
}

const WORK = (repo: string) => join('work', slug(repo));

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** What the scout gets to read about the repo, gathered by plain code. */
export async function gatherFacts(repo: string, mirror: string): Promise<string> {
  const info = await gh.repoInfo(repo);
  const prs = await gh.recentPrs(repo, 50);
  const fromForks = prs.filter((p) => p.isCrossRepository);
  const merged = fromForks.filter((p) => p.mergedAt);
  const open = fromForks.filter((p) => p.state === 'OPEN');
  const closed = fromForks.length - open.length;
  const bots = new Set<string>();
  for (const p of prs) for (const r of p.reviews ?? []) if (r.author?.login && gh.isBot(r.author.login)) bots.add(r.author.login);
  const issues = await gh.listOpenIssues(repo, [], 200);
  const labels = new Map<string, number>();
  for (const i of issues) for (const l of i.labels) labels.set(l.name, (labels.get(l.name) ?? 0) + 1);
  const topLabels = [...labels].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => `${n} (${c})`).join(', ');
  const assigned = issues.filter((i) => i.assignees.length).length;
  const candidates = ['CONTRIBUTING.md', 'CONTRIBUTING', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md',
    '.agents', '.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'OWNERS',
    'Makefile', 'go.mod', 'go.work', 'package.json', 'pyproject.toml', 'Cargo.toml', 'DCO', 'CLA.md'];
  const files = candidates.filter((f) => existsSync(join(mirror, f)));
  const wfDir = join(mirror, '.github', 'workflows');
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  const policy = formatExcerpts(aiPolicyExcerpts(mirror)).slice(0, 3000);
  return [
    `repo: ${repo}  language: ${info.language}  stars: ${info.stars}  default branch: ${info.defaultBranch}  archived: ${info.archived}`,
    `description: ${info.description}`,
    `license: ${info.license}`,
    `last 50 PRs: ${fromForks.length} from forks, ${merged.length} merged, ${open.length} still open, merge rate of decided fork PRs ${closed ? Math.round(merged.length / closed * 100) : 0}%`,
    `bots that review PRs: ${[...bots].join(', ') || 'none seen'}`,
    `open issues (first ${issues.length}): ${assigned} assigned; labels: ${topLabels || 'none'}`,
    `files present: ${files.join(', ') || 'none of the usual ones'}`,
    `workflows: ${workflows.join(', ') || 'none'}`,
    policy ? `AI/contribution policy excerpts:\n${policy}` : 'AI/contribution policy excerpts: none found',
  ].join('\n');
}

export async function addRepo(ctx: Ctx, input: string, opts: { configPath: string; yes: boolean }): Promise<string> {
  const { cfg, db } = ctx;
  const repo = parseRepoArg(input);
  const name = repo.split('/')[1];
  const fork = `${cfg.github_user}/${name}`;
  if (cfg.repos.some((r) => r.full_name === repo)) throw new Error(`${repo} is already configured (${repoFile(repo, opts.configPath)})`);
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

  log(`${repo}: reading GitHub`);
  const info = await gh.repoInfo(repo);
  if (info.archived) throw new Error(`${repo} is archived`);
  log(`${repo}: mirroring ${info.defaultBranch}`);
  await ensureMirror(repo, info.defaultBranch);
  const mirror = mirrorDir(repo);
  const facts = await gatherFacts(repo, mirror);

  log(`${repo}: scout agent drafts the config`);
  const scout = await runAgent(ctx, {
    agent: 'scout', issueId: null, workdir: mirror, readOnly: true,
    vars: { repo, facts, github_user: cfg.github_user },
  });
  // Most common disclosure string among the configured repos, so new ones read the same.
  const disclosure = [...cfg.repos.reduce((m, r) => m.set(r.agent_disclosure, (m.get(r.agent_disclosure) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'GitHub Copilot CLI';
  const draft = normalizeScoutConfig(scout.config);
  let rc: RepoConfig;
  try {
    rc = RepoConfigSchema.parse({
      agent_disclosure: disclosure, ...draft, full_name: repo, fork, default_branch: (draft.default_branch as string | undefined) ?? info.defaultBranch,
    });
  } catch (e) {
    throw new Error(`the scout's config does not fit the schema: ${(e as Error).message}\n\nits draft:\n${stringify(draft)}`);
  }

  // Prove the gate runs in the sandbox; let the doctor agent repair it, twice at most.
  let report = '';
  for (let round = 0; ; round++) {
    const p = await probeRepo(ctx, rc, log);
    report = `gate on ${rc.default_branch} @ ${p.sha.slice(0, 10)}, scope = ${p.sampleLine}\n${formatSteps(p.steps, p.focused, !p.focused)}`;
    const failed = [...p.steps, ...(p.focused ? [p.focused] : [])].filter((s) => !s.ok);
    if (!failed.length || round === 2) { if (failed.length) report += `\n  (${failed.length} step(s) still fail; fix by hand or with repo doctor --fix)`; break; }
    log(`${repo}: ${failed.length} gate step(s) fail on the base, asking the doctor agent (round ${round + 1})`);
    const fix = await runAgent(ctx, {
      agent: 'doctor', issueId: null, workdir: p.dir, readOnly: true,
      vars: { repo, gate_json: JSON.stringify(rc.gate, null, 1), focused_test: rc.focused_test, failures: failed.map((s) => `$ ${s.cmd}\n${s.excerpt}`).join('\n\n'), repo_notes: rc.notes.trim() },
    });
    rc = { ...rc, gate: fix.gate, focused_test: fix.focused_test, notes: fix.notes_append.trim() ? `${rc.notes.trimEnd()}\n${fix.notes_append.trim()}\n` : rc.notes };
  }

  const yaml = stringify(rc, { lineWidth: 0 });
  console.log(`\n${'='.repeat(78)}\n${scout.summary.trim()}\n`);
  if (scout.risks.length) console.log(`risks:\n${scout.risks.map((r) => `  - ${r}`).join('\n')}\n`);
  console.log(`${report}\n\n--- ${repoFile(repo, opts.configPath)}\n${yaml}`);

  let answer = opts.yes ? 'y' : '';
  while (!answer) {
    if (!process.stdin.isTTY) throw new Error('not a terminal; pass --yes to accept the proposal as is');
    answer = (await ask('write this config and fork the repo? [y]es / [n]o / [e]dit first: ')).toLowerCase();
    if (answer === 'e') {
      const tmp = join(WORK(repo), '_onboard.yaml');
      writeFileSync(tmp, yaml);
      editInEditor(tmp);
      try { rc = RepoConfigSchema.parse(parse(readFileSync(tmp, 'utf8'))); } catch (e) { console.log(`invalid: ${(e as Error).message}`); }
      answer = '';
    } else if (answer !== 'y' && answer !== 'n') answer = '';
  }
  if (answer === 'n') return 'nothing written';

  if (!(await gh.repoExists(fork))) { log(`forking ${repo} to ${fork}`); await gh.forkRepo(repo); }
  writeRepoConfig(rc, opts.configPath);
  db.upsertRepo(repo, fork);
  db.setRepoPolicy(repo, 'allowed', formatExcerpts(aiPolicyExcerpts(mirror)));
  db.setRepoStatus(repo, 'active');
  const steps = scout.manual_steps.length ? `\nbefore the first PR, by hand:\n${scout.manual_steps.map((s) => `  - ${s}`).join('\n')}` : '';
  return `${repo} added (${repoFile(repo, opts.configPath)}).${steps}\n\nnext: oss-bot run --repo ${repo} --triage-only`;
}

export async function removeRepo(ctx: Ctx, input: string, opts: { configPath: string; yes: boolean }): Promise<string> {
  const { db } = ctx;
  const repo = parseRepoArg(input);
  const file = repoFile(repo, opts.configPath);
  const row = db.repo(repo);
  const issues = db.issuesForRepo(repo);
  // Every PR the bot follows belongs to a configured repo: wait until they are merged or closed.
  const open = issues.map((i) => db.prForIssue(i.id)).filter((p) => p?.state === 'open');
  if (open.length) {
    throw new Error(`${repo} still has open PRs: ${open.map((p) => p!.url).join(' ')}\n`
      + 'Remove it once they are merged or closed (the bot keeps following them until then).');
  }
  const plan = [
    existsSync(file) ? `delete ${file}` : `(no ${file}; cleaning up what is left)`,
    `delete ${issues.length} issue record(s)`,
    `delete work/${slug(repo)} and the mirror`,
  ];
  console.log(plan.map((p) => `  - ${p}`).join('\n'));
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error('not a terminal; pass --yes');
    if (!/^y(es)?$/i.test(await ask('proceed? [y/N] '))) return 'nothing removed';
  }
  if (existsSync(file)) unlinkSync(file);
  for (const i of issues) db.deleteIssue(i.id);
  db.deleteRepo(repo);
  rmSync(WORK(repo), { recursive: true, force: true });
  rmSync(mirrorDir(repo), { recursive: true, force: true });
  const fork = row?.fork;
  return `${repo} removed.${fork ? `\nThe fork stays until you delete it yourself:  gh repo delete ${fork} --yes` : ''}`;
}

export function listRepos(cfg: Config, db: Ctx['db']): string {
  const rows = cfg.repos.map((rc) => {
    const r = db.repo(rc.full_name);
    const blocked = db.blockedIssues(rc.full_name).length;
    return {
      repo: rc.full_name, status: r?.status ?? 'new', policy: r?.policy_status ?? '-',
      'in flight': db.inFlightCount(rc.full_name), 'open PRs': db.openPrCount(rc.full_name),
      gate: blocked ? `broken (${blocked} blocked)` : 'ok', scanned: r?.last_scanned?.slice(0, 16) ?? '-',
    };
  });
  return rows.length ? rows.map((r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  ')).join('\n') : '(no repos; oss-bot repo add <url>)';
}
