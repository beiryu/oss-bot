import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const RepoConfig = z.object({
  full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  fork: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  default_branch: z.string().default('main'),
  branch_prefix: z.string().default(''),
  // Branch name after the prefix; {{number}} and {{slug}} are filled in.
  branch_name: z.string().default('fix-{{number}}-{{slug}}'),
  // Comment posted (after `approve <id>`) to claim an issue, e.g. Prow's "/assign".
  claim_comment: z.string().optional(),
  // false when the project only asks you to announce the work (no /assign bot): `approve pr`
  // then no longer waits for an assignment; read the maintainers' reply yourself first.
  require_assignment: z.boolean().default(true),
  labels: z.array(z.string()).default([]),
  skip_labels: z.array(z.string()).default([]),
  max_issue_age_days: z.number().default(180),
  // Command template for the reproducer's test; {{vars}} come from the reproducer's testVars.
  focused_test: z.string(),
  gate: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  // When set, the patch may only touch files under these paths (e.g. one package of a monorepo).
  allowed_paths: z.array(z.string()).default([]),
  agent_disclosure: z.string(),
  // Project conventions the agents must follow beyond what they read in the repo
  // (test tags, markers, generated files...). Also used by the reviewer as a checklist.
  notes: z.string().default(''),
  // false when the project requires review answers in the contributor's own words: the
  // follow-up agent then only explains the feedback to you, and you write the reply.
  draft_replies: z.boolean().default(true),
  // Bot accounts whose inline review comments count as feedback, e.g. "github-actions[bot]".
  review_bots: z.array(z.string()).default([]),
  // Commands run after the commit, in a clone with full history, before pushing; what they
  // change is folded into the same commit. For files generated from git dates (feeds,
  // sitemaps) that CI checks against its own regeneration.
  after_commit: z.array(z.string()).default([]),
  // Add a DCO "Signed-off-by:" trailer (the bot's own name and noreply email) to every commit.
  signoff: z.boolean().default(false),
});

const Config = z.object({
  // Account `gh` must be logged in as on the host (comments, pushes, PRs). The Copilot
  // token can belong to a different account; this one is checked so the bot never posts
  // as the wrong identity.
  github_user: z.string().regex(/^[\w-]+$/),
  // Private half of an SSH key added to github_user as a *signing* key: every commit the bot
  // makes is then signed (Verified). Without passphrase, since runs are unattended.
  commit_signing_key: z.string().optional(),
  repos: z.array(RepoConfig).default([]),
  limits: z.object({
    max_open_prs_per_repo: z.number().default(1),
    max_triage_per_run: z.number().default(5),
    // Triaged issues below this score stay in the queue but are never picked on their own;
    // `run --issue N` still works on them. Low scores mean "needs a maintainer decision".
    min_score: z.number().min(0).max(1).default(0.5),
    // A run stops before cloning or building when the disk holding work/ has less free space.
    min_free_disk_gb: z.number().default(15),
    // After each run the least recently used Go build output is dropped while the cache is past this (modules stay).
    max_go_build_cache_gb: z.number().default(6),
    max_attempts: z.number().default(3),
  }),
  budget: z.object({
    max_cost_per_call_usd: z.number().default(3),
  }),
  sandbox: z.object({
    image: z.string().default('oss-bot-sandbox'),
    memory: z.string().default('5g'),
    cpus: z.string().default('4'),
    // Agent CLI run inside the container.
    runtime: z.enum(['copilot', 'claude']).default('copilot'),
    // Env var that carries the model credential into agent containers. For copilot this
    // must be a fine-grained PAT with only the "Copilot Requests" permission, never the
    // token `gh` uses on the host.
    auth_env: z.enum(['COPILOT_GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']).default('COPILOT_GITHUB_TOKEN'),
    model: z.string().optional(),
    cache_volume: z.string().default('oss-bot-cache'),
    agent_timeout_min: z.number().default(30),
    gate_timeout_min: z.number().default(60),
  }),
  notify: z.preprocess((v) => v ?? {}, z.object({
    telegram_chat_id: z.string().optional(), // token read from TELEGRAM_BOT_TOKEN
    slack_webhook_env: z.string().optional(),
  })),
}).superRefine((c, ctx) => {
  for (const r of c.repos) {
    if (r.fork.split('/')[0] !== c.github_user) {
      ctx.addIssue({ code: 'custom', path: ['repos'], message: `${r.full_name}: fork ${r.fork} is not owned by github_user ${c.github_user}` });
    }
  }
});

export type RepoConfig = z.infer<typeof RepoConfig>;
export type Config = z.infer<typeof Config>;
export const RepoConfigSchema = RepoConfig;

// One file per repo next to config.yaml: `repo add` writes them, `repo remove` deletes them.
export const reposDir = (configPath = 'config.yaml') => join(dirname(configPath), 'repos');
export const repoFile = (fullName: string, configPath = 'config.yaml') =>
  join(reposDir(configPath), `${fullName.replace('/', '__')}.yaml`);

export function loadConfig(path = 'config.yaml'): Config {
  const raw = parse(readFileSync(path, 'utf8')) ?? {};
  const inline: unknown[] = Array.isArray(raw.repos) ? raw.repos : [];
  const dir = reposDir(path);
  const fromFiles = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
      .map((f) => ({ ...parse(readFileSync(join(dir, f), 'utf8')), _file: f }))
    : [];
  // A repos/*.yaml file wins over a leftover block in config.yaml for the same repo.
  const names = new Set(fromFiles.map((r) => r.full_name));
  const repos = [...fromFiles.map(({ _file, ...r }) => r), ...inline.filter((r) => !names.has((r as { full_name?: string }).full_name))];
  return Config.parse({ ...raw, repos });
}

/** Writes repos/<owner>__<name>.yaml; comments in an existing file are not kept. */
export function writeRepoConfig(rc: RepoConfig, configPath = 'config.yaml') {
  mkdirSync(reposDir(configPath), { recursive: true });
  writeFileSync(repoFile(rc.full_name, configPath), stringify(rc, { lineWidth: 0 }));
}

export function repoConfig(cfg: Config, fullName: string): RepoConfig {
  const r = cfg.repos.find((x) => x.full_name === fullName);
  if (!r) throw new Error(`repo ${fullName} is not configured (repos/*.yaml or config.yaml)`);
  return r;
}
