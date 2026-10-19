import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { isFeedback, type PrComment } from '../src/github.js';

function setup() {
  const db = new Db(':memory:');
  db.upsertRepo('o/r', 'me/r');
  for (const n of [1, 2, 3]) db.insertDiscovered({ repo: 'o/r', number: n, title: `t${n}`, body: '', url: '' });
  return db;
}

describe('Db', () => {
  it('ignores duplicate discoveries', () => {
    const db = setup();
    expect(db.insertDiscovered({ repo: 'o/r', number: 1, title: 'again', body: '', url: '' })).toBe(false);
    expect(db.issueByNumber('o/r', 1)!.title).toBe('t1');
  });

  it('picks active issues by score and counts in-flight ones', () => {
    const db = setup();
    const [a, b, c] = [1, 2, 3].map((n) => db.issueByNumber('o/r', n)!);
    db.transition(a.id, 'claimed', { score: 0.7 });
    db.transition(b.id, 'gated', { score: 0.9 });
    db.transition(c.id, 'awaiting_pr_approval', { score: 1 });
    expect(db.nextIssues().map((i) => i.number)).toEqual([2, 1]);
    expect(db.inFlightCount('o/r')).toBe(3);
    db.setRepoStatus('o/r', 'paused');
    expect(db.nextIssues()).toEqual([]);
  });

  it('skips with a reason', () => {
    const db = setup();
    const i = db.skip(db.issueByNumber('o/r', 1)!.id, 'nope');
    expect([i.state, i.skip_reason]).toEqual(['skipped', 'nope']);
  });

  it('sums cost per run and window', () => {
    const db = setup();
    const call = { issueId: null, agent: 'triage', durationMs: 1, inputTokens: 1, outputTokens: 1, ok: true, resultJson: '{}' };
    db.recordCall({ ...call, runId: 'r1', startedAt: new Date().toISOString(), costUsd: 1.5 });
    db.recordCall({ ...call, runId: 'r2', startedAt: new Date().toISOString(), costUsd: 0.5 });
    db.recordCall({ ...call, runId: 'r0', startedAt: '2020-01-01T00:00:00.000Z', costUsd: 9 });
    expect(db.costForRun('r1')).toBe(1.5);
    expect(db.costSince(new Date(Date.now() - 86_400_000).toISOString())).toBe(2);
  });
});

describe('triagePriority', () => {
  it('puts bug reports before feature requests', async () => {
    const { triagePriority } = await import('../src/orchestrator.js');
    expect(triagePriority({ title: 'review hangs on stalled LLM request' })).toBe(2);
    expect(triagePriority({ title: 'bug(session): list prints null' })).toBe(2);
    expect(triagePriority({ title: 'feat(rules): add POSIX shell rules' })).toBe(0);
    expect(triagePriority({ title: '[Feature Request] Support X' })).toBe(0);
    expect(triagePriority({ title: 'Make prompt contract configurable' })).toBe(1);
  });
});

describe('isFeedback', () => {
  const c = (author: string, kind: PrComment['kind'] = 'review-comment', createdAt = '2026-10-13T05:00:00Z'): PrComment =>
    ({ kind, author, body: 'x', createdAt });
  const since = '2026-10-13T04:00:00Z';
  it('keeps everything new that is not mine, bots included', () => {
    expect(isFeedback(c('alice', 'comment'), 'beiryu', since)).toBe(true);
    expect(isFeedback(c('gemini-code-assist[bot]'), 'beiryu', since)).toBe(true);
    expect(isFeedback(c('gemini-code-assist[bot]', 'review'), 'beiryu', since)).toBe(true);
    expect(isFeedback(c('CLAassistant', 'comment'), 'beiryu', since)).toBe(true);
  });
  it('drops my own and old comments', () => {
    expect(isFeedback(c('beiryu'), 'beiryu', since)).toBe(false);
    expect(isFeedback(c('alice', 'comment', '2026-10-13T03:00:00Z'), 'beiryu', since)).toBe(false);
  });
});
