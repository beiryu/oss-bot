import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Every git command the host runs goes through here, and only ever in directories the
// host created and no agent has written to (mirror, fresh clones). These flags are a
// second line of defence in case that ever stops being true.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=always'];

export async function git(cwd: string, args: string[]) {
  const r = await execa('git', [...SAFE, ...args], { cwd });
  return r.stdout.trim();
}

const WORK = resolve('work');
export const slug = (repo: string) => repo.replace('/', '__');
export const mirrorDir = (repo: string) => join(WORK, '_mirror', slug(repo));
export const issueDir = (repo: string, n: number) => join(WORK, slug(repo), String(n));
export const agentDir = (repo: string, n: number) => join(issueDir(repo, n), 'agent');
export const AGENT_META = '.oss-bot';

/** Clones or refreshes the per-repo mirror; returns the default branch head. */
export async function ensureMirror(repo: string, branch: string): Promise<string> {
  const dir = mirrorDir(repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(WORK, '_mirror'), { recursive: true });
    // Only the branch tip: history is not needed and a smaller download survives flaky
    // connections. Long transfers over HTTP/2 sometimes get cut off; retry over HTTP/1.1.
    for (let attempt = 1; ; attempt++) {
      rmSync(dir, { recursive: true, force: true });
      const http = attempt > 1 ? ['-c', 'http.version=HTTP/1.1'] : [];
      try {
        await execa('git', [...SAFE, ...http, 'clone', '--depth', '1', '--branch', branch, `https://github.com/${repo}.git`, dir]);
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
  } else {
    await git(dir, ['fetch', '--prune', 'origin', branch]);
    await git(dir, ['reset', '--hard', `origin/${branch}`]);
    await git(dir, ['clean', '-fdx']);
  }
  return git(dir, ['rev-parse', 'HEAD']);
}

/** An independent clone of the mirror at `sha` (no hardlinks or alternates back to it). */
export async function freshClone(repo: string, sha: string, dest: string) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, '..'), { recursive: true });
  await execa('git', [...SAFE, 'clone', '--no-hardlinks', '--no-checkout', `file://${mirrorDir(repo)}`, dest]);
  await git(dest, ['checkout', '--quiet', '--detach', sha]);
}

/** Fresh clone for an agent, with a git-ignored scratch dir for prompts and outputs. */
export async function prepareAgentWorkdir(repo: string, n: number, sha: string): Promise<string> {
  const dir = agentDir(repo, n);
  await freshClone(repo, sha, dir);
  mkdirSync(join(dir, AGENT_META), { recursive: true });
  appendFileSync(join(dir, '.git', 'info', 'exclude'), `\n/${AGENT_META}/\n`);
  return dir;
}

/**
 * Reads a file from an agent-written directory. The agent controls that tree, so a
 * path could be a symlink to something on the host (e.g. ~/.ssh); refuse anything
 * that is not a regular file physically inside `root`.
 */
export function readAgentFile(root: string, rel: string): string {
  const full = resolve(root, rel);
  const realRoot = realpathSync(root);
  if (!lstatSync(full).isFile()) throw new Error(`${rel} is not a regular file`);
  const real = realpathSync(full);
  if (!real.startsWith(realRoot + sep)) throw new Error(`${rel} escapes the workdir`);
  return readFileSync(real, 'utf8');
}

export function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export interface PatchFile { path: string; added: number; removed: number; block: string }

/** Splits a `git diff` into per-file blocks and rejects anything we never want to apply. */
export function parsePatch(patch: string): PatchFile[] {
  if (!patch.trim()) return [];
  const blocks = patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  return blocks.map((block) => {
    const header = block.slice(0, block.indexOf('\n'));
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(header);
    if (!m) throw new Error(`unsupported diff header (quoted or unusual path): ${header}`);
    const paths = [m[1], m[2]];
    for (const line of block.split('\n')) {
      const r = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
      if (r) paths.push(r[1]);
      if (/^(new file mode|new mode|old mode) 120000/.test(line)) throw new Error(`patch adds a symlink: ${m[2]}`);
      if (/^(new file mode|new mode) 160000/.test(line)) throw new Error(`patch adds a submodule: ${m[2]}`);
    }
    for (const p of paths) {
      const segs = p.split('/');
      if (segs.includes('.git') || segs.includes('..') || segs[0] === AGENT_META || p.startsWith('/')) {
        throw new Error(`patch touches a forbidden path: ${p}`);
      }
    }
    let added = 0, removed = 0;
    for (const line of block.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { path: m[2], added, removed, block };
  });
}

export function filterPatch(patch: string, keep: (path: string) => boolean): string {
  return parsePatch(patch).filter((f) => keep(f.path)).map((f) => f.block).join('');
}

/** Applies a validated patch to a host-owned clone. */
/**
 * Gives every file in `dir` the content it has at `rev` while HEAD stays put, so `git diff HEAD`
 * still names the files that differ: a CI step that takes its scope from the diff then runs
 * that same scope on `rev`'s code. Files HEAD added disappear (they show as deleted).
 */
export async function worktreeFrom(dir: string, rev: string) {
  await git(dir, ['rm', '-rq', '.']);
  await git(dir, ['checkout', rev, '--', '.']);
}

/** Applies to index and worktree. `threeWay` lets git merge around moved context (rebases); it throws on a real conflict. */
export async function applyPatch(dir: string, patch: string, threeWay = false) {
  parsePatch(patch);
  const file = join(dir, '..', `${Date.now()}.patch`);
  writeFileSync(file, patch);
  try {
    await git(dir, ['apply', '--index', '--whitespace=nowarn', ...(threeWay ? ['--3way'] : []), file]);
  } finally {
    rmSync(file, { force: true });
  }
}
