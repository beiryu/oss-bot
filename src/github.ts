import { execa, execaSync } from 'execa';

// Thin wrapper around the gh CLI on the host. Only the host holds GitHub credentials.

// GitHub answers 502/504 now and then, mostly on GraphQL; retry those, nothing else.
// Writes pass retry=false: a 5xx can arrive after the comment or PR was created.
const TRANSIENT = /HTTP 5\d\d|timed? ?out|ECONNRESET|connection reset/i;

async function gh(args: string[], input?: string, retry = true) {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await execa('gh', args, { input })).stdout;
    } catch (e) {
      const text = `${(e as { stderr?: string }).stderr ?? ''} ${(e as Error).message}`;
      if (!retry || attempt >= 4 || !TRANSIENT.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt ** 2));
    }
  }
}
async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  labels: { name: string }[];
  assignees: { login: string }[];
}

let me: string | undefined;
let expected: string | undefined;
/**
 * Pins every gh and git call of this process to `login`, whichever gh account is active
 * for the rest of the machine: its keyring token goes into GH_TOKEN, which gh (and git's
 * gh credential helper) use before the active account.
 */
export function expectUser(login: string) {
  expected = login;
  try {
    const token = execaSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login]).stdout.trim();
    if (token) process.env.GH_TOKEN = token;
  } catch {
    // Not logged in as `login`: currentUser() reports the mismatch with a fix.
  }
}

/** The account `gh` is logged in as; refuses to continue if it is not `github_user`. */
export async function currentUser(): Promise<string> {
  me ??= (await gh(['api', 'user', '--jq', '.login'])).trim();
  if (expected && me.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`gh has no login for ${expected} (it acts as ${me}); run: gh auth login, then sign in as ${expected}`);
  }
  return me;
}

/**
 * Git flags that commit and push as the gh account, whatever the folder's git identity
 * or the macOS keychain holds: author = its noreply address, credentials = gh's helper.
 */
/**
 * Name, noreply email and credentials of the bot's account for host git commands. With a
 * signing key (an SSH key registered on GitHub as a *signing* key), every commit is signed
 * and shows as Verified.
 */
export async function gitIdentity(signingKey?: string): Promise<string[]> {
  const login = await currentUser();
  const u = await ghJson<{ id: number; name: string | null }>(['api', 'user']);
  return [
    '-c', `user.name=${u.name || login}`,
    '-c', `user.email=${u.id}+${login}@users.noreply.github.com`,
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!gh auth git-credential',
    ...(signingKey ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signingKey}`, '-c', 'commit.gpgsign=true'] : []),
  ];
}

export function listOpenIssues(repo: string, labels: string[], limit = 500): Promise<GhIssue[]> {
  const args = ['issue', 'list', '-R', repo, '--state', 'open', '--limit', String(limit),
    '--json', 'number,title,body,url,createdAt,labels,assignees'];
  // gh ANDs repeated --label flags, so with several labels we filter client-side instead.
  if (labels.length === 1) args.push('--label', labels[0]);
  return ghJson<GhIssue[]>(args);
}

export async function getIssue(repo: string, number: number): Promise<GhIssue & { state: string }> {
  return ghJson(['issue', 'view', String(number), '-R', repo,
    '--json', 'number,title,body,url,createdAt,labels,assignees,state']);
}

/** Open PRs that close or reference the issue: someone is probably already on it. */
export async function linkedOpenPrCount(repo: string, number: number): Promise<number> {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
    closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{state}}
    timelineItems(first:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{state}}}}}
  }}}`;
  const data = await ghJson<any>(['api', 'graphql', '-f', `query=${query}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`]);
  const issue = data.data.repository.issue;
  const closing = issue.closedByPullRequestsReferences.nodes.filter((n: any) => n.state === 'OPEN').length;
  const refs = issue.timelineItems.nodes.filter((n: any) => n.source?.state === 'OPEN').length;
  return closing + refs;
}

export async function commentOnIssue(repo: string, number: number, body: string) {
  await gh(['issue', 'comment', String(number), '-R', repo, '--body-file', '-'], body, false);
}

export async function openPrForHead(repo: string, head: string): Promise<{ url: string; number: number } | null> {
  const [owner, branch] = head.split(':');
  const prs = await ghJson<{ url: string; number: number; headRepositoryOwner: { login: string } }[]>(
    ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'url,number,headRepositoryOwner']);
  const pr = prs.find((p) => p.headRepositoryOwner.login.toLowerCase() === owner.toLowerCase());
  return pr ? { url: pr.url, number: pr.number } : null;
}

export interface GhPr {
  number: number;
  url: string;
  title: string;
  body: string;
  createdAt: string;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner: { login: string };
  author: { login: string };
  closingIssuesReferences: { number: number }[];
}

/** Your open PRs against `repo`, with what `pr adopt` needs. */
export function myOpenPrs(repo: string, author: string): Promise<GhPr[]> {
  return ghJson(['pr', 'list', '-R', repo, '--author', author, '--state', 'open', '--limit', '100', '--json',
    'number,url,title,body,createdAt,headRefName,headRefOid,headRepositoryOwner,author,closingIssuesReferences']);
}

/** When you last acted on the PR (comment, review reply, commit); feedback after it is unanswered. */
export async function myLastActivity(repo: string, number: number, login: string): Promise<string> {
  const pr = await ghJson<any>(['pr', 'view', String(number), '-R', repo, '--json', 'createdAt,comments,reviews,commits']);
  const mine = (a: any) => a?.login?.toLowerCase() === login.toLowerCase();
  const times = [
    pr.createdAt,
    ...pr.comments.filter((c: any) => mine(c.author)).map((c: any) => c.createdAt),
    ...pr.reviews.filter((r: any) => mine(r.author)).map((r: any) => r.submittedAt),
    ...pr.commits.map((c: any) => c.committedDate),
  ].filter(Boolean) as string[];
  return times.map((t) => new Date(t).toISOString()).sort().pop()!;
}

/** The commit `head` (owner:branch) branched from `base`, as GitHub computes it for the PR diff. */
export async function compareMergeBase(repo: string, base: string, head: string): Promise<string> {
  return (await gh(['api', `repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    '--jq', '.merge_base_commit.sha'])).trim();
}

export async function createPr(o: { repo: string; base: string; head: string; title: string; body: string }) {
  const url = (await gh(['pr', 'create', '-R', o.repo, '--base', o.base, '--head', o.head,
    '--title', o.title, '--body-file', '-'], o.body, false)).trim().split('\n').pop()!;
  return { url, number: Number(url.split('/').pop()) };
}

export async function prState(repo: string, number: number): Promise<'open' | 'merged' | 'closed'> {
  const pr = await ghJson<{ state: string }>(['pr', 'view', String(number), '-R', repo, '--json', 'state']);
  return pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
}

// awaiting_approval: workflows wait for a maintainer to approve running them (first-time contributors).
export type CiState = 'pending' | 'success' | 'failure' | 'none' | 'awaiting_approval';
export interface PrCheck { name: string; conclusion: string; url: string | null }
export interface PrSnapshot {
  state: 'open' | 'merged' | 'closed';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeState: string;              // BLOCKED, BEHIND, CLEAN, DIRTY, UNSTABLE...
  reviewDecision: string | null;   // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  headSha: string;
  isDraft: boolean;
  labels: string[];
  checks: PrCheck[];
  ci: CiState;
}

/** One verdict for the whole check list: anything still running wins over a failure, a failure over success. */
export function summarizeChecks(checks: PrCheck[]): CiState {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.conclusion === 'PENDING' || c.conclusion === 'IN_PROGRESS' || c.conclusion === 'QUEUED' || c.conclusion === 'EXPECTED')) return 'pending';
  if (checks.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED'].includes(c.conclusion))) return 'failure';
  return 'success';
}

/** Everything the follow-up needs to know about a PR, in one gh call. */
export async function prSnapshot(repo: string, number: number): Promise<PrSnapshot> {
  const pr = await ghJson<any>(['pr', 'view', String(number), '-R', repo, '--json',
    'state,mergeable,mergeStateStatus,reviewDecision,headRefOid,isDraft,labels,statusCheckRollup']);
  const checks: PrCheck[] = (pr.statusCheckRollup ?? []).map((c: any) => ({
    name: c.name ?? c.context ?? '?',
    // CheckRun: status + conclusion; StatusContext: state only.
    conclusion: c.status && c.status !== 'COMPLETED' ? 'PENDING' : (c.conclusion ?? c.state ?? 'NEUTRAL'),
    url: c.detailsUrl ?? c.targetUrl ?? null,
  }));
  let ci = summarizeChecks(checks);
  // Workflows held for approval never reach statusCheckRollup, so "no checks" may mean "not allowed to run yet".
  const otherFailures = checks.some((c) => c.conclusion !== 'ACTION_REQUIRED' && summarizeChecks([c]) === 'failure');
  if (pr.state === 'OPEN' && ci !== 'pending' && !otherFailures) {
    try {
      const held = await ghJson<{ total_count: number }>(['api',
        `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&status=action_required&per_page=1`]);
      if (held.total_count > 0) ci = 'awaiting_approval';
    } catch { /* keep what the checks say */ }
  }
  return {
    state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
    mergeable: pr.mergeable ?? 'UNKNOWN', mergeState: pr.mergeStateStatus ?? '', reviewDecision: pr.reviewDecision || null,
    headSha: pr.headRefOid, isDraft: !!pr.isDraft, labels: (pr.labels ?? []).map((l: any) => l.name),
    checks, ci,
  };
}

/** Why each failed check failed: the failed-step log for GitHub Actions, the check's own summary otherwise. */
export async function failedCheckDetails(repo: string, headSha: string, maxChars = 2500): Promise<{ name: string; summary: string }[]> {
  const out: { name: string; summary: string }[] = [];
  const bad = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled']);
  let runs: any[] = [];
  try {
    runs = (await ghJson<any[]>(['api', '--paginate', '--slurp', `repos/${repo}/commits/${headSha}/check-runs`])).flatMap((p) => p.check_runs ?? []);
  } catch { /* fall through to statuses */ }
  for (const r of runs.filter((r) => bad.has(r.conclusion))) {
    let summary = [r.output?.title, r.output?.summary, r.output?.text].filter(Boolean).join('\n');
    const m = /\/actions\/runs\/(\d+)/.exec(r.details_url ?? '');
    if (m) {
      try {
        const logText = await gh(['run', 'view', m[1], '-R', repo, '--log-failed']);
        if (logText.trim()) summary = logText.split('\n').slice(-120).join('\n');
      } catch { /* keep the check's own summary */ }
    }
    out.push({ name: r.name, summary: (summary || `(no details; ${r.details_url ?? ''})`).slice(-maxChars) });
  }
  try {
    const st = await ghJson<any>(['api', `repos/${repo}/commits/${headSha}/status`]);
    for (const s of st.statuses ?? []) {
      if (s.state === 'failure' || s.state === 'error') out.push({ name: s.context, summary: `${s.description ?? ''} ${s.target_url ?? ''}`.trim() });
    }
  } catch { /* statuses are optional */ }
  return out;
}

export interface PrComment { kind: 'comment' | 'review' | 'review-comment'; author: string; body: string; createdAt: string; path?: string; line?: number }

// Automation that runs as a plain user account, so it lacks the "[bot]" suffix.
const USER_BOTS = new Set(['CLAassistant', 'claassistantio', 'codecov-commenter', 'sonarqubecloud', 'k8s-ci-robot', 'k8s-triage-robot']);
export const isBot = (login: string) => login.endsWith('[bot]') || USER_BOTS.has(login);

/**
 * Whether a PR comment is feedback worth acting on. Humans always count. Bots are noise
 * (CLA, CI summaries) except the repo's own AI reviewers listed in `reviewBots`, and only
 * their inline review comments, which carry the actual suggestions.
 */
export function isFeedback(c: PrComment, me: string, since: string, reviewBots: string[]) {
  if (c.createdAt <= since || c.author === me) return false;
  if (!isBot(c.author)) return true;
  return c.kind === 'review-comment' && reviewBots.includes(c.author);
}

/** All feedback on a PR since `since`: conversation comments, reviews and inline review comments. */
export async function prCommentsSince(repo: string, number: number, since: string, reviewBots: string[] = []): Promise<PrComment[]> {
  const login = await currentUser();
  const issueComments = await ghJson<any[]>(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments?since=${since}`]);
  const reviews = await ghJson<any[]>(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/reviews`]);
  const inline = await ghJson<any[]>(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/comments?since=${since}`]);
  const out: PrComment[] = [
    ...issueComments.flat().map((c) => ({ kind: 'comment' as const, author: c.user.login, body: c.body, createdAt: c.created_at })),
    // A "request changes" with no text still asks for something (usually explained inline).
    ...reviews.flat().filter((r) => r.body || r.state === 'CHANGES_REQUESTED').map((r) => ({
      kind: 'review' as const, author: r.user.login, createdAt: r.submitted_at,
      body: `[${r.state}] ${r.body || '(no text; the inline comments say what to change)'}`,
    })),
    ...inline.flat().map((c) => ({ kind: 'review-comment' as const, author: c.user.login, body: c.body, createdAt: c.created_at, path: c.path, line: c.line })),
  ];
  return out
    .filter((c) => isFeedback(c, login, since, reviewBots))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- onboarding (`repo add`)

export async function repoInfo(repo: string) {
  const r = await ghJson<any>(['repo', 'view', repo, '--json', 'nameWithOwner,defaultBranchRef,primaryLanguage,stargazerCount,isArchived,description,licenseInfo']);
  return {
    fullName: r.nameWithOwner as string, defaultBranch: (r.defaultBranchRef?.name ?? 'main') as string,
    language: (r.primaryLanguage?.name ?? '?') as string, stars: r.stargazerCount as number, archived: !!r.isArchived,
    description: (r.description ?? '') as string, license: (r.licenseInfo?.name ?? 'none') as string,
  };
}

export interface RecentPr { isCrossRepository: boolean; state: string; mergedAt: string | null; reviews?: { author?: { login?: string } }[] }
export function recentPrs(repo: string, limit: number): Promise<RecentPr[]> {
  return ghJson<RecentPr[]>(['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(limit), '--json', 'isCrossRepository,state,mergedAt,reviews']);
}

export async function repoExists(repo: string): Promise<boolean> {
  try { await gh(['repo', 'view', repo, '--json', 'nameWithOwner'], undefined, false); return true; } catch { return false; }
}

export async function forkRepo(repo: string) {
  await gh(['repo', 'fork', repo, '--clone=false'], undefined, false);
}
