import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fillTemplate, runAgent } from './agent.js';
import { type RepoConfig, repoFile, writeRepoConfig } from './config.js';
import { ensureMirror, freshClone, git, mirrorDir, slug } from './git.js';
import type { Ctx } from './orchestrator.js';
import { runInSandbox, tail } from './sandbox.js';

// `repo doctor`: does the configured gate run on the unpatched base inside the sandbox?
// Plain code decides pass/fail; an agent is only asked for a fix when `--fix` is given.

export interface StepResult { cmd: string; ok: boolean; secs: number; timedOut: boolean; excerpt: string }

const doctorDir = (repo: string) => join(dirname(dirname(mirrorDir(repo))), slug(repo), '_doctor');

/** The focused test with every test-name variable swapped for a name that does not exist, or null when other variables (package, module...) cannot be guessed. */
export function focusedProbe(rc: RepoConfig): string | null {
  const vars = [...rc.focused_test.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  if (!vars.length || vars.some((v) => !/test/i.test(v))) return null;
  return fillTemplate(rc.focused_test, Object.fromEntries(vars.map((v) => [v, 'OssBotNoSuchTest'])));
}

export async function probeRepo(ctx: Ctx, rc: RepoConfig, log: (m: string) => void) {
  const sha = await ensureMirror(rc.full_name, rc.default_branch);
  // The mirror holds only the branch tip; a few parents are needed for a sample change.
  await git(mirrorDir(rc.full_name), ['fetch', '-q', '--deepen', '10', 'origin', rc.default_branch]);
  const dir = doctorDir(rc.full_name);
  await freshClone(rc.full_name, sha, dir);
  // Gate steps take their scope from `git diff HEAD`, which is empty on a clean checkout. Use
  // the last few upstream commits as the sample change: HEAD moves back before them while the
  // files keep today's content, so the steps run on a real scope of the code a patch builds on.
  // (Giving the files their old content instead tested code from before a break on main.)
  let sampleLine = 'no sample change (history too shallow); diff-scoped steps run on nothing';
  for (let k = 8; k >= 1; k--) {
    if (!(await git(dir, ['rev-parse', '-q', '--verify', `HEAD~${k}^{commit}`]).catch(() => ''))) continue;
    await git(dir, ['reset', '-q', '--soft', `HEAD~${k}`]);
    const n = (await git(dir, ['diff', 'HEAD', '--name-only'])).split('\n').filter(Boolean).length;
    sampleLine = `the last ${k} commits (${n} files)`;
    break;
  }
  const run = async (cmd: string): Promise<StepResult> => {
    log(`doctor: ${cmd}`);
    const t = Date.now();
    const r = await runInSandbox(ctx.cfg, dir, cmd);
    return { cmd, ok: r.exitCode === 0, secs: Math.round((Date.now() - t) / 1000), timedOut: r.timedOut, excerpt: tail(r.output, 8) };
  };
  const steps: StepResult[] = [];
  for (const cmd of rc.gate) steps.push(await run(cmd));
  const probe = focusedProbe(rc);
  const focused = probe ? await run(probe) : null;
  return { sha, dir, steps, focused, sampleLine };
}

export function formatSteps(steps: StepResult[], focused: StepResult | null, probeSkipped: boolean): string {
  const line = (s: StepResult) => `  [${s.ok ? 'ok' : s.timedOut ? 'TIMEOUT' : 'FAIL'}] ${String(s.secs).padStart(4)}s  ${s.cmd}`
    + (s.ok ? '' : `\n${s.excerpt.split('\n').map((l) => `        ${l}`).join('\n')}`);
  const out = steps.map(line);
  if (focused) out.push(line(focused).replace(/\]\s/, '] focused_test: '));
  else if (probeSkipped) out.push('  [--] focused_test not probed: it has variables other than a test name');
  return out.join('\n');
}

export async function doctor(ctx: Ctx, rc: RepoConfig, opts: { fix: boolean; yes: boolean; configPath: string }): Promise<string> {
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const { sha, dir, steps, focused, sampleLine } = await probeRepo(ctx, rc, log);
  const failed = [...steps, ...(focused ? [focused] : [])].filter((s) => !s.ok);
  const report = `${rc.full_name} @ ${sha.slice(0, 10)}, scope = files of ${sampleLine}\n${formatSteps(steps, focused, !focused)}`;
  if (!failed.length) {
    const n = ctx.db.clearBlocked(rc.full_name, sha);
    return `${report}\n\ngate works on the base${n ? `; ${n} blocked issue(s) released` : ''}`;
  }
  if (!opts.fix) return `${report}\n\n${failed.length} step(s) fail on the base. Ask for a proposal: oss-bot repo doctor ${rc.full_name} --fix`;

  const r = await runAgent(ctx, {
    agent: 'doctor', issueId: null, workdir: dir, readOnly: true,
    vars: {
      repo: rc.full_name,
      gate_json: JSON.stringify(rc.gate, null, 1),
      focused_test: rc.focused_test,
      failures: failed.map((s) => `$ ${s.cmd}\n${s.excerpt}`).join('\n\n'),
      repo_notes: rc.notes.trim(),
    },
  });
  const next: RepoConfig = {
    ...rc, gate: r.gate, focused_test: r.focused_test,
    notes: r.notes_append.trim() ? `${rc.notes.trimEnd()}\n${r.notes_append.trim()}\n` : rc.notes,
  };
  const diff = [
    ...rc.gate.filter((g) => !r.gate.includes(g)).map((g) => `- ${g}`),
    ...r.gate.filter((g) => !rc.gate.includes(g)).map((g) => `+ ${g}`),
    ...(rc.focused_test !== r.focused_test ? [`- focused_test: ${rc.focused_test}`, `+ focused_test: ${r.focused_test}`] : []),
    ...(r.notes_append.trim() ? [`+ notes: ${r.notes_append.trim()}`] : []),
  ];
  if (!diff.length) return `${report}\n\nthe agent proposed no change:\n${r.explanation}`;
  console.log(`\n${report}\n\nproposal (${r.explanation.trim()}):\n${diff.join('\n')}\n`);

  let ok = opts.yes;
  if (!ok && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ok = /^y(es)?$/i.test((await rl.question(`write to ${repoFile(rc.full_name, opts.configPath)}? [y/N] `)).trim());
    rl.close();
  }
  if (!ok) return 'not written';
  const fresh = !existsSync(repoFile(rc.full_name, opts.configPath));
  writeRepoConfig(next, opts.configPath);
  const n = ctx.db.clearBlocked(rc.full_name);
  return `written${fresh ? ' (new file; delete the block in config.yaml if it still has one)' : ''}; `
    + `${n} blocked issue(s) released. Re-run \`oss-bot repo doctor ${rc.full_name}\` to confirm the new gate passes.`;
}
