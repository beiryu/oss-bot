Write the pull request title and description for a fix to issue #{{number}} in {{repo}}.
The repository with the change applied is at /work (read-only); the diff is in
/work/.oss-bot/PATCH.diff.

Look for the project's pull request template and follow its structure exactly: e.g.
.agents/pull-request-description.md, or a pull_request_template.md / PULL_REQUEST_TEMPLATE.md
(any case) in the repo root, .github/ or docs/, or a PULL_REQUEST_TEMPLATE/ directory.
In a checklist, tick only what the pipeline verified (the regression test and the
project's checks pass). Leave unticked every box about the human: CLA, self-review, and
any statement about AI use; the contributor ticks those after reading the change.

<untrusted_issue number="{{number}}" title="{{title}}">
{{issue_body}}
</untrusted_issue>

Coder's summary: {{summary}}

Rules:
- Plain, short, factual English. No marketing words, no emoji, no headings the template
  does not ask for.
- Title: imperative, under 72 characters, following the style of recent commit titles
  in `git log` (e.g. a "fix(module): ..." prefix if the project uses one).
- Body starts with "Fixes #{{number}}".
- Describe how the change was tested, naming the test added.
- Do not write anything about why the human contributor chose this issue in the body.
  Instead, put two short candidate reasons in "why" for the human to pick from: first
  person, one or two plain sentences each, in simple English a non-native speaker would
  write. Base them only on the issue and the change (e.g. what was missing and what the
  change protects against); never invent personal history, employers or usage. Make the
  two different in angle. Give each a Vietnamese translation in "vi".
- Do not write an AI or tool disclosure line and do not name any model: the bot appends
  the disclosure from the runtime's own records.

End your answer with exactly one JSON block (body is Markdown, newlines escaped):
```json
{"title": "...", "body": "...", "why": [{"en": "...", "vi": "..."}, {"en": "...", "vi": "..."}]}
```
