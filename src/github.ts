import { execa, execaSync } from 'execa';

// Thin wrapper around the gh CLI on the host. Only the host holds GitHub credentials.

// GitHub answers 502/504 now and then, mostly on GraphQL; retry those, nothing else.
// Writes pass retry=false: a 5xx can arrive after the comment or PR was created.
const TRANSIENT = /HTTP 5\d\d|timed? ?out|ECONNRESET|connection reset|Something went wrong while executing your query/i;

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

/**
 * A GraphQL read that keeps a partial answer. GitHub fails a whole query with INTERNAL when one
 * node is out of the token's reach (a cross-reference from a repo it cannot see: the node comes
 * back null), yet answers the rest; callers skip null nodes.
 */
async function graphqlRead<T>(query: string, vars: Record<string, string | number>): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ['-F', `${k}=${v}`])];
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(await gh(args, undefined, false)).data as T;
    } catch (e) {
      const partial = (() => { try { return JSON.parse((e as { stdout?: string }).stdout ?? '').data; } catch { return null; } })();
      if (partial) return partial as T;
      const text = `${(e as { stderr?: string }).stderr ?? ''} ${(e as Error).message}`;
      if (attempt >= 4 || !TRANSIENT.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt ** 2));
    }
  }
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

/**
 * Takes `login` as the account without asking GitHub: for a job whose token cannot answer
 * `/user` (the Actions token). Only reads happen with such a token, so nothing is posted as
 * the wrong identity; the publish job uses expectUser() and a token that is checked.
 */
export function assumeUser(login: string) {
  expected = login;
  me = login;
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
  const issue = (await graphqlRead<any>(query, { owner, name, number })).repository.issue;
  const closing = issue.closedByPullRequestsReferences.nodes.filter((n: any) => n?.state === 'OPEN').length;
  const refs = issue.timelineItems.nodes.filter((n: any) => n?.source?.state === 'OPEN').length;
  return closing + refs;
}

/** Open PRs by someone other than `me` that close or mention the issue, as "#12 by @x". */
export async function otherOpenPrs(repo: string, number: number, me: string): Promise<string[]> {
  const [owner, name] = repo.split('/');
  const pr = '... on PullRequest{state number url author{login}}';
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
    closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{${pr}}}
    timelineItems(first:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{${pr}}}}}
  }}}`;
  const issue = (await graphqlRead<any>(query, { owner, name, number })).repository.issue;
  const prs = [...issue.closedByPullRequestsReferences.nodes, ...issue.timelineItems.nodes.map((n: any) => n?.source)]
    .filter((p: any) => p?.state === 'OPEN' && p.author?.login && p.author.login.toLowerCase() !== me.toLowerCase());
  const own = `https://github.com/${repo}/pull/`;
  return [...new Set(prs.map((p: any) => `${p.url.startsWith(own) ? `#${p.number}` : p.url.replace('https://github.com/', '')} by @${p.author.login}`))];
}

// First-person "I'm on this": a claim, a fix someone has ready, or a PR they are about to open.
const PR = String.raw`(?:a |the |my )?(?:\w+ )?(?:pr|pull request|fix|patch)\b`;
const CLAIM_INTENT = new RegExp([
  String.raw`\bI(?:'ve| have)(?: got)? (?:a|the|my) (?:fix|patch|branch|pr|pull request|draft)\b`,
  String.raw`\bI(?:'d| would) (?:like|love|be happy) to (?:work on|take|fix|tackle|pick up)\b`,
  String.raw`\bI(?:'m| am) (?:working on (?:this|it|a fix)|on it|already on)\b`,
  String.raw`\bI(?:'ll| will) (?:work on (?:this|it)|take (?:this|it)(?! *(?:a )?look)|fix (?:this|it))\b`,
  String.raw`\b(?:I(?:'ll| will| can)|(?:happy|glad) to|(?:can|may|shall) I) (?:open|submit|send|raise|put up) ${PR}`,
  String.raw`\b(?:can|may|shall) I (?:work on|take|pick up) (?:this|it)\b`,
  String.raw`\bbefore (?:opening|submitting|sending) ${PR}`,
  String.raw`(?:^|\s)/assign\b`, String.raw`\bassign (?:this|it) to me\b`,
].join('|'), 'i');

export interface IssueText { author: string; at: string; body: string }

/** The latest recent statement by someone else (not you, not a bot) that they fix the issue themselves. */
export function findOtherClaim(texts: IssueText[], me: string, since: string): string | null {
  const hit = texts.filter((t) => t.at >= since && t.author.toLowerCase() !== me.toLowerCase() && !isBot(t.author))
    .map((t) => ({ t, m: CLAIM_INTENT.exec(t.body.replace(/```[\s\S]*?```|^>.*$/gm, '')) }))
    .filter((x) => x.m).pop();
  if (!hit) return null;
  const at = hit.m!.index;
  const quote = hit.t.body.replace(/```[\s\S]*?```|^>.*$/gm, '').slice(Math.max(0, at - 40), at + 100).replace(/\s+/g, ' ').trim();
  return `@${hit.t.author} on ${hit.t.at.slice(0, 10)}: "…${quote}…"`;
}

/** Someone else said on the issue (body or comments, last `days` days) that they are fixing it. */
export async function otherClaim(repo: string, number: number, days = 45): Promise<string | null> {
  const me = await currentUser();
  const i = await ghJson<any>(['issue', 'view', String(number), '-R', repo, '--json', 'author,body,createdAt,comments']);
  const texts: IssueText[] = [
    { author: i.author?.login ?? '', at: i.createdAt, body: i.body ?? '' },
    ...(i.comments ?? []).map((c: any) => ({ author: c.author?.login ?? '', at: c.createdAt, body: c.body ?? '' })),
  ];
  return findOtherClaim(texts, me, new Date(Date.now() - days * 86_400_000).toISOString());
}

export async function commentOnIssue(repo: string, number: number, body: string) {
  await gh(['issue', 'comment', String(number), '-R', repo, '--body-file', '-'], body, false);
}

// ---- the desk (dashboard issue) and the state branch, used by the Actions jobs

/**
 * Runs `fn` with GH_TOKEN set to `token` (when given): the private desk repo takes its own
 * narrow token. The publish job runs its GitHub calls one after another, so the swap is safe.
 */
export async function withToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!token) return fn();
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try { return await fn(); } finally { process.env.GH_TOKEN = before; }
}

export async function ghPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return JSON.parse(await gh(['api', '-X', 'POST', endpoint, '--input', '-'], JSON.stringify(body), false)) as T;
}

/** One GraphQL call with variables; never retried (it may be a mutation). */
export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const out = JSON.parse(await gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }), false));
  if (out.errors?.length) throw new Error(`GraphQL: ${out.errors.map((e: { message: string }) => e.message).join('; ')}`);
  return out.data as T;
}

/** The branch's tip, or null when it does not exist. Any other failure (a bad token) is an error, not "no branch". */
export async function refSha(repo: string, branch: string): Promise<string | null> {
  try {
    return (await gh(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'])).trim() || null;
  } catch (e) {
    if (/HTTP 404/.test(`${(e as { stderr?: string }).stderr ?? ''} ${(e as Error).message}`)) return null;
    throw e;
  }
}
export async function createRef(repo: string, branch: string, sha: string) {
  await gh(['api', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`], undefined, false);
}
export async function fileAtRef(repo: string, path: string, ref: string): Promise<string> {
  return gh(['api', `repos/${repo}/contents/${path}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw']);
}

export interface FileChanges { additions: { path: string; contents: string }[]; deletions: { path: string }[] }
/** One commit on `branch` with the given file contents; fails if the branch moved past `expectedHeadOid`. Returns the new oid. */
export async function createCommitOnBranch(repo: string, branch: string, expectedHeadOid: string,
  message: { headline: string; body: string }, fileChanges: FileChanges): Promise<string> {
  const data = await graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
    'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}',
    { input: { branch: { repositoryNameWithOwner: repo, branchName: branch }, expectedHeadOid, message, fileChanges } },
  );
  return data.createCommitOnBranch.commit.oid;
}

export interface IssueComment { id: number; url: string; author: string; body: string; createdAt: string }
export async function issueComments(repo: string, number: number): Promise<IssueComment[]> {
  const pages = await ghJson<any[]>(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`]);
  return pages.flat().map((c) => ({ id: c.id, url: c.html_url, author: c.user.login, body: c.body ?? '', createdAt: c.created_at }));
}

export async function createIssue(repo: string, o: { title: string; body: string }): Promise<{ url: string; number: number }> {
  const url = (await gh(['issue', 'create', '-R', repo, '--title', o.title, '--body-file', '-'], o.body, false)).trim().split('\n').pop()!;
  return { url, number: Number(url.split('/').pop()) };
}

export async function editIssueBody(repo: string, number: number, body: string) {
  await gh(['issue', 'edit', String(number), '-R', repo, '--body-file', '-'], body, false);
}

/** Open issues whose body contains `text` (GitHub's search, so recent edits may lag a little). */
export async function findIssuesByBody(repo: string, text: string): Promise<{ number: number; body: string }[]> {
  return ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--search', `"${text}" in:body`, '--json', 'number,body']);
}

/** Pins an issue to the top of the repo's issue list (at most three can be pinned; failures are ignored by callers). */
export async function pinIssue(repo: string, number: number) {
  const [owner, name] = repo.split('/');
  const q = await graphql<{ repository: { issue: { id: string } } }>(
    'query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){id}}}', { o: owner, n: name, i: number });
  await graphql('mutation($id:ID!){pinIssue(input:{issueId:$id}){issue{number}}}', { id: q.repository.issue.id });
}

/** When the token has an expiry date (a PAT), that day (ISO date), else null. */
export async function tokenExpiry(): Promise<string | null> {
  const head = await gh(['api', '-i', 'user', '--jq', '.login']).catch(() => '');
  const m = /github-authentication-token-expiration:\s*(\d{4}-\d{2}-\d{2})/i.exec(head);
  return m ? m[1] : null;
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
 * Whether a PR comment goes to the follow-up agent: everything new that is not yours, bots
 * included (AI reviewers, CLA, CI summaries). The agent decides what needs a fix, an answer
 * or nothing; a reply is only drafted when a human wrote something.
 */
export function isFeedback(c: PrComment, me: string, since: string) {
  return c.createdAt > since && c.author !== me;
}

/** All feedback on a PR since `since`: conversation comments, reviews and inline review comments. */
export async function prCommentsSince(repo: string, number: number, since: string): Promise<PrComment[]> {
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
    .filter((c) => isFeedback(c, login, since))
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
