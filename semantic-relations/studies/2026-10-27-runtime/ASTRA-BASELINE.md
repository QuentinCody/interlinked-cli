# Astra code-inspection baseline — 2026-10-27

This is ordinary GPT-6 Astra source inspection **before viewing the runtime J/H predictions or experiment outputs**. It is a baseline for assessing incremental usefulness of semantic-relations, not ground truth, independent validation, or a reproduced-bug report. No runtime probes or tests were executed for this baseline. No production code was modified.

## Inspected boundary

Read `resource-command.ts`, `resource-cli.ts`, both requested unit-test files, `spawn-async.ts`, cancellation integration tests, heap/admission helpers, `scripts/run-resource-bounded.ts`, CLI dispatch in `src/index.ts`, relevant tests/coverage handlers, stage-ledger code, and the pre-push consumer. There is no `src/commands/resource.ts`: the bounded script and top-level CLI supervisor are the relevant entry points.

The existing design correctly separates a completed child's own exit 75 from `not-run`/`interrupted` using an outcome sidecar. `describeResourceCommandOutcome` treats a null exit code, timeout, or supervisor kill as interruption; a killed child that happens to return zero must not pass. Existing mocked tests and owner-cancellation integration tests cover substantial portions of this design. These are protections observed in source, not newly discovered defects.

## Prioritized hypotheses and discriminating checks

1. **POSIX launch failure may be presented as a completed failed check.** `resource-command.ts:120` launches `nice -n 10 <requested executable>`, while `commandStatus` and `describeResourceCommandOutcome` classify every non-null, non-killed exit as a verdict. If `nice` starts but cannot execute the requested target, its 126/127 can appear as `verdict: exit` and ledger `failed`, although the intended check never started. This is a classification hypothesis, not a false-pass claim. Run a unique nonexistent executable through the real bounded script; separately use a non-executable temporary file. Compare each with a real Node child deliberately exiting 127/126. Record stderr, exit, outcome JSON, and ledger. The controls must retain their actual child verdicts; blanket remapping of 126/127 would be wrong. A remedy, if needed, must distinguish target launch failure from target completion.

2. **External termination of a supervised CLI child may lose no-verdict diagnostics and telemetry.** `spawn-async.ts` documents `killed` as a signal sent by its own supervisor, and discards the OS signal argument on the `exit` event. An externally signalled child can therefore produce `code: null, killed: false, timedOut: false`. In `resource-cli.ts:79–80`, exit becomes 75, but the early return bypasses the interruption message and deferred ledger row when the owner's signal is also un-aborted. Contrast `resource-command.ts:101`, which explicitly checks null. Use a temporary owner importing `superviseResourceCli` and pass `[process.execPath, childPath, "verify", "--timeout", "5000"]`. The temporary child should emit a readiness marker then terminate itself with SIGTERM. Repeat with an external SIGKILL to that child only. Expect to inspect exit 75, no-verdict stderr, and an identity-null deferred `cli:verify` row; code inspection predicts the latter two may be absent. Compare with normal child exit 75 and with SIGTERM sent to the owner after readiness. This is an observability inconsistency unless a consuming workflow demonstrates a stronger consequence; it does not currently predict exit zero.

## Controls and bounded execution plan

Use separate temporary outcome and ledger paths per probe through `INTERLINKED_BOUNDED_OUTCOME` and `INTERLINKED_STAGES_LEDGER`; preserve ordinary host admission. For the bounded script use the light profile, for example:

```sh
node --import tsx scripts/run-resource-bounded.ts --light node -e 'process.exit(0)'
```

Repeat with explicit exits 1, 75, and 127. Expected completed-child results are `verdict: exit` with the exact code, and `passed` only for zero. Then use a child that self-signals SIGTERM: the bounded-command route should report `interrupted`, exit 75, and a deferred row. For owner cancellation, include a child whose SIGTERM handler exits zero; cancellation must still yield no verdict. Give each experiment an external watchdog, retain readiness markers, and clean up only the probe's own processes. If resource admission refuses the probe, record `not-run`; that is not evidence about the downstream hypothesis.

Run the existing focused unit tests and `resource-cli-cancellation.integration.test.ts` as regression context. The latter already exercises owner SIGINT/SIGTERM and termination-resistant descendants; it is not a substitute for signalling the child without signalling the owner. Avoid a real git push or memory-pressure stress test.

## Secondary inspection leads

- Invalid inherited heap syntax in `runSupervisedCli` prints NOT RUN and exits 75 without the deferred ledger row emitted for admission refusal or by `runResourceCommand`. A temporary owner can set `process.env.NODE_OPTIONS` *after startup* to exercise this branch without Node rejecting the owner's startup. This is a telemetry consistency question; stage writes are explicitly fail-open.
- A missing outcome sidecar is `unknown` in pre-push and currently falls through to the generic “failed” wording. Test this consumer in an isolated shell harness, not an actual push, if infrastructure failure versus check failure matters to operators. A successful child followed by sidecar-write failure is a useful distinct case.
- `testsCommand` catches planning/setup errors with `outputError`, which sets exit code 1. Thus an invalid `--cwd` is not a false pass. Whether setup failures should receive the no-verdict classification is a policy question, not an established bug.

## How to compare later semantic-relations findings

Freeze these hypotheses and probe expectations before revealing runtime J/H outputs. Credit a later result for a concrete additional edge case, a better distinguishing probe, or a correction supported by execution. Merely restating the two hypotheses, identifying a deterministic call edge, or predicting an existing tested protection adds little beyond this baseline. Record rejected suggestions and investigation time too. Successful probes can establish behavior in these cases; they cannot by themselves qualify deployment, prove general semantic accuracy, or establish model-label truth.
