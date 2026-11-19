# interlinked-observability: viz lenses

Reference for [SKILL.md](../SKILL.md). Read it to set up or read an `interlinked viz` lens.

Six lenses, each fed by its own SSE route:

| Lens | Route | Source | Shows |
|---|---|---|---|
| FILES | `/api/graph` + `/api/stream` | project graph + `activity.jsonl` | one dot per source file, one line per import, dot size = how many files depend on it; a touched file pulses in the colour of the agent that touched it |
| GATES | `/api/checks` | `check-results.jsonl` | one frame per tool call: which checks ran, which fired, allowed or blocked, `[proven]`/`[heuristic]` |
| AGENTS | `/api/agents` | `activity.jsonl` (folded) | one lane per agent session working in this repo, indented lanes for subagents it spawned: runner, model, calls/edits/blocks/warns, current tool + file, live-vs-idle |
| TESTS | `/api/tests` | `test-events.jsonl` | every test case in the order the runner finished it; pass/fail/skip, slow cases outlined, failure messages |
| MUTANTS | `/api/mutants` | `mutation-manifest.json` | every mutant, survivors first; live kill-rate; a tile flashes when its status flips |
| DRIFT | — | — | not built yet (standby pane) |

The AGENTS lens needs no producer: attributed activity rows carry `agent`, `session`,
`subagent_id`, `parent_agent`, and `model`, so presence is a fold over the stream the dashboard already tails
(`src/lib/viz/agent-roster.ts`, hosted at `/api/agents`). Each actor gets a stable hue from its
id, and that hue is reused for its ticker rows and its file pulses — with two sessions running,
colour alone answers "who did that". A subagent gets its OWN lane keyed under its parent, so a
session's own edits are never conflated with its subagents'. When a runner names the parent by
thread/session id, the roster resolves that id through the root lane's session before linking the
child. Lanes dim to idle after 2 minutes of silence rather than disappearing.

The TESTS lens needs a producer. Any repo using vitest adds one line:

```ts
// vitest.config.ts
reporters: ["default", "interlinked-cli/viz-reporter"]
```

Gating it behind an env var is the recommended setup, so a normal `vitest run` stays
byte-identical and only an explicit opt-in emits the feed — that is how interlinked-cli's own
`vitest.config.ts` wires it: `INTERLINKED_VIZ=1 npx vitest run`. Any equivalent conditional
works; nothing about the lens requires that variable name. The feed schema
(`.interlinked/test-events.jsonl`) is runner-agnostic — `{kind: run_start|file_start|test|run_end,
run_id, lane?, file?, name?, status?, ms?, error?}` — so a pytest/cargo adapter writes the same lines
and the lens renders unchanged. Every feed degrades to an honest empty state when its file is
absent; nothing about the dashboard is repo-specific.

The Interlinked CLI e2e config always registers the reporter; `test:e2e` also
sets `INTERLINKED_VIZ=1`. The TESTS lens groups files by `unit`, `integration`,
`e2e`, `base` or `unknown` lane. A bare Vitest run is `base`; old rows without
a lane remain `unknown`. Repository test rows are run evidence. Fixture
ledgers are assertion subjects and do not establish which coding session ran
the tests. The Stop nudge attributes e2e invocations through that session's
observed Bash commands instead.
