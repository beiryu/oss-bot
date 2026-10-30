import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fillTemplate } from './agent.js';
import type { Config, RepoConfig } from './config.js';
import type { Issue } from './db.js';
import { agentDir, applyPatch, filterPatch, freshClone, git, issueDir, parsePatch, readAgentFile, sha256, worktreeFrom } from './git.js';
import { runInSandbox } from './sandbox.js';

// The gate is plain code: no LLM decides whether a change passes.

export type GateResult =
  | { ok: true }
  // 'environment': the same step fails on the unpatched base too (toolchain, network, a red
  // base), so it says nothing about the change. The pipeline then waits for `repo doctor`
  // instead of spending coder attempts on it.
  | { ok: false; reason: string; kind?: 'code' | 'environment'; step?: string };

// Output that means a command could not run at all, as opposed to a test that ran and failed.
const ENV_FAILURE = /\[build failed\]|\[setup failed\]|cannot find (package|module)|no required module|no Go files|command not found|No such file or directory|Docker not found|Cannot connect to the Docker|connection refused|permission denied|ModuleNotFoundError|ImportError|Could not resolve|ECONNREFUSED|ENOTFOUND|exit status 2\b/i;
export const looksLikeEnvFailure = (output: string) => ENV_FAILURE.test(output);

/**
 * The focused test command with the test name(s) swapped for one that does not exist. If
 * even that fails on the base, the test runner itself is broken there.
 */
export function probeCommand(repo: RepoConfig, issue: Issue): string | null {
  const vars: Record<string, string> = JSON.parse(issue.test_vars ?? '{}');
  let swapped = false;
  for (const k of Object.keys(vars)) if (/test/i.test(k)) { vars[k] = 'OssBotNoSuchTest'; swapped = true; }
  return swapped ? fillTemplate(repo.focused_test, vars) : null;
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['hard-coded credential', /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];

/** Checks that need only the patch text. */
export function staticChecks(patch: string, repo: RepoConfig): GateResult {
  let files;
  try {
    files = parsePatch(patch);
  } catch (e) {
    return { ok: false, reason: String((e as Error).message) };
  }
  if (files.length === 0) return { ok: false, reason: 'empty diff' };

  for (const f of files) {
    const under = (p: string) => f.path === p || f.path.startsWith(p.endsWith('/') ? p : `${p}/`);
    if (repo.forbidden_paths.some(under)) return { ok: false, reason: `touches forbidden path ${f.path}` };
    if (repo.allowed_paths.length && !repo.allowed_paths.some(under)) {
      return { ok: false, reason: `touches ${f.path}, outside allowed paths ${repo.allowed_paths.join(', ')}` };
    }
  }
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of added) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(line)) return { ok: false, reason: `diff looks like it contains a ${name}` };
    }
  }
  return { ok: true };
}

export function hashTestFiles(issue: Issue): Record<string, string> {
  const dir = agentDir(issue.repo, issue.number);
  const files: string[] = JSON.parse(issue.test_files ?? '[]');
  return Object.fromEntries(files.map((f) => [f, sha256(readAgentFile(dir, f))]));
}

/** '+' lines of `original` (per file) that are not '+' lines of `final` (multiset). */
export function missingAddedLines(original: string, final: string): string[] {
  const added = (p: string) => {
    const m = new Map<string, number>();
    for (const f of parsePatch(p)) {
      for (const l of f.block.split('\n')) {
        if (l.startsWith('+') && !l.startsWith('+++') && l.slice(1).trim()) {
          const k = `${f.path}\0${l.slice(1).trimEnd()}`;
          m.set(k, (m.get(k) ?? 0) + 1);
        }
      }
    }
    return m;
  };
  const have = added(final);
  const missing: string[] = [];
  for (const [k, n] of added(original)) {
    if ((have.get(k) ?? 0) < n) missing.push(k.replace('\0', ': '));
  }
  return missing;
}

/**
 * Agents sometimes give a package path relative to a sub-project ("pkg/action" for
 * "app/cli/pkg/action"). When a path variable names no test file's directory but is the tail of
 * exactly one, use that directory; the test runner would otherwise fail as if broken.
 */
export function repairPathVars(vars: Record<string, string>, testFiles: string[]): Record<string, string> {
  const dirs = [...new Set(testFiles.map((f) => dirname(f)))];
  const out = { ...vars };
  for (const [k, v] of Object.entries(vars)) {
    const p = v.replace(/^\.\//, '').replace(/\/$/, '');
    if (/test/i.test(k) || !p || /\s/.test(p) || dirs.some((d) => d === p || d.startsWith(`${p}/`))) continue;
    const hits = dirs.filter((d) => d.endsWith(`/${p}`));
    if (hits.length === 1) out[k] = v.startsWith('./') ? `./${hits[0]}` : hits[0];
  }
  return out;
}

export function focusedTestCommand(repo: RepoConfig, issue: Issue): string {
  const cmd = fillTemplate(repo.focused_test, JSON.parse(issue.test_vars ?? '{}'));
  if (/\{\{\w+\}\}/.test(cmd)) throw new Error(`focused_test has unfilled variables: ${cmd}`);
  return cmd;
}

export async function runGate(cfg: Config, repo: RepoConfig, issue: Issue, patch: string,
  log: (msg: string) => void = () => {}, opts: { rebase?: boolean } = {}): Promise<GateResult> {
  const fixed = staticChecks(patch, repo);
  if (!fixed.ok) return fixed;

  const testFiles = new Set<string>(JSON.parse(issue.test_files ?? '[]'));
  const dir = issueDir(issue.repo, issue.number);
  const fixDir = join(dir, 'gate-fix');
  const baseDir = join(dir, 'gate-base');
  // Issues without a regression test (docs, translations, new tests, small features) go
  // straight to the repo's own checks; the reviewer judges what the change says.
  if (testFiles.size) {
    const r = await checkRegressionTest(cfg, repo, issue, patch, testFiles, log, !!opts.rebase);
    if (!r.ok) return r;
  } else {
    await freshClone(issue.repo, issue.base_sha!, fixDir);
    await applyPatch(fixDir, patch);
  }

  for (const check of repo.gate) {
    log(`gate: ${check}`);
    const r = await runInSandbox(cfg, fixDir, check);
    if (r.exitCode === 0) continue;
    const logFile = join(dir, `gate-failure-${Date.now()}.log`);
    writeFileSync(logFile, `$ ${check}\n${r.full}`);
    const reason = `\`${check}\` failed${r.timedOut ? ' (timed out)' : ''}:\n${r.output}`;
    // Same step, same scope, unpatched code: a failure there is the environment, not the change.
    log('gate: same step on base');
    await baseWithFixScope(issue, patch, baseDir);
    const onBase = await runInSandbox(cfg, baseDir, check);
    if (onBase.exitCode !== 0) {
      writeFileSync(logFile, `$ ${check}\n${r.full}\n\n=== same step on base (${issue.base_sha}) ===\n${onBase.full}`);
      return { ok: false, kind: 'environment', step: check, reason: `\`${check}\` fails on the base too (see ${logFile}):\n${onBase.output}` };
    }
    return { ok: false, kind: 'code', step: check, reason };
  }
  return { ok: true };
}

/**
 * Base tree arranged so that `git diff HEAD` names the patch's files while every file keeps
 * its base content: the patch is committed on top of the base and the worktree set back.
 */
async function baseWithFixScope(issue: Issue, patch: string, baseDir: string) {
  if (!existsSync(join(baseDir, '.git'))) await freshClone(issue.repo, issue.base_sha!, baseDir);
  else { await git(baseDir, ['reset', '-q', '--hard']); await git(baseDir, ['clean', '-fdq']); }
  await applyPatch(baseDir, patch);
  await git(baseDir, ['-c', 'user.name=oss-bot', '-c', 'user.email=oss-bot@localhost', 'commit', '-q', '--no-verify', '-m', 'patched (scope comparison only)']);
  await worktreeFrom(baseDir, 'HEAD~1');
}

/** Steps for issues with a regression test: it is intact, fails on base, passes with the fix. */
async function checkRegressionTest(cfg: Config, repo: RepoConfig, issue: Issue, patch: string,
  testFiles: Set<string>, log: (msg: string) => void, rebase: boolean): Promise<GateResult> {
  // 1. Every line the reproducer added must still be there. The coder may add more tests
  // to the same files; weakening the reproducer's test is caught in step 2, where the
  // final version of these files must still fail on the original code.
  // A rebase merges the test with whatever upstream did to the same file (a shared license
  // header, imports), so its lines legitimately differ; steps 2 and 3 still hold it to account.
  const reproFile = join(issueDir(issue.repo, issue.number), 'REPRO.diff');
  if (rebase) {
    // nothing to compare
  } else if (existsSync(reproFile)) {
    const missing = missingAddedLines(readFileSync(reproFile, 'utf8'), filterPatch(patch, (p) => testFiles.has(p)));
    if (missing.length) {
      return { ok: false, reason: `the coder changed or removed lines of the reproducer test, e.g.:\n${missing.slice(0, 5).join('\n')}` };
    }
  } else {
    // Issues reproduced before REPRO.diff existed: fall back to whole-file hashes.
    const before: Record<string, string> = JSON.parse(issue.test_hashes ?? '{}');
    let after: Record<string, string>;
    try {
      after = hashTestFiles(issue);
    } catch (e) {
      return { ok: false, reason: `reproducer test file is gone or unreadable: ${(e as Error).message}` };
    }
    for (const [f, h] of Object.entries(before)) {
      if (after[f] !== h) return { ok: false, reason: `reproducer test ${f} was modified by the coder` };
    }
  }

  const testOnly = filterPatch(patch, (p) => testFiles.has(p));
  if (!testOnly) return { ok: false, reason: 'the diff does not include the reproducer test' };
  const cmd = focusedTestCommand(repo, issue);
  const base = issue.base_sha!;

  // 2. The test fails on the original code...
  const baseDir = join(issueDir(issue.repo, issue.number), 'gate-base');
  await freshClone(issue.repo, base, baseDir);
  await applyPatch(baseDir, testOnly);
  log(`gate: focused test on base: ${cmd}`);
  const onBase = await runInSandbox(cfg, baseDir, cmd);
  if (onBase.exitCode === 0) return { ok: false, reason: 'reproducer test passes without the fix' };
  // "Fails on base" must be the test failing, not the runner. When the output looks like a
  // broken setup, run the same command with a test name that does not exist: if that fails
  // too, nothing can run here and the issue waits for `repo doctor`.
  const probe = looksLikeEnvFailure(onBase.output) ? probeCommand(repo, issue) : null;
  if (probe) {
    // On the pristine base: the new test itself may not compile there (it can use API the fix
    // adds), and that still counts as failing on base.
    log('gate: test runner probe on base');
    await git(baseDir, ['reset', '-q', '--hard']);
    await git(baseDir, ['clean', '-fdq']);
    const p = await runInSandbox(cfg, baseDir, probe);
    if (p.exitCode !== 0) {
      const logFile = join(issueDir(issue.repo, issue.number), `gate-failure-${Date.now()}.log`);
      writeFileSync(logFile, `$ ${cmd}\n${onBase.full}\n\n=== probe ===\n$ ${probe}\n${p.full}`);
      return { ok: false, kind: 'environment', step: probe, reason: `the test runner fails on the base even with no test selected (see ${logFile}):\n${p.output}` };
    }
  }

  // 3. ...and passes with the fix, together with the repo's own checks.
  const fixDir = join(issueDir(issue.repo, issue.number), 'gate-fix');
  await freshClone(issue.repo, base, fixDir);
  await applyPatch(fixDir, patch);
  log('gate: focused test with fix');
  const onFix = await runInSandbox(cfg, fixDir, cmd);
  if (onFix.exitCode !== 0) return { ok: false, reason: `reproducer test still fails with the fix:\n${onFix.output}` };

  return { ok: true };
}
