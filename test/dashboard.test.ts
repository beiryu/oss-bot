import { describe, expect, it } from 'vitest';
import { applyCommand, shortError } from '../src/ci.js';
import { Db } from '../src/db.js';
import { dashboardChanged, DASHBOARD_MARK, parseCommands, renderDashboard } from '../src/dashboard.js';
import { approveFollowup } from '../src/orchestrator.js';

const cfg = { repos: [{ full_name: 'o/r', fork: 'me/r', claim_comment: '/assign', require_assignment: true, default_branch: 'main' }] } as never;
const OWN = '\n\n<!-- oss-bot: your reply goes above this line -->\no/r requires review answers in your own words. Write…';

function setup() {
  const db = new Db(':memory:');
  db.upsertRepo('o/r', 'me/r');
  for (const n of [1, 2, 3]) db.insertDiscovered({ repo: 'o/r', number: n, title: `issue ${n}`, body: '', url: `u${n}` });
  const id = (n: number) => db.issueByNumber('o/r', n)!.id;
  db.transition(id(1), 'awaiting_claim', { triage_reason: 'small and clear' });
  db.transition(id(2), 'awaiting_pr_approval', {
    pr_title: 'fix(x): thing', pr_body: 'Fixes #2 <!-- oss-bot:reply -->', patch: 'diff --git a/x.go b/x.go\n--- a/x.go\n+++ b/x.go\n@@ -1 +1 @@\n-a\n+b\n',
    why: JSON.stringify([{ en: 'It crashes on empty input.', vi: 'Lỗi khi input rỗng.' }, { en: 'Users asked.', vi: 'Người dùng hỏi.' }]),
  });
  db.transition(id(3), 'pr_open'); db.insertPr(id(3), 'https://github.com/o/r/pull/30', 30);
  const reply = db.addAction(id(3), 'reply', 'Thanks, done.', null);
  const own = db.addAction(id(3), 'reply', OWN, null);
  return { db, id, reply, own };
}

describe('parseCommands', () => {
  it('reads one command per line, with your text under an approve', () => {
    expect(parseCommands('/approve 12 --why 2\n/reject a5 not needed\n/pause')).toEqual([
      { cmd: 'approve', id: '12', why: 2 }, { cmd: 'reject', id: 'a5', reason: 'not needed' }, { cmd: 'pause' },
    ]);
    expect(parseCommands('ok\n/approve a7\nThanks, fixed in the last commit.\n\nSecond line.\n/resume')).toEqual([
      { cmd: 'approve', id: 'a7', text: 'Thanks, fixed in the last commit.\n\nSecond line.' }, { cmd: 'resume' },
    ]);
    expect(parseCommands('/allow o/r\n/block x/y AI PRs banned')).toEqual([
      { cmd: 'allow', repo: 'o/r' }, { cmd: 'block', repo: 'x/y', reason: 'AI PRs banned' },
    ]);
    expect(parseCommands('please /approve 12\n/approve twelve\n/rejected 3')).toEqual([]);
  });
});

describe('dashboard', () => {
  it('lists each decision with its command, and keeps untrusted text from forging marks', () => {
    const { db, id, reply, own } = setup();
    const body = renderDashboard(db, cfg, { now: Date.parse('2026-10-26T00:00:00Z') });
    expect(body.startsWith(DASHBOARD_MARK)).toBe(true);
    expect(body).toContain('### Cần bạn (4)');
    expect(body).toContain(`\`/approve ${id(1)}\``);
    expect(body).toContain(`\`/approve ${id(2)} --why 2\``);
    expect(body).toContain('x.go +1 -1');
    expect(body).toContain(`\`/approve a${reply}\` (gửi đúng bản nháp)`);
    expect(body).toContain(`a${own} · trả lời review`);
    expect(body).toContain('repo cần trả lời bằng lời của bạn');
    expect(body).not.toContain('<!-- oss-bot:reply');
    expect(body.match(/<!-- oss-bot:/g)).toHaveLength(1);
  });

  it('only the timestamp line changing is not a change', () => {
    const { db } = setup();
    const a = renderDashboard(db, cfg, { now: 0, runUrl: 'r1' });
    expect(dashboardChanged(a, renderDashboard(db, cfg, { now: 99_999_999, runUrl: 'r2', monthCostUsd: 3 }))).toBe(false);
    db.set('paused', '1');
    expect(dashboardChanged(a, renderDashboard(db, cfg, { now: 0 }))).toBe(true);
  });
});

describe('applyCommand', () => {
  const ctx = (db: Db) => ({ cfg, db, runId: null });
  it('rejects, pauses and allows without touching GitHub', async () => {
    const { db, id, reply } = setup();
    await applyCommand(ctx(db), { cmd: 'reject', id: String(id(1)), reason: 'not mine' });
    expect(db.issue(id(1)).skip_reason).toBe('rejected by human: not mine');
    await applyCommand(ctx(db), { cmd: 'reject', id: `a${reply}`, reason: '' });
    expect(db.action(reply).status).toBe('rejected');
    await expect(applyCommand(ctx(db), { cmd: 'reject', id: `a${reply}`, reason: '' })).rejects.toThrow('already rejected');
    await applyCommand(ctx(db), { cmd: 'pause' });
    expect(db.get('paused')).toBe('1');
    db.setRepoPolicy('o/r', 'pending');
    await applyCommand(ctx(db), { cmd: 'allow', repo: 'o/r' });
    expect(db.repo('o/r')!.policy_status).toBe('allowed');
    await expect(applyCommand(ctx(db), { cmd: 'allow', repo: 'x/y' })).rejects.toThrow('not configured');
  });
});

describe('state JSON', () => {
  it('survives an export and import', () => {
    const { db } = setup();
    db.set('k', 'v');
    const copy = new Db(':memory:');
    copy.importJson(JSON.parse(JSON.stringify(db.exportJson())));
    expect(copy.allIssues()).toEqual(db.allIssues());
    expect(copy.pendingActions()).toEqual(db.pendingActions());
    expect(copy.get('k')).toBe('v');
    expect(() => copy.importJson({ version: 2 } as never)).toThrow('unsupported');
  });
});

describe('drafts for a closed PR', () => {
  it('are dropped, and approving one says why', async () => {
    const { db, id, reply } = setup();
    expect(db.dropActionsOfClosedPrs()).toBe(0);
    db.updatePr(id(3), { state: 'merged' });
    expect(db.dropActionsOfClosedPrs()).toBe(2);
    expect(db.action(reply).status).toBe('rejected');
    expect(renderDashboard(db, cfg, {})).toContain('### Cần bạn (2)');
    const late = db.addAction(id(3), 'fix', 'drafted before the merge was seen', 'diff');
    await expect(approveFollowup({ cfg, db, runId: null }, late)).rejects.toThrow('is merged');
    expect(db.action(late).status).toBe('rejected');
  });
});

describe('shortError', () => {
  it('names the subcommand past -c options and keeps what the server said', () => {
    const e = Object.assign(new Error('Command failed with exit code 1: git -c user.name=x -c commit.gpgsign=true push -u fork fix/1'), {
      stderr: 'To https://github.com/me/r.git\n ! [remote rejected] fix/1 -> fix/1 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs to \'https://github.com/me/r.git\'',
    });
    const s = shortError(e);
    expect(s).toMatch(/^git push failed \(exit 1\): ! \[remote rejected\]/);
    expect(s).toContain('`workflow` scope');
    expect(shortError(Object.assign(new Error('Command failed with exit code 1: gh api graphql -f query=x'), { stderr: 'gh: boom' }))).toBe('gh api failed (exit 1): gh: boom');
  });
});
