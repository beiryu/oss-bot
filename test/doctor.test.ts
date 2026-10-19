import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, writeRepoConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { focusedProbe, formatSteps } from '../src/doctor.js';
import { looksLikeEnvFailure, probeCommand } from '../src/gate.js';

const repo = (full_name: string, extra = '') => `full_name: ${full_name}\nfork: me/${full_name.split('/')[1]}\n`
  + `focused_test: "go test ./{{pkg}} -run '^{{test}}$'"\nagent_disclosure: x\n${extra}`;

describe('environment vs code failures', () => {
  it('recognises a runner that could not start', () => {
    expect(looksLikeEnvFailure('get provider: rootless Docker not found, failed to create Docker provider')).toBe(true);
    expect(looksLikeEnvFailure('FAIL\tgithub.com/x/y [build failed]')).toBe(true);
    expect(looksLikeEnvFailure('--- FAIL: TestDecryptShortInput (0.00s)\n    want error, got nil')).toBe(false);
  });
  it('swaps only test-name variables in the probe command', () => {
    const rc = { focused_test: "go test ./{{pkg}} -run '^{{test}}$'" } as never;
    const issue = { test_vars: JSON.stringify({ pkg: 'internal/x', test: 'TestA' }) } as never;
    expect(probeCommand(rc, issue)).toBe("go test ./internal/x -run '^OssBotNoSuchTest$'");
    expect(probeCommand(rc, { test_vars: JSON.stringify({ pkg: 'internal/x' }) } as never)).toBeNull();
  });
  it('probes focused_test in doctor only when every variable is a test name', () => {
    expect(focusedProbe({ focused_test: "./gradlew test --tests {{testClass}}" } as never)).toBe('./gradlew test --tests OssBotNoSuchTest');
    expect(focusedProbe({ focused_test: "go test ./{{pkg}} -run {{test}}" } as never)).toBeNull();
  });
  it('formats the report with excerpts for failed steps only', () => {
    const out = formatSteps([
      { cmd: 'go build ./...', ok: true, secs: 12, timedOut: false, excerpt: '' },
      { cmd: 'go test ./x', ok: false, secs: 3, timedOut: false, excerpt: 'Docker not found' },
    ], null, true);
    expect(out).toContain('[ok]   12s  go build ./...');
    expect(out).toContain('[FAIL]    3s  go test ./x\n        Docker not found');
    expect(out).toContain('focused_test not probed');
  });
});

describe('blocked issues', () => {
  it('are left out of nextIssues until cleared', () => {
    const db = new Db(':memory:');
    db.upsertRepo('o/r', 'me/r');
    db.insertDiscovered({ repo: 'o/r', number: 1, title: 't', body: '', url: 'u' });
    const id = db.issueByNumber('o/r', 1)!.id;
    db.transition(id, 'coded');
    expect(db.nextIssues().map((i) => i.id)).toEqual([id]);
    db.update(id, { blocked: 'gate broken on base: go test ./x' });
    expect(db.nextIssues()).toEqual([]);
    expect(db.blockedIssues('o/r')).toHaveLength(1);
    expect(db.clearBlocked('o/r')).toBe(1);
    expect(db.nextIssues().map((i) => i.id)).toEqual([id]);
  });
  it('go back to claimed when released onto a new head, unless already in a PR or on that head', () => {
    const db = new Db(':memory:');
    db.upsertRepo('o/r', 'me/r');
    const add = (n: number, state: 'coded' | 'pr_open', base: string) => {
      db.insertDiscovered({ repo: 'o/r', number: n, title: 't', body: '', url: 'u' });
      const id = db.issueByNumber('o/r', n)!.id;
      db.transition(id, state, { base_sha: base, blocked: 'gate broken on base: go list ./...' });
      return id;
    };
    const stale = add(1, 'coded', 'old'), current = add(2, 'coded', 'new'), inPr = add(3, 'pr_open', 'old');
    expect(db.clearBlocked('o/r', 'new')).toBe(3);
    expect([stale, current, inPr].map((id) => db.issue(id).state)).toEqual(['claimed', 'coded', 'pr_open']);
    expect(db.blockedIssues('o/r')).toEqual([]);
  });
});

describe('repos/*.yaml', () => {
  it('are merged into the config, and win over an inline block for the same repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oss-bot-cfg-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, `github_user: me\nlimits: {}\nbudget: {}\nsandbox: {}\nrepos:\n  - ${repo('a/inline').replace(/\n(?=.)/g, '\n    ')}  - ${repo('a/both', 'notes: from config.yaml\n').replace(/\n(?=.)/g, '\n    ')}`);
    mkdirSync(join(dir, 'repos'));
    writeFileSync(join(dir, 'repos', 'a__both.yaml'), repo('a/both', 'notes: from file\n'));
    writeFileSync(join(dir, 'repos', 'b__file.yaml'), repo('b/file'));
    const cfg = loadConfig(cfgPath);
    expect(cfg.repos.map((r) => r.full_name).sort()).toEqual(['a/both', 'a/inline', 'b/file']);
    expect(cfg.repos.find((r) => r.full_name === 'a/both')!.notes).toBe('from file');
  });
  it('writeRepoConfig round-trips through loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oss-bot-cfg-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, 'github_user: me\nlimits: {}\nbudget: {}\nsandbox: {}\n');
    const rc = loadConfig(join(dir, 'config.yaml')).repos; expect(rc).toEqual([]);
    const one = { ...loadConfigRepo(repo('me/x', 'gate: ["go vet ./..."]\nsignoff: true\n')) };
    writeRepoConfig(one, cfgPath);
    const back = loadConfig(cfgPath).repos[0];
    expect(back.gate).toEqual(['go vet ./...']);
    expect(back.signoff).toBe(true);
  });
});

function loadConfigRepo(yamlText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oss-bot-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), 'github_user: me\nlimits: {}\nbudget: {}\nsandbox: {}\n');
  mkdirSync(join(dir, 'repos'));
  writeFileSync(join(dir, 'repos', 'x.yaml'), yamlText);
  return loadConfig(join(dir, 'config.yaml')).repos[0];
}

describe('worktreeFrom', () => {
  it('keeps HEAD but gives files their old content, so the diff names the files', async () => {
    const { execa } = await import('execa');
    const { worktreeFrom } = await import('../src/git.js');
    const dir = mkdtempSync(join(tmpdir(), 'oss-bot-wt-'));
    const g = (...a: string[]) => execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    await g('init', '-q');
    writeFileSync(join(dir, 'a.go'), 'package a // v1\n');
    await g('add', '-A'); await g('commit', '-qm', 'base');
    writeFileSync(join(dir, 'a.go'), 'package a // v2\n');
    writeFileSync(join(dir, 'b.go'), 'package a\n');
    await g('add', '-A'); await g('commit', '-qm', 'fix');
    await worktreeFrom(dir, 'HEAD~1');
    const names = (await g('diff', 'HEAD', '--name-status')).stdout.split('\n').sort();
    expect(names).toEqual(['D\tb.go', 'M\ta.go']);
    expect(readFileSync(join(dir, 'a.go'), 'utf8')).toBe('package a // v1\n');
    expect((await g('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).not.toBe('HEAD~1');
  });
});
