# Hook feedback implementation and evaluation

Implemented and evaluated on 2026-09-25. The change reduces repeated feedback while
retaining full check evidence and meaningful blocks. It does not implement a transaction
across separate tool calls.

## Changes

| Area | Implemented behavior | Validation |
| --- | --- | --- |
| Hook command | Non-gating events use a short missing-runtime diagnostic. Gating events retain the self-contained recovery program. | Native command, missing-runtime, cold-fallback and installer tests. |
| Diagnostic output | New blockers appear once; pre-existing compiler findings show a count and evidence path. Repeated advisories are acknowledged per session/check/file and reset by a successful scoped check. Full raw findings remain recorded, including sibling findings and events without a tool-call ID. | Screenshot-shaped regression: one new compiler error plus 18 pre-existing findings; repeated findings, resolution, sibling retention and simultaneous blocking reasons. |
| Write attribution | A declared write target is distinguished from a concurrent workspace change. Unknown-writer TypeScript findings are workspace feedback; they do not block the observing tool. Security checks and workspace obligations remain active. | Declared-writer, read-only observer and security positive controls. |
| Routine telemetry | Scheduled overlays, ordinary metric pulses and shadow trajectory output go to captured observations. Over-cap, unavailable and failed checks remain actionable. | Ledger assertions and real hook/daemon pulse test. No hidden finding can produce an all-clean claim. |
| Edit granularity | Cognitive complexity no longer blocks a sub-cap increase solely because it exceeds four points in one edit. Hard caps and existing-debt rules remain. Cyclomatic already had no slew rule. | One-step versus split growth, plus cap-crossing controls. |
| Scratch probes | JS/TS patch-applier detection follows bounded, statically resolved write destinations instead of treating a read path or fixture contents as a write target. | Temporary fixture, copy/rename destination, mutable binding, and actual repository-write cases. Unknown expressions are not treated as proven writes; filesystem observation remains the backstop. |
| Test evidence | The warning now describes the existing evidence contract: recognized runner summaries can establish piped test outcomes; an unsummarized pipeline exit alone is insufficient. | Existing test-outcome and pipeline regressions. |
| Evaluation | Repeatable frozen-build comparison, native transcript measurement, fixed scenarios and corrected target-correlated retry metrics. | Five evaluator tests; independent task assertions; per-session native receipts and artifacts. |

No blanket test-file advisory exemption was added: the review did not establish a
specific detector and safe exemption. Cross-call feedback batching and a full fallback
launcher redesign remain separate work. Agent guidance now recommends coherent patches
and cohesive helpers; sending several tools in one message does not create a transaction.

## Measured results

The main experiment ran six tasks, five repetitions per task, two counterbalanced arms:
60 live Claude Code sessions using the resolved `claude-fable-5` model. Each session
used a separate fixture and daemon, frozen distribution, bounded invocation, and
evaluator-owned functional assertions. All native transcripts were captured.

| Measure | Baseline | Candidate | Interpretation |
| --- | ---: | ---: | --- |
| Correct completions | 30/30 | 30/30 | No observed correctness regression in this pilot. |
| Rendered hook-context bytes | 168,506 | 150,068 | 10.9% less context under the defined transcript proxy. |
| Completed edit calls | 58 | 54 | 6.9% fewer; the paired interval includes no improvement. |
| Attempted tool calls | 221 | 220 | Essentially unchanged. |
| Total elapsed task time | 711.59 s | 700.14 s | 1.6% lower; the paired interval includes no improvement. |
| Hook duration p50 / p95 | 103 / 360 ms | 102 / 354 ms | No meaningful speed claim. |
| Blocks | 6 | 1 | Interpreted alongside unchanged blocking controls, not as an independent quality score. |

The complexity task used 15 versus 10 edits across five sessions per arm, with mean
completion time 34.7 versus 23.9 seconds. This is a task-specific result, not evidence
that every kind of coding becomes faster. Module, rename, read and probe tasks had
higher candidate mean elapsed times in this small sample.

The exploratory paired bootstrap interval for mean candidate-minus-baseline rendered
bytes was -909 to -334 bytes per session. For elapsed time it was -4.22 to +3.39 seconds;
for edit count, -0.30 to +0.03. Five repetitions per task cannot establish small
correctness differences or reliably characterize rare failures.

The fixed native-hook experiment used ten under-cap edits to the same file:

| Scenario | Baseline | Candidate and final release |
| --- | --- | --- |
| Combined hook response bytes for ten edits | 15,558 | 4,197 (73.0% less) |
| Cognitive growth from 10 to 15 under the configured cap | Denied | Allowed |
| Repository read plus unrelated temporary-fixture write | Denied | Allowed |
| Hard-cap crossing | Denied | Denied |
| Actual scratch patch applier writing repository source | Denied | Denied |
| Destructive-command PreToolUse payload | Denied | Denied |
| Read through cold fallback | Allowed, fallback recorded | Allowed, fallback recorded |

The destructive command was submitted as a hook payload and was never executed.
All warm scenarios required a daemon transport receipt. The fixed fixtures had
unconfigured external checks, whose real NOT CHECKED feedback remained visible;
these edits must not be described as fully verified clean edits.

The generated project-path PostToolUse command shrank from 9,215 to 1,306 UTF-8 bytes
(85.8%). PreToolUse remained 25,277 bytes. This command-length comparison is separate
from measured hook response bytes and model context; it does not establish token
or billing savings.

## Evidence and limitations

The baseline distribution was preserved before implementation. The working tree also
contained concurrent unrelated development, and its starting source was newer than
the installed distribution. This is a frozen **whole-build pilot**, not a causal
estimate for each individual patch.

After freezing the main candidate, two evidence edge cases were fixed: capturing
findings without a tool-call ID, and retaining a new blocker when another phase already
supplies the blocking reason. Focused tests and four additional live sessions (module
and complexity, one pair each) qualified the final release: 4/4 correct. The final fixed
scenario run reproduced the candidate outcomes and 4,197-byte total. Those four
qualification sessions are kept separate from the main 60-session comparison.

Rendered context bytes count native Interlinked hook attachments preceding a later
assistant response, include provider wrappers, and deduplicate transcript UUIDs.
Terminal-only records and the unconsumed transcript tail are excluded. This proxy
does not expose the provider's complete internal prompt, tokenizer accounting, or
invoice. Recorded ledger warnings are not delivery counts. Native usage categories
and client-reported list-price estimates are retained separately in the machine report.
Only Claude Code was evaluated with live model sessions; other client coverage here
comes from adapter, installer and protocol regressions.

Local raw evidence is intentionally ignored by git:

- [Main scorecard](../scratch/2026-09-25-hook-feedback/report/scorecard.md) and [machine report](../scratch/2026-09-25-hook-feedback/report/comparison.json).
- Fixed [baseline](../scratch/2026-09-25-hook-feedback/fixed-baseline/result.json), [candidate](../scratch/2026-09-25-hook-feedback/fixed-candidate/result.json), and [final release](../scratch/2026-09-25-hook-feedback/fixed-release/result.json).
- [Final-release qualification log](../scratch/2026-09-25-hook-feedback/release-qualification.log).
- [Deployment hashes and daemon status](../scratch/2026-09-25-hook-feedback/deployment.json): the live daemon and hook entry matched the qualified release, both transports were healthy, and the build was current at capture.

## Validation and operation

### Follow-up from the real Unit F session (2026-09-25)

The native session `6b1de038-98d3-4a77-8185-f302b5fc4478` supplied a concrete timing
counterexample: four same-file edits (options, use `targetOf`, define it, import its
type) were emitted in one assistant message before the first missing-name feedback.
Across Unit F, 28 of 45 TypeScript post-tool blocks had another same-file edit already
emitted in that message. This is evidence of intermediate-state feedback, not proof
that all 45 errors were false or that every extra edit was a retry.

Follow-up implementation covers native compiler batches with durable recovery,
coverage/content/test-evidence delivery deduplication, line-numbered runner summaries,
isolated evaluator telemetry tests, and reconciliation of stale installed skills.
The batch event runs after every tool has resolved, before the next model request;
its blocking response cancels the loop, so repairable compiler findings use context
and remain enforced at Stop/commit. Contract:
[Claude Code PostToolBatch reference](https://code.claude.com/docs/en/hooks#posttoolbatch).

The new native-process regression reproduces the four-edit sequence and includes a
deliberately invalid final assignment as a positive enforcement control. Source-unit
tests additionally cover provider/session isolation, restart recovery, unavailable
compilers, and edits arriving during validation. No improvement to model call count
is assumed from compiler execution or feedback reductions alone.

### Follow-up measured results

| Check | Per-edit control | Native batch |
|---|---:|---:|
| Same four edits, same built daemon and final source | 4 edits | 4 edits |
| Recorded compiler checks | 4 | 1 |
| Intermediate missing-name diagnostics | 2 | 0 |

The native batch also reported a deliberately retained TS2322 error, blocked Stop,
and refused an unsafe `eval` edit immediately. These are real child hook/daemon
processes using a real compiler; the control is the same build before a session has
demonstrated PostToolBatch support. It is not a model-agent benchmark or a claim
about fewer tool calls. Reproduce with:

```sh
npx vitest run --config vitest.e2e.config.ts src/e2e/compiler-batch.e2e.test.ts
```

A separate counterfactual replay feeds captured Unit F warning text through the
current delivery functions. It yields coverage blocks **92 → 4**, pre-edit content
advice **25 → 3**, and test-evidence notices **21 → 1**: **138 → 8** blocks and
**36,513 → 1,847 bytes** (94.9% less selected warning text). These are individual
warning blocks, not the earlier count of hook attachments; one attachment can contain
multiple coverage lines. This replay does not rerun the model or compiler and excludes
unrelated warning families. Evidence: `followup-delivery-replay.json` under the
scratch evidence directory.

The deployed daemon was also probed with two native PostToolBatch events in one fresh
session. The first produced 657 combined stdout/stderr bytes (the coverage notice is
mirrored); the second produced zero. Both observations remained in check-executions,
with delivery flags true and false respectively. See `followup-live-delivery.json`.

Follow-up validation: **500 focused tests passed**, native compiler control/treatment
tests and the pulse test passed, both TypeScript checkers passed, and build/docs checks
passed. The final full suite reported **59,155 passed, 39 failed, 6 expected failures,
10 skipped**, across 2,499 files. All seven remaining failing files also failed in the
captured pre-follow-up run: pre-push fixture scripts, stale inventory/catalog/demo
expectations, and Biome-dependent content/diff/multi-edit cases. Six previously failing
files were repaired, with no new failing file in the full-suite comparison. The full
suite is therefore still not green; its log is `followup-final-full-suite.log`.

Deployment refreshed Claude/Codex hooks in preserve-mode and restarted the daemon.
The recorded status showed PID 36635, raw/framed sockets answering, no framed errors
or timeouts, and `build_stale: false`. Four stale installed skill files were reviewed,
backed up under `installed-skill-backups/`, and refreshed from canonical source. All
five affected skills passed validation. The unrelated unowned `enforce` copy was
preserved; it still causes two installer ownership warnings. Router routing did not
change. An existing model conversation may retain old guidance already in its context.

### Original release validation

The original release validation included 212 passing release regression tests, 110 passing phase tests,
41 passing evidence-edge tests, 25 passing native E2E tests across protocol, cold
fallback and pulse suites, and five evaluator tests. These runs overlap; their counts
must not be added as a unique-test total. Broader focused runs are retained in the
evidence directory. This was not a run of the entire repository test suite.

Both TypeScript checkers, the build, generated-doc check and `git diff --check` passed.
The hook registrations were refreshed with `install-hooks --refresh --preserve-mode`,
and the daemon was rebuilt and restarted. Raw and framed transport health was checked.
Concurrent workspace activity can change the running build after these observations;
frozen experiment distributions remain separate from the live installation.

Skill-impact review updated the source harness, verify, quality-gates, observability
and setup skills; all five passed the skill validator. Router behavior did not change.
The normal managed-skill refresh preserved locally modified or unowned installed
copies it refused to overwrite; source guidance is the reviewed contract. See the
[refresh log](../scratch/2026-09-25-hook-feedback/refresh-skills-final.log) for those copies.

Reproduction commands and artifact requirements are in [evals/README.md](../evals/README.md).
The comparison drivers and tests are versioned; model runs require explicit `--run`.
