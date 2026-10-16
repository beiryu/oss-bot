You are resolving GitHub issue #{{number}} in {{repo}}. The repository is at /work.
Do not commit.

Read the project's rules first: AGENTS.md, then .agents/coding-conventions.md and
.agents/testing.md (or CONTRIBUTING*.md if those do not exist), and follow them.

<untrusted_issue number="{{number}}" title="{{title}}">
{{issue_body}}
</untrusted_issue>

{{test_section}}

{{repo_notes}}

{{feedback}}

Rules:
- Make the smallest change that does what the issue asks (for a bug: fix the root cause).
- Do not reformat, rename or refactor unrelated code. Do not touch build files, CI
  config or dependencies.
  Paths the gate rejects outright: {{forbidden_paths}}. If the issue cannot be resolved
  without them, stop and say so (done=false) instead of working around it.
- If the issue is a proposal or an open design question the maintainers have not settled
  (it asks to discuss first, lists options without picking one, or the project's rules
  require agreement before a PR), stop and say so (done=false): no change can be accepted
  until they decide, and another attempt would read the same.
- Keep the change as small as the fix allows; no unrelated cleanups.
- Delete any scratch files you created.
- Run the relevant tests and the cheap checks named in the project's rules (formatting,
  linters, license headers) before you finish.

End your answer with exactly one JSON block:
```json
{"done": true, "summary": "what the issue needed and what the change does", "filesChanged": ["path"]}
```
