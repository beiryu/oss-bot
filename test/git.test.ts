import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterPatch, parsePatch, readAgentFile } from '../src/git.js';

const block = (path: string, body = '@@ -1 +1 @@\n-a\n+b\n', extra = '') =>
  `diff --git a/${path} b/${path}\n${extra}index 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

describe('parsePatch', () => {
  it('splits files and counts lines', () => {
    const files = parsePatch(block('src/A.java') + block('test/ATest.java', '@@ -1 +1,2 @@\n a\n+b\n+c\n'));
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([['src/A.java', 1, 1], ['test/ATest.java', 2, 0]]);
  });
  it.each([
    ['.git/hooks/pre-push'],
    ['sub/.git/config'],
    ['../outside'],
    ['.oss-bot/PATCH.diff'],
  ])('rejects forbidden path %s', (p) => {
    expect(() => parsePatch(block(p))).toThrow(/forbidden path/);
  });
  it('rejects renames into .git', () => {
    expect(() => parsePatch(block('a.txt', '', 'similarity index 100%\nrename from a.txt\nrename to .git/hooks/x\n'))).toThrow();
  });
  it('rejects symlinks', () => {
    const p = 'diff --git a/link b/link\nnew file mode 120000\nindex 0..1\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n';
    expect(() => parsePatch(p)).toThrow(/symlink/);
  });
  it('rejects quoted paths', () => {
    expect(() => parsePatch('diff --git "a/x y" "b/x y"\n')).toThrow(/unsupported/);
  });
  it('filters to selected files', () => {
    const patch = block('src/A.java') + block('test/ATest.java');
    expect(parsePatch(filterPatch(patch, (p) => p.startsWith('test/'))).map((f) => f.path)).toEqual(['test/ATest.java']);
  });
});

describe('readAgentFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'oss-bot-'));
  const outside = mkdtempSync(join(tmpdir(), 'oss-bot-outside-'));
  writeFileSync(join(outside, 'secret'), 'top secret');
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'ok.txt'), 'fine');
  symlinkSync(join(outside, 'secret'), join(root, 'link'));
  symlinkSync(outside, join(root, 'dirlink'));

  it('reads regular files inside the root', () => {
    expect(readAgentFile(root, 'dir/ok.txt')).toBe('fine');
  });
  it('refuses a symlinked file', () => {
    expect(() => readAgentFile(root, 'link')).toThrow();
  });
  it('refuses a file behind a symlinked directory', () => {
    expect(() => readAgentFile(root, 'dirlink/secret')).toThrow();
  });
  it('refuses ../ escapes', () => {
    expect(() => readAgentFile(join(root, 'dir'), '../dir/../../' + outside.split('/').pop() + '/secret')).toThrow();
  });
});
