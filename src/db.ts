import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATES = [
  'discovered', 'triaged', 'awaiting_claim', 'claimed', 'reproduced', 'coded',
  'gated', 'reviewed', 'awaiting_pr_approval', 'pr_open', 'done', 'closed', 'skipped',
] as const; // closed: the PR was closed without being merged
export type IssueState = (typeof STATES)[number];

// States the pipeline works on without a human in between.
export const ACTIVE_STATES: IssueState[] = ['claimed', 'reproduced', 'coded', 'gated', 'reviewed'];

export interface Repo {
  full_name: string;
  fork: string;
  status: 'active' | 'paused' | 'blocked';
  policy_status: 'pending' | 'allowed' | null;
  policy_excerpts: string | null;
  block_reason: string | null;
  last_scanned: string | null;
}

export interface Issue {
  id: number;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  score: number | null;
  triage_reason: string | null;
  attempts: number;
  skip_reason: string | null;
  feedback: string | null;    // why the last attempt was sent back
  summary: string | null;     // coder's description of the current fix
  base_sha: string | null;
  test_files: string | null;   // JSON string[]
  test_hashes: string | null;  // JSON Record<path, sha256>
  test_vars: string | null;    // JSON Record<string, string>
  branch: string | null;
  pr_title: string | null;
  pr_body: string | null;
  dry: number;
  claimed_at: string | null;
  blocked: string | null;      // set when the repo's gate fails on the base too; cleared by `repo doctor`
  // Kept here so a run on a fresh machine (an Actions runner) has them; work/ only mirrors these.
  patch: string | null;        // the gated diff against base_sha (PATCH.diff)
  repro_patch: string | null;  // the reproducer's test alone (REPRO.diff)
  repro_notes: string | null;
  why: string | null;          // JSON {en, vi}[]: the PR writer's suggested reasons (WHY.json)
  pr_text: string | null;      // title line + body as the PR was opened (PR_BODY.md)
  updated_at: string;
}

export interface Pr {
  issue_id: number;
  url: string;
  number: number;
  state: 'open' | 'merged' | 'closed';
  last_seen_at: string;        // newest comment already handled
  opened_at: string;
  // Last snapshot (`run` or `inbox --refresh`); null until the first one.
  head_sha: string | null;
  mergeable: string | null;
  ci_state: string | null;
  merge_state: string | null;  // GitHub's mergeStateStatus: BEHIND, BLOCKED, CLEAN, ...
  review_decision: string | null;
  snapshot_at: string | null;
  ci_seen_sha: string | null;  // head whose failed CI the follow-up already looked at
}

export interface PendingAction {
  id: number;
  issue_id: number;
  kind: 'reply' | 'fix' | 'rebase';
  message: string;
  patch: string | null;
  base_sha: string | null;     // rebase: the new base the patch applies to
  status: 'pending' | 'done' | 'rejected';
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  full_name       TEXT PRIMARY KEY,
  fork            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  policy_status   TEXT,
  policy_excerpts TEXT,
  block_reason    TEXT,
  last_scanned    TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id            INTEGER PRIMARY KEY,
  repo          TEXT NOT NULL REFERENCES repos(full_name),
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL,
  score         REAL,
  triage_reason TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  skip_reason   TEXT,
  feedback      TEXT,
  summary       TEXT,
  base_sha      TEXT,
  test_files    TEXT,
  test_hashes   TEXT,
  test_vars     TEXT,
  branch        TEXT,
  pr_title      TEXT,
  pr_body       TEXT,
  dry           INTEGER NOT NULL DEFAULT 0,
  claimed_at    TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (repo, number)
);
CREATE TABLE IF NOT EXISTS prs (
  issue_id      INTEGER PRIMARY KEY REFERENCES issues(id),
  url           TEXT NOT NULL,
  number        INTEGER NOT NULL,
  state         TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  opened_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id            INTEGER PRIMARY KEY,
  issue_id      INTEGER NOT NULL REFERENCES issues(id),
  kind          TEXT NOT NULL,
  message       TEXT NOT NULL,
  patch         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_calls (
  id            INTEGER PRIMARY KEY,
  run_id        TEXT,
  issue_id      INTEGER REFERENCES issues(id),
  agent         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  duration_ms   INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  ok            INTEGER NOT NULL,
  result_json   TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

const now = () => new Date().toISOString();

const TABLES = ['repos', 'issues', 'prs', 'pending_actions', 'agent_calls', 'kv'] as const;

/** The whole state as JSON: what an Actions run carries between jobs and keeps on the state branch. */
export interface StateJson { version: 1; exported_at: string; tables: Record<string, Record<string, unknown>[]> }

export class Db {
  readonly sql: Database.Database;

  constructor(path = 'data/state.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new Database(path);
    this.sql.pragma('journal_mode = WAL');
    // `run` and an `approve` in another terminal are separate processes writing the same file.
    this.sql.pragma('busy_timeout = 10000');
    this.sql.exec(SCHEMA);
    const cols = (this.sql.prepare('PRAGMA table_info(agent_calls)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('models')) this.sql.exec('ALTER TABLE agent_calls ADD COLUMN models TEXT');
    const issueCols = (this.sql.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['blocked', 'patch', 'repro_patch', 'repro_notes', 'why', 'pr_text']) {
      if (!issueCols.includes(c)) this.sql.exec(`ALTER TABLE issues ADD COLUMN ${c} TEXT`);
    }
    const prCols = (this.sql.prepare('PRAGMA table_info(prs)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['head_sha', 'mergeable', 'ci_state', 'review_decision', 'snapshot_at', 'ci_seen_sha', 'merge_state']) {
      if (!prCols.includes(c)) this.sql.exec(`ALTER TABLE prs ADD COLUMN ${c} TEXT`);
    }
    const actionCols = (this.sql.prepare('PRAGMA table_info(pending_actions)').all() as { name: string }[]).map((c) => c.name);
    if (!actionCols.includes('base_sha')) this.sql.exec('ALTER TABLE pending_actions ADD COLUMN base_sha TEXT');
  }

  // --- export / import ---
  exportJson(opts: { keepCallsDays?: number; resultChars?: number } = {}): StateJson {
    const since = new Date(Date.now() - (opts.keepCallsDays ?? 90) * 86_400_000).toISOString();
    const tables: StateJson['tables'] = {};
    for (const t of TABLES) {
      tables[t] = t === 'agent_calls'
        ? this.sql.prepare('SELECT * FROM agent_calls WHERE started_at >= ? ORDER BY id').all(since) as Record<string, unknown>[]
        : this.sql.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    }
    // Agent output is kept for `show`; where the logs live elsewhere (Actions) a head is enough.
    if (opts.resultChars) {
      for (const row of tables.agent_calls) {
        if (typeof row.result_json === 'string' && row.result_json.length > opts.resultChars) row.result_json = row.result_json.slice(0, opts.resultChars);
      }
    }
    return { version: 1, exported_at: now(), tables };
  }
  /** Replaces everything with the export; columns the export has and this schema lacks are ignored. */
  importJson(state: StateJson) {
    if (state.version !== 1) throw new Error(`unsupported state version ${state.version}`);
    this.sql.transaction(() => {
      for (const t of [...TABLES].reverse()) this.sql.prepare(`DELETE FROM ${t}`).run();
      for (const t of TABLES) {
        const cols = (this.sql.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
        for (const row of state.tables[t] ?? []) {
          const keys = cols.filter((c) => c in row);
          this.sql.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
            .run(Object.fromEntries(keys.map((k) => [k, row[k]])));
        }
      }
    })();
  }

  // --- repos ---
  upsertRepo(fullName: string, fork: string) {
    this.sql.prepare(
      `INSERT INTO repos (full_name, fork) VALUES (?, ?)
       ON CONFLICT(full_name) DO UPDATE SET fork = excluded.fork`,
    ).run(fullName, fork);
  }
  repo(fullName: string): Repo | undefined {
    return this.sql.prepare('SELECT * FROM repos WHERE full_name = ?').get(fullName) as Repo | undefined;
  }
  repos(): Repo[] {
    return this.sql.prepare('SELECT * FROM repos ORDER BY full_name').all() as Repo[];
  }
  setRepoPolicy(fullName: string, status: 'pending' | 'allowed', excerpts?: string) {
    this.sql.prepare('UPDATE repos SET policy_status = ?, policy_excerpts = COALESCE(?, policy_excerpts) WHERE full_name = ?')
      .run(status, excerpts ?? null, fullName);
  }
  setRepoStatus(fullName: string, status: Repo['status'], reason: string | null = null) {
    this.sql.prepare('UPDATE repos SET status = ?, block_reason = ? WHERE full_name = ?').run(status, reason, fullName);
  }
  deleteRepo(fullName: string) {
    this.sql.prepare('DELETE FROM repos WHERE full_name = ?').run(fullName);
  }
  markScanned(fullName: string) {
    this.sql.prepare('UPDATE repos SET last_scanned = ? WHERE full_name = ?').run(now(), fullName);
  }

  // --- issues ---
  insertDiscovered(i: { repo: string; number: number; title: string; body: string; url: string }): boolean {
    const r = this.sql.prepare(
      `INSERT OR IGNORE INTO issues (repo, number, title, body, url, state, updated_at)
       VALUES (?, ?, ?, ?, ?, 'discovered', ?)`,
    ).run(i.repo, i.number, i.title, i.body, i.url, now());
    return r.changes > 0;
  }
  issue(id: number): Issue {
    const row = this.sql.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Issue | undefined;
    if (!row) throw new Error(`no issue with id ${id}`);
    return row;
  }
  issueByNumber(repo: string, number: number): Issue | undefined {
    return this.sql.prepare('SELECT * FROM issues WHERE repo = ? AND number = ?').get(repo, number) as Issue | undefined;
  }
  issuesInState(state: IssueState, repo?: string): Issue[] {
    return repo
      ? this.sql.prepare('SELECT * FROM issues WHERE state = ? AND repo = ? ORDER BY updated_at').all(state, repo) as Issue[]
      : this.sql.prepare('SELECT * FROM issues WHERE state = ? ORDER BY updated_at').all(state) as Issue[];
  }
  allIssues(): Issue[] {
    return this.sql.prepare('SELECT * FROM issues ORDER BY updated_at DESC').all() as Issue[];
  }
  // Issues the pipeline can advance this run: furthest along first (work already paid for), then by triage score.
  nextIssues(repo?: string): Issue[] {
    const marks = ACTIVE_STATES.map(() => '?').join(',');
    return this.sql.prepare(
      `SELECT i.* FROM issues i JOIN repos r ON r.full_name = i.repo
       WHERE i.state IN (${marks}) AND r.status = 'active' AND i.blocked IS NULL AND (? IS NULL OR i.repo = ?)
       ORDER BY CASE i.state ${ACTIVE_STATES.map((st, k) => `WHEN '${st}' THEN ${k}`).join(' ')} END DESC,
                i.score DESC, i.updated_at`,
    ).all(...ACTIVE_STATES, repo ?? null, repo ?? null) as Issue[];
  }
  issuesForRepo(repo: string): Issue[] {
    return this.sql.prepare('SELECT * FROM issues WHERE repo = ? ORDER BY number').all(repo) as Issue[];
  }
  /** Removes an issue with its PR row and actions; its agent_calls stay (unlinked) for the cost history. */
  deleteIssue(id: number) {
    this.sql.transaction(() => {
      this.sql.prepare('UPDATE agent_calls SET issue_id = NULL WHERE issue_id = ?').run(id);
      this.sql.prepare('DELETE FROM pending_actions WHERE issue_id = ?').run(id);
      this.sql.prepare('DELETE FROM prs WHERE issue_id = ?').run(id);
      this.sql.prepare('DELETE FROM issues WHERE id = ?').run(id);
    })();
  }
  blockedIssues(repo?: string): Issue[] {
    return this.sql.prepare('SELECT * FROM issues WHERE blocked IS NOT NULL AND (? IS NULL OR repo = ?) ORDER BY updated_at')
      .all(repo ?? null, repo ?? null) as Issue[];
  }
  /**
   * Releases a repo's blocked issues. With `head`, work not yet in a PR that was built on another
   * base goes back to `claimed`: its gate would run on that old (broken) base again otherwise.
   */
  clearBlocked(repo: string, head?: string): number {
    return this.sql.transaction(() => {
      if (head) {
        this.sql.prepare(`UPDATE issues SET state = 'claimed', updated_at = ? WHERE repo = ? AND blocked IS NOT NULL
          AND state IN ('reproduced', 'coded', 'gated', 'reviewed') AND base_sha IS NOT ?`).run(now(), repo, head);
      }
      return this.sql.prepare('UPDATE issues SET blocked = NULL WHERE repo = ? AND blocked IS NOT NULL').run(repo).changes;
    })();
  }
  // Issues that hold a repo's pipeline slot (in progress or waiting on the human).
  inFlightCount(repo: string): number {
    const states = [...ACTIVE_STATES, 'awaiting_claim', 'awaiting_pr_approval'];
    const marks = states.map(() => '?').join(',');
    return (this.sql.prepare(`SELECT COUNT(*) AS n FROM issues WHERE repo = ? AND state IN (${marks})`)
      .get(repo, ...states) as { n: number }).n;
  }

  update(id: number, fields: Partial<Omit<Issue, 'id' | 'updated_at'>>): Issue {
    const keys = Object.keys(fields);
    if (keys.length) {
      const set = keys.map((k) => `${k} = @${k}`).join(', ');
      this.sql.prepare(`UPDATE issues SET ${set}, updated_at = @updated_at WHERE id = @id`)
        .run({ ...fields, updated_at: now(), id });
    }
    return this.issue(id);
  }
  transition(id: number, to: IssueState, fields: Partial<Omit<Issue, 'id' | 'updated_at' | 'state'>> = {}): Issue {
    return this.update(id, { ...fields, state: to });
  }
  skip(id: number, reason: string): Issue {
    return this.transition(id, 'skipped', { skip_reason: reason.slice(0, 2000) });
  }

  // --- prs ---
  insertPr(issueId: number, url: string, number: number, o: { openedAt?: string; lastSeenAt?: string } = {}) {
    const t = now();
    this.sql.prepare('INSERT INTO prs (issue_id, url, number, state, last_seen_at, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(issueId, url, number, 'open', o.lastSeenAt ?? t, o.openedAt ?? t);
  }
  openPrs(): (Pr & { repo: string })[] {
    return this.sql.prepare(
      `SELECT p.*, i.repo FROM prs p JOIN issues i ON i.id = p.issue_id WHERE p.state = 'open'`,
    ).all() as (Pr & { repo: string })[];
  }
  openPrCount(repo: string): number {
    return (this.sql.prepare(
      `SELECT COUNT(*) AS n FROM prs p JOIN issues i ON i.id = p.issue_id WHERE i.repo = ? AND p.state = 'open'`,
    ).get(repo) as { n: number }).n;
  }
  updatePr(issueId: number, fields: Partial<Omit<Pr, 'issue_id' | 'url' | 'number' | 'opened_at'>>) {
    for (const [k, v] of Object.entries(fields)) {
      this.sql.prepare(`UPDATE prs SET ${k} = ? WHERE issue_id = ?`).run(v, issueId);
    }
  }
  prForIssue(issueId: number): Pr | undefined {
    return this.sql.prepare('SELECT * FROM prs WHERE issue_id = ?').get(issueId) as Pr | undefined;
  }
  /** Open PRs with their issue, newest first (for the inbox). */
  openPrsWithIssue(): (Pr & { repo: string; issue_number: number; title: string; blocked: string | null })[] {
    return this.sql.prepare(
      `SELECT p.*, i.repo, i.number AS issue_number, i.title, i.blocked FROM prs p JOIN issues i ON i.id = p.issue_id
       WHERE p.state = 'open' ORDER BY p.opened_at DESC`,
    ).all() as (Pr & { repo: string; issue_number: number; title: string; blocked: string | null })[];
  }

  // --- pending follow-up actions ---
  addAction(issueId: number, kind: PendingAction['kind'], message: string, patch: string | null, baseSha: string | null = null): number {
    return Number(this.sql.prepare(
      'INSERT INTO pending_actions (issue_id, kind, message, patch, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(issueId, kind, message, patch, baseSha, now()).lastInsertRowid);
  }
  pendingActionFor(issueId: number): PendingAction | undefined {
    return this.sql.prepare(`SELECT * FROM pending_actions WHERE issue_id = ? AND status = 'pending' ORDER BY id LIMIT 1`).get(issueId) as PendingAction | undefined;
  }
  action(id: number): PendingAction {
    const row = this.sql.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as PendingAction | undefined;
    if (!row) throw new Error(`no pending action with id ${id}`);
    return row;
  }
  pendingActions(): PendingAction[] {
    return this.sql.prepare(`SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY id`).all() as PendingAction[];
  }
  setActionStatus(id: number, status: PendingAction['status']) {
    this.sql.prepare('UPDATE pending_actions SET status = ? WHERE id = ?').run(status, id);
  }
  /** Drafts for a PR that is merged or closed have nothing left to go to; returns how many were dropped. */
  dropActionsOfClosedPrs(): number {
    return this.sql.prepare(`UPDATE pending_actions SET status = 'rejected' WHERE status = 'pending'
      AND issue_id IN (SELECT issue_id FROM prs WHERE state != 'open')`).run().changes;
  }

  // --- agent calls & cost ---
  recordCall(c: {
    runId: string | null; issueId: number | null; agent: string; startedAt: string; durationMs: number;
    inputTokens: number | null; outputTokens: number | null; costUsd: number | null; ok: boolean; resultJson: string;
    models?: string[];
  }) {
    this.sql.prepare(
      `INSERT INTO agent_calls (run_id, issue_id, agent, started_at, duration_ms, input_tokens, output_tokens, cost_usd, ok, result_json, models)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.runId, c.issueId, c.agent, c.startedAt, c.durationMs, c.inputTokens, c.outputTokens, c.costUsd, c.ok ? 1 : 0, c.resultJson,
      c.models?.length ? c.models.join(',') : null);
  }
  /** Distinct models recorded for an issue's agent calls, or null if none were recorded. */
  modelsForIssue(issueId: number): string[] | null {
    const rows = this.sql.prepare('SELECT models FROM agent_calls WHERE issue_id = ? AND models IS NOT NULL').all(issueId) as { models: string }[];
    const all = [...new Set(rows.flatMap((r) => r.models.split(',')))].sort();
    return all.length ? all : null;
  }
  costSince(iso: string): number {
    return (this.sql.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_calls WHERE started_at >= ?').get(iso) as { c: number }).c;
  }
  costForRun(runId: string): number {
    return (this.sql.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_calls WHERE run_id = ?').get(runId) as { c: number }).c;
  }
  costByAgent(sinceIso: string) {
    return this.sql.prepare(
      `SELECT agent, COUNT(*) AS calls, SUM(ok) AS ok, ROUND(SUM(cost_usd), 4) AS cost_usd,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM agent_calls WHERE started_at >= ? GROUP BY agent ORDER BY cost_usd DESC`,
    ).all(sinceIso);
  }
  lastCalls(issueId: number, limit = 20) {
    return this.sql.prepare(
      'SELECT agent, started_at, duration_ms, cost_usd, ok, result_json FROM agent_calls WHERE issue_id = ? ORDER BY id DESC LIMIT ?',
    ).all(issueId, limit) as { agent: string; started_at: string; duration_ms: number; cost_usd: number; ok: number; result_json: string }[];
  }

  // --- flags ---
  get(key: string): string | undefined {
    return (this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  set(key: string, value: string | null) {
    if (value === null) this.sql.prepare('DELETE FROM kv WHERE key = ?').run(key);
    else this.sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
