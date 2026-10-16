The CI gate oss-bot runs for {{repo}} fails on the project's own unpatched default branch, so
it cannot tell whether a change is good. Propose a gate that runs here.

The repository is at /work (read-only). Gate commands run there in a Linux container with:
Go, Node 22, Python via uv, git, make, gofmt. There is NO Docker, no databases, no
Kubernetes, no cloud credentials, and only the module proxies are reachable. Anything that
needs those cannot run here and must be left to the project's own CI.

Current gate (each entry is one bash command, run in order; all must exit 0):
{{gate_json}}

Current focused test template (the test name is filled in at run time):
{{focused_test}}

What failed on the base:
<failures>
{{failures}}
</failures>

{{repo_notes}}

Read how the project itself runs unit tests without external services: Makefile targets
(e.g. test-unit), .github/workflows/*.yml, CONTRIBUTING*, build tags, environment switches
such as SKIP_INTEGRATION=1 or -short. Prefer the project's own switch; exclude whole
packages or directories only when no switch exists. Keep the static steps (gofmt, go vet,
build, diff --check) unless one of them is what fails. Keep the gate testing only the
packages touched by the change, as it does now. Do not add steps.

End your answer with exactly one JSON block:
```json
{"gate": ["..."], "focused_test": "...", "notes_append": "one line for the repo notes explaining the switch, or empty", "explanation": "one or two sentences"}
```
