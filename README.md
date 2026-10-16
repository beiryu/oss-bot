# oss-bot

Finds small, fixable issues in open-source repos, has GitHub Copilot CLI (headless,
inside Docker; Claude Code also supported via `sandbox.runtime`) write a failing test and a fix, checks the result with a code-only gate and an
adversarial reviewer agent, and drafts the PR. **Nothing is posted to GitHub without you**:
claiming an issue, opening a PR and replying to review all go through `oss-bot approve …`.

Design notes: `../Orchestrator — tài liệu triển khai.md`.

## Pipeline

```
discovered → triaged → awaiting_claim ─(approve claim)→ claimed → reproduced → coded → gated → reviewed
           → awaiting_pr_approval ─(approve pr)→ pr_open → done          (any state → skipped)
gate fail / reviewer reject → back to reproduced, at most limits.max_attempts times
```

## Security model

- Agents and every build/test command run in the `oss-bot-sandbox` container. Only the
  issue's clone is mounted; never `~`, `~/.ssh`, `~/.copilot` or `~/.claude`. Gate/test
  containers get no credentials at all; agent containers get only the model credential.
- The agent's clone (including its `.git`) is untrusted. The host never runs git there:
  the patch is exported inside the container, read with symlink/escape checks, validated
  (no `.git/`, `..`, symlinks, submodules), and applied to fresh clones the host made.
  Push happens from such a clone with hooks and fsmonitor disabled.
- `copilot` runs with `--available-tools` + explicit `--allow-tool` grants (not
  `--allow-all-tools`, so the repo folder is never trusted and its hooks/MCP servers do not
  load), `--disable-builtin-mcps`, `--deny-tool=url`, `--secret-env-vars` (token stripped
  from the agent's shell), `--max-ai-credits` and `--usage-output-file` for accounting.
- With `runtime: claude`: `--setting-sources user`, `--permission-mode dontAsk`, a tool
  allowlist, `--max-turns`, `--max-budget-usd`.
- GitHub credentials stay on the host (`gh`).
- Known gap: containers have normal outbound network (package downloads and the model API need it),
  so a prompt-injected agent could still get at its credential and send it out. That is
  why the Copilot token must be a fine-grained PAT with **only** "Copilot Requests": a
  leaked one can spend AI credits but cannot touch any repo. Rotate it if a run looks odd.

## Setup

```bash
npm install
docker build -t oss-bot-sandbox docker/
gh auth login                                # PERSONAL account; host only (issues, push, PRs)
cp config.example.yaml config.yaml           # set github_user
echo 'export COPILOT_GITHUB_TOKEN=github_pat_...' > .env && chmod 600 .env   # Copilot PAT, see below
source .env
npm run -s oss-bot -- repo add https://github.com/owner/name   # fork, read the rules, draft + test the config
```

`repo add` forks the repo (after you confirm), mirrors it, gathers facts (how outside PRs
fare, review bots, labels, AI/CLA/DCO rules), lets the *scout* agent draft
`repos/<owner>__<name>.yaml`, runs the proposed gate on the unpatched default branch inside
the sandbox (the *doctor* agent repairs it when a step cannot run here), then shows the
summary, risks, manual steps and the YAML for a y/n/edit. Each repo is one file under
`repos/`; `repo remove <owner/name>` deletes it with its records and work dirs and prints the
`gh repo delete` command for the fork. `repo list` and `repo doctor <owner/name> [--fix]`
show and repair the state.

Why a separate Copilot token: `copilot` runs inside the container, which deliberately
cannot see your `~/.copilot` login or the macOS Keychain. Create a fine-grained PAT at
GitHub → Settings → Developer settings → Fine-grained tokens, **signed in as the account
that has the Copilot seat**: resource owner = that account, repository access = none /
public read-only, account permission **Copilot Requests: Read**, nothing else, short
expiry. Do not reuse the `gh` token: that one can push and open PRs.

Two identities: `gh` (comments, pushes, PRs) is the account named in `github_user`; the bot
pins every gh/git call to it even when another gh account is active on the machine. The
Copilot PAT may belong to another account and is only used to pay for model calls
(1 credit = $0.01; `oss-bot cost` shows it per agent).

## Use

```bash
source .env
npm run -s oss-bot -- run                       # one pass over every repo: follow up PRs, triage, advance one issue
npm run -s oss-bot -- run --repo o/n --triage-only   # only score the open issues of one repo
npm run -s oss-bot -- run --repo o/n --issue 123     # work on one issue you picked
npm run -s oss-bot -- inbox [--refresh]         # what needs you, open PRs (CI, review, conflicts), work in progress
npm run -s oss-bot -- show <id>                 # triage, diff, PR draft, drafted actions, agent log
npm run -s oss-bot -- approve <id>              # the claim or the PR of an issue (edit the text in $EDITOR first)
npm run -s oss-bot -- approve a<n>              # a drafted reply, fix commit, or rebase (force-push to your fork)
npm run -s oss-bot -- reject <id> | a<n>
npm run -s oss-bot -- cost
```

The bot never posts without `approve`. Every run ends with a notification (console, and
Telegram when `notify.telegram_chat_id` + `TELEGRAM_BOT_TOKEN` are set) that repeats the
"needs you" block of the inbox with the exact commands.

What a run does with an open PR: reads the PR state, CI checks, review decision and
mergeability in one call; merged → done, closed → `closed` (you are told); conflicts →
rebases (git 3-way, else the follow-up agent), runs the gate on the new base and drafts a
`rebase` action; failed CI (with the failed step's log) and new review comments go to the
follow-up agent, which drafts a reply, a fix, or waits. A gate step that also fails on the
unpatched base is an environment problem: the issue is marked blocked, no attempt is spent,
and `repo doctor --fix` is suggested.

Schedule with `launchd/dev.khanh.ossbot.plist` (every 2 hours, via `bin/oss-bot-run.sh`)
once a few manual runs look right.

## Tests

`npm test` covers patch validation, symlink/escape handling, the static gate, JSON
extraction and the state store.
