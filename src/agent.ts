import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { readAgentFile } from './git.js';
import { execSandbox } from './sandbox.js';

// Test vars are pasted into the focused_test shell command, so only plain names and paths.
export const safeTestVars = (vars: Record<string, string>) =>
  Object.values(vars).every((v) => /^[\w./:*#-]+$/.test(v) && !v.split('/').includes('..'));

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), 'prompts');

// Tool access per agent; each runtime maps these to its own tool names.
const READ = 'read' as const;
const WRITE = 'write' as const;
type Access = typeof READ | typeof WRITE;

export const AGENTS = {
  triage: {
    access: READ, maxTurns: 15,
    schema: z.object({ feasible: z.boolean(), score: z.number().min(0).max(1), reason: z.string() }),
  },
  reproducer: {
    access: WRITE, maxTurns: 40,
    schema: z.object({
      reproduced: z.boolean(),
      testFiles: z.array(z.string()),
      testVars: z.record(z.string(), z.string()),
      notes: z.string(),
    }),
  },
  coder: {
    access: WRITE, maxTurns: 60,
    schema: z.object({ done: z.boolean(), summary: z.string(), filesChanged: z.array(z.string()) }),
  },
  reviewer: {
    access: READ, maxTurns: 20,
    schema: z.object({
      verdict: z.enum(['approve', 'reject']), reasons: z.array(z.string()),
      // The regression test itself is wrong or weak: only the reproducer may change it.
      redoTest: z.boolean().default(false),
      // False when no rework could get it merged, so the issue is dropped instead of retried.
      retryable: z.boolean().default(true),
    }),
  },
  'pr-writer': {
    access: READ, maxTurns: 8,
    schema: z.object({
      title: z.string().max(120), body: z.string(),
      // Candidate "why" sentences the human picks from (or rewrites) at approve time.
      why: z.array(z.object({ en: z.string(), vi: z.string() })).max(2).default([]),
    }),
  },
  followup: {
    access: WRITE, maxTurns: 40,
    schema: z.object({ action: z.enum(['reply', 'fix', 'wait', 'close', 'human']), message: z.string() }),
  },
  // Drafts a repo's config from its docs and the facts `repo add` gathered.
  scout: {
    access: READ, maxTurns: 25,
    schema: z.object({
      config: z.record(z.string(), z.unknown()).default({}), summary: z.string(),
      risks: z.array(z.string()).default([]), manual_steps: z.array(z.string()).default([]),
    }),
  },
  // Proposes a gate that runs in the sandbox when the configured one fails on the base.
  doctor: {
    access: READ, maxTurns: 15,
    schema: z.object({
      gate: z.array(z.string()), focused_test: z.string(),
      notes_append: z.string().default(''), explanation: z.string(),
    }),
  },
} as const;

export type AgentName = keyof typeof AGENTS;
export type AgentResult<A extends AgentName> = z.infer<(typeof AGENTS)[A]['schema']>;

/** Fills {{vars}} in one pass, so text inside a value (e.g. an issue body) is never re-expanded. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in vars ? vars[k] : all));
}

/** The last parseable JSON object in the text: a ```json fence if there is one, else the last {...}. */
export function extractLastJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const f of fences.reverse()) {
    try { return JSON.parse(f[1]); } catch { /* try the next one */ }
  }
  const end = text.lastIndexOf('}');
  for (let i = text.lastIndexOf('{', end); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try { return JSON.parse(text.slice(i, end + 1)); } catch { /* widen */ }
  }
  throw new Error('no JSON object in agent output');
}

export class AgentError extends Error {}

interface RunUsage { cost: number | null; inputTokens: number | null; outputTokens: number | null; models: string[] }
interface RunTrace extends RunUsage { lastTools: string[] }
interface RuntimeRun {
  argv: string[];
  env?: Record<string, string>;
  parse: (stdout: string, outDir: string) => RunUsage & { text: string };
  /** What a run that died before answering (timeout, crash) got through, read from its live log. */
  trace?: (outDir: string) => RunTrace | null;
}

const ClaudeOutput = z.object({
  result: z.string().default(''),
  is_error: z.boolean().default(false),
  subtype: z.string().optional(),
  total_cost_usd: z.number().default(0),
  usage: z.object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) }).partial().default({}),
  modelUsage: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

function claudeRun(cfg: Config, access: Access, maxTurns: number, prompt: string): RuntimeRun {
  const tools = access === WRITE ? ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] : ['Read', 'Grep', 'Glob'];
  return {
    argv: [
      'claude', '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(cfg.budget.max_cost_per_call_usd),
      // Never load .claude/settings*.json from the repo under test: it could define hooks.
      '--setting-sources', 'user',
      '--permission-mode', 'dontAsk',
      '--allowedTools', tools.join(','),
      ...(cfg.sandbox.model ? ['--model', cfg.sandbox.model] : []),
    ],
    parse(stdout) {
      const out = ClaudeOutput.parse(JSON.parse(stdout));
      if (out.is_error) throw new AgentError(`claude error (${out.subtype}): ${out.result.slice(0, 500)}`);
      return {
        text: out.result, cost: out.total_cost_usd, models: Object.keys(out.modelUsage),
        inputTokens: out.usage.input_tokens ?? null, outputTokens: out.usage.output_tokens ?? null,
      };
    },
  };
}

/** Sums numeric fields whose key matches `re`, anywhere in a JSON value. */
function sumKeys(v: unknown, re: RegExp): number | null {
  let total: number | null = null;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x)) {
        if (typeof val === 'number' && re.test(k)) total = (total ?? 0) + val;
        else walk(val);
      }
    }
  };
  walk(v);
  return total;
}

/**
 * Reads Copilot's --usage-output-file (observed in 1.0.95: totalNanoAiu, totalPremiumRequestCost,
 * modelMetrics, ...). The schema is undocumented, so tokens are matched by key name.
 */
export function parseCopilotUsage(usage: unknown) {
  const nanoAiu = (usage as { totalNanoAiu?: unknown } | null)?.totalNanoAiu;
  const metrics = (usage as { modelMetrics?: Record<string, unknown> } | null)?.modelMetrics;
  return {
    // 1 AI credit = $0.01; the file counts them in billionths.
    cost: typeof nanoAiu === 'number' ? nanoAiu / 1e9 / 100 : null,
    // modelMetrics is repeated under agentMetrics.*, so sum only the top-level copy.
    inputTokens: sumKeys(metrics ?? usage, /^(total_?)?input_?tokens$/i),
    outputTokens: sumKeys(metrics ?? usage, /^(total_?)?output_?tokens$/i),
    // The models that actually answered, for the PR's AI disclosure.
    models: Object.keys(metrics ?? {}),
  };
}

/**
 * Reads Copilot's session log (events.jsonl, written as the run goes, observed in 1.0.95):
 * the last tool calls and the spend so far. Lines that do not parse are skipped.
 */
export function parseCopilotEvents(text: string, keep = 15): RunTrace {
  const tools: string[] = [];
  const models = new Set<string>();
  let nanoAiu: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const line of text.split('\n')) {
    let ev: { type?: string; timestamp?: string; data?: Record<string, any> };
    try { ev = JSON.parse(line); } catch { continue; }
    const d = ev.data ?? {};
    if (ev.type === 'tool.execution_start') {
      const a = d.arguments ?? {};
      const what = a.command ?? a.path ?? a.pattern ?? JSON.stringify(a);
      tools.push(`${ev.timestamp ?? ''} ${d.toolName}: ${String(what).replace(/\s+/g, ' ').slice(0, 300)}`);
    } else if (ev.type === 'session.usage_record' && d.usage) {
      if (d.usage.model) models.add(d.usage.model);
      if (typeof d.usage.inputTokens === 'number') inputTokens = (inputTokens ?? 0) + d.usage.inputTokens;
      if (typeof d.usage.outputTokens === 'number') outputTokens = (outputTokens ?? 0) + d.usage.outputTokens;
      // Per request; they add up to the session total in usage.json.
      const n = d.usage.copilotUsage?.totalNanoAiu;
      if (typeof n === 'number') nanoAiu = (nanoAiu ?? 0) + n;
    }
  }
  return {
    lastTools: tools.slice(-keep), models: [...models], inputTokens, outputTokens,
    cost: nanoAiu === null ? null : nanoAiu / 1e9 / 100,
  };
}

function copilotTrace(outDir: string): RunTrace | null {
  const states = join(outDir, 'copilot', 'session-state');
  if (!existsSync(states)) return null;
  const session = readdirSync(states, { withFileTypes: true })
    .find((e) => e.isDirectory() && existsSync(join(states, e.name, 'events.jsonl')));
  if (!session) return null;
  return parseCopilotEvents(readAgentFile(outDir, join('copilot', 'session-state', session.name, 'events.jsonl')));
}

function copilotRun(cfg: Config, access: Access, prompt: string): RuntimeRun {
  const tools = access === WRITE
    ? ['view', 'glob', 'grep', 'edit', 'create', 'apply_patch', 'bash', 'read_bash', 'write_bash', 'stop_bash', 'list_bash']
    : ['view', 'glob', 'grep'];
  const allow = access === WRITE ? ['read', 'write', 'shell'] : ['read'];
  return {
    argv: [
      'copilot', '-p', prompt, '-s',
      '--no-auto-update', '--no-ask-user', '--no-color',
      // The built-in GitHub MCP server would act with the token; agents never talk to GitHub.
      '--disable-builtin-mcps',
      `--available-tools=${tools.join(',')}`,
      // Explicit grants rather than --allow-all-tools/COPILOT_ALLOW_ALL, which can also trust
      // the folder and load the repo's hooks and MCP servers.
      ...allow.map((a) => `--allow-tool=${a}`),
      '--deny-tool=url', '--deny-tool=memory',
      // Strips the token from the agent's shell environment, not just from output.
      `--secret-env-vars=${cfg.sandbox.auth_env}`,
      `--max-ai-credits=${Math.max(30, Math.round(cfg.budget.max_cost_per_call_usd * 100))}`,
      '--usage-output-file=/out/usage.json',
      ...(cfg.sandbox.model ? [`--model=${cfg.sandbox.model}`] : []),
    ],
    // Copilot's state dir, session log included, lands in /out so it survives a killed run.
    env: { COPILOT_HOME: '/out/copilot' },
    trace: copilotTrace,
    parse(stdout, outDir) {
      let usage: ReturnType<typeof parseCopilotUsage> = { cost: null, inputTokens: null, outputTokens: null, models: [] };
      if (existsSync(join(outDir, 'usage.json'))) usage = parseCopilotUsage(JSON.parse(readAgentFile(outDir, 'usage.json')));
      return { text: stdout, ...usage };
    },
  };
}

export async function runAgent<A extends AgentName>(ctx: { cfg: Config; db: Db; runId: string | null }, opts: {
  agent: A;
  issueId: number | null;
  workdir: string;
  readOnly?: boolean;
  vars: Record<string, string>;
}): Promise<AgentResult<A>> {
  const def = AGENTS[opts.agent];
  const { cfg, db } = ctx;
  const token = process.env[cfg.sandbox.auth_env];
  if (!token) throw new AgentError(`${cfg.sandbox.auth_env} is not set`);

  const prompt = fillTemplate(readFileSync(join(PROMPTS, `${opts.agent}.md`), 'utf8'), opts.vars);
  const run = cfg.sandbox.runtime === 'copilot'
    ? copilotRun(cfg, def.access, prompt)
    : claudeRun(cfg, def.access, def.maxTurns, prompt);
  // Per-call scratch dir for runtime outputs (usage file), outside the repo checkout.
  const outDir = resolve('data', 'agent-out', randomUUID());
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const sandboxRun = {
    dir: opts.workdir, readOnly: opts.readOnly, outDir, cmd: run.argv,
    env: { ...run.env, [cfg.sandbox.auth_env]: token }, timeoutMin: cfg.sandbox.agent_timeout_min,
  };
  const r = await execSandbox(cfg, sandboxRun);

  let out: ReturnType<RuntimeRun['parse']> | undefined;
  let parsed: AgentResult<A> | undefined;
  let error: string | undefined;
  let trace: RunTrace | null = null;
  try {
    out = run.parse(r.stdout, outDir);
    if (r.exitCode !== 0) throw new AgentError(`exit ${r.exitCode}: ${out.text.slice(-500)}`);
    parsed = def.schema.parse(extractLastJson(out.text)) as AgentResult<A>;
  } catch (e) {
    error = r.timedOut ? 'timed out' : String(e instanceof Error ? e.message : e);
    error += `\nstderr: ${r.stderr.slice(-1000)}`;
    try { trace = run.trace?.(outDir) ?? null; } catch { /* no log, nothing to add */ }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  // A killed run has no usage file; its log still says what it spent.
  const usage = out?.cost != null ? out : trace ?? out;
  db.recordCall({
    runId: ctx.runId, issueId: opts.issueId, agent: opts.agent, startedAt, durationMs: Date.now() - started,
    inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
    costUsd: usage?.cost ?? null, ok: !error, models: usage?.models ?? [],
    resultJson: JSON.stringify(error
      ? { error, result: out?.text ?? r.stdout.slice(-4000), ...(trace ? { lastTools: trace.lastTools } : {}) }
      : { parsed, result: out!.text }),
  });
  if (error && trace?.lastTools.length) error += `\nlast steps:\n${trace.lastTools.slice(-5).join('\n')}`;
  if (error || !parsed) throw new AgentError(`${opts.agent} failed: ${error}`);
  return parsed;
}
