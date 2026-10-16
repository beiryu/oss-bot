import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Files where projects state their contribution rules, including rules about AI.
const CANDIDATES = [
  'CONTRIBUTING.md', 'CONTRIBUTING_GUIDE.md', 'CONTRIBUTING.rst', 'AGENTS.md', 'CODE_OF_CONDUCT.md',
  'PULL_REQUEST_TEMPLATE.md', 'AI_POLICY.md', '.github/CONTRIBUTING.md', '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md', 'docs/CONTRIBUTING.md',
];
const AI_TERMS = /\b(AI|A\.I\.|LLMs?|generative|GPT|ChatGPT|Copilot|Claude|machine[- ]generated|language models?|coding agents?)\b/i;

/**
 * Paragraphs that mention AI in the repo's contribution docs. The human reads these
 * and decides with `oss-bot repo allow|block`; no keyword list decides on its own.
 */
export function aiPolicyExcerpts(repoDir: string): { file: string; text: string }[] {
  const files = CANDIDATES.filter((f) => existsSync(join(repoDir, f)));
  const agentsDir = join(repoDir, '.agents');
  if (existsSync(agentsDir)) {
    files.push(...readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => `.agents/${f}`));
  }
  const out: { file: string; text: string }[] = [];
  for (const file of files) {
    const paragraphs = readFileSync(join(repoDir, file), 'utf8').split(/\n\s*\n/);
    for (const p of paragraphs) {
      if (AI_TERMS.test(p)) out.push({ file, text: p.trim().slice(0, 800) });
    }
  }
  return out;
}

export function formatExcerpts(ex: { file: string; text: string }[]): string {
  if (ex.length === 0) return '(no contribution doc mentions AI)';
  return ex.map((e) => `— ${e.file}:\n${e.text}`).join('\n\n');
}
