import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config } from './config.js';

export interface SandboxRun {
  dir: string;                 // host dir mounted at /work
  readOnly?: boolean;
  outDir?: string;             // host dir mounted at /out (runtime outputs)
  cmd: string[];               // command run inside the container
  env?: Record<string, string>;
  timeoutMin: number;
}

/** Environment for the docker client process: the host's plus the run's variables. */
export function sandboxEnv(run: Pick<SandboxRun, 'env'>): NodeJS.ProcessEnv {
  return { ...process.env, ...(run.env ?? {}) };
}

export function dockerArgs(cfg: Config, run: SandboxRun, name?: string): string[] {
  const args = [
    'run', '--rm', '-i', ...(name ? ['--name', name] : []),
    '--memory', cfg.sandbox.memory, '--cpus', cfg.sandbox.cpus,
    '--pids-limit', '2048',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,src=${resolve(run.dir)},dst=/work${run.readOnly ? ',readonly' : ''}`,
    '--mount', `type=volume,src=${cfg.sandbox.cache_volume},dst=/home/bot/.cache-vol`,
  ];
  if (run.outDir) args.push('--mount', `type=bind,src=${resolve(run.outDir)},dst=/out`);
  // Name only: docker copies the value from its own environment, so secrets never appear
  // in the process list. Callers pass the values to execa via sandboxEnv().
  for (const k of Object.keys(run.env ?? {})) args.push('-e', k);
  args.push(cfg.sandbox.image, ...run.cmd);
  return args;
}

/**
 * Runs a container with the run's timeout. Killing the docker client on timeout leaves the
 * container running, still burning CPU next to later runs, so it is removed by name.
 */
export async function execSandbox(cfg: Config, run: SandboxRun, opts: { all?: boolean } = {}) {
  const name = `oss-bot-${randomUUID().slice(0, 12)}`;
  const r = await execa('docker', dockerArgs(cfg, run, name), {
    reject: false, all: opts.all, timeout: run.timeoutMin * 60_000, env: sandboxEnv(run),
  });
  if (r.timedOut || r.isTerminated) await execa('docker', ['rm', '-f', name], { reject: false });
  return r;
}

/** Runs a shell command in a throwaway container with no credentials at all. */
export async function runInSandbox(cfg: Config, dir: string, shell: string, timeoutMin = cfg.sandbox.gate_timeout_min) {
  const r = await execSandbox(cfg, { dir, cmd: ['bash', '-lc', shell], timeoutMin }, { all: true });
  const all = r.all ?? '';
  return { exitCode: r.exitCode ?? -1, timedOut: r.timedOut, output: failureExcerpt(all), full: all };
}

// Lines that say what actually broke, across the build tools we run (go test, pytest, make).
const FAILURE = /--- FAIL|^FAIL\b|panic:|WARNING: DATA RACE|\.(go|java|kt|ts|js):\d+|error:|Error:|BUILD FAILED|What went wrong|FAILED$|make: \*\*\*|exit status \d/;

/**
 * Verbose test runs print thousands of PASS lines, so a plain tail loses the failure.
 * Keep each failure line with a little context, then the last lines of the run.
 */
export function failureExcerpt(text: string, maxLines = 200): string {
  const lines = text.split('\n');
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (FAILURE.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
  });
  const hits = [...keep].sort((a, b) => a - b).slice(0, maxLines - 40);
  const out: string[] = [];
  let prev = -2;
  for (const i of hits) { if (i !== prev + 1) out.push('...'); out.push(lines[i]); prev = i; }
  const end = tail(text, maxLines - out.length);
  return out.length ? `${out.join('\n')}\n... (end of output)\n${end}` : end;
}

export function tail(text: string, lines: number): string {
  const parts = text.split('\n');
  return parts.slice(-lines).join('\n');
}
