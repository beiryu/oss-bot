import { execa } from 'execa';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { issueDir } from './git.js';

// Clones an issue keeps while it is in flight; each is a full checkout (50-200 MB).
const CLONES = ['agent', 'gate-base', 'gate-fix', 'review', 'push', 'rebase', 'after-commit'];
const FINISHED = new Set(['skipped', 'done', 'closed']);

/** Deletes the checkouts of finished issues; their logs and PATCH.diff (a few KB) stay for `show`. */
export function pruneFinishedClones(db: Db): number {
  let n = 0;
  for (const i of db.allIssues()) {
    if (!FINISHED.has(i.state)) continue;
    const dir = issueDir(i.repo, i.number);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      if (CLONES.includes(d)) { rmSync(join(dir, d), { recursive: true, force: true }); n++; }
    }
  }
  // `repo doctor` / `repo add` probe checkouts are only read while those commands run.
  if (existsSync('work')) {
    for (const r of readdirSync('work')) {
      const d = join('work', r, '_doctor');
      if (existsSync(d)) { rmSync(d, { recursive: true, force: true }); n++; }
    }
  }
  return n;
}

// Disk upkeep after each run. Docker under Colima keeps its data on a sparse file on the Mac
// that only grows: files deleted inside the VM stay allocated on the Mac until the VM's disk
// is trimmed. The Go build cache in the shared volume also grows with every repo built.

const GOCACHE = '/home/bot/.cache-vol/go/build';

async function cacheBytes(cfg: Config): Promise<number> {
  const r = await execa('docker', ['run', '--rm', '--mount', `type=volume,src=${cfg.sandbox.cache_volume},dst=/home/bot/.cache-vol`,
    cfg.sandbox.image, 'bash', '-c', `du -sb ${GOCACHE} 2>/dev/null | cut -f1 || echo 0`], { reject: false });
  return Number(r.stdout.trim()) || 0;
}

/**
 * Drops the least recently used build output until the cache is back to 3/4 of the limit.
 * Go refreshes an entry's mtime when it reuses it, so the oldest mtimes are what no recent
 * build needed; emptying the whole cache instead made the next build of every repo cold.
 */
async function trimGoCache(cfg: Config, bytes: number): Promise<number> {
  const over = Math.ceil(bytes - cfg.limits.max_go_build_cache_gb * 2 ** 30 * 0.75);
  const r = await execa('docker', ['run', '--rm', '--mount', `type=volume,src=${cfg.sandbox.cache_volume},dst=/home/bot/.cache-vol`,
    cfg.sandbox.image, 'bash', '-c',
    `find ${GOCACHE} -type f -name '*-[ad]' -printf '%T@ %s %p\\n' | sort -n `
    + `| awk -v over=${over} 'freed >= over { exit } { print $3; freed += $2 } END { print freed > "/dev/stderr" }' `
    + '| xargs -r rm -f'], { reject: true });
  return Number(r.stderr.trim().split('\n').pop()) || 0;
}

/** Trims the Go build cache when it is over the limit, then trims Colima's disk. Never throws. */
export async function housekeeping(cfg: Config, db: Db, log: (m: string) => void): Promise<string[]> {
  const done: string[] = [];
  const pruned = pruneFinishedClones(db);
  if (pruned) done.push(`removed ${pruned} checkout(s) of finished issues and doctor probes`);
  try {
    const gb = (await cacheBytes(cfg)) / 2 ** 30;
    if (gb > cfg.limits.max_go_build_cache_gb) {
      // Modules (go/mod) stay: re-downloading them is the slow part. Build output recompiles.
      const freed = await trimGoCache(cfg, gb * 2 ** 30);
      done.push(`Go build cache ${gb.toFixed(1)} GB > ${cfg.limits.max_go_build_cache_gb} GB, `
        + `dropped ${(freed / 2 ** 30).toFixed(1)} GB least recently used`);
    }
  } catch (e) {
    log(`housekeeping: Go cache check failed: ${(e as Error).message.split('\n')[0]}`);
  }
  try {
    // Only meaningful with Colima; elsewhere `colima` is missing and this is skipped.
    const r = await execa('colima', ['ssh', '--', 'sudo', 'fstrim', '/mnt/lima-colima'], { reject: false, timeout: 300_000 });
    if (r.exitCode === 0) done.push('Colima disk trimmed');
  } catch { /* no colima */ }
  for (const d of done) log(`housekeeping: ${d}`);
  return done;
}
