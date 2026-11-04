# Verification ownership and cost

Interlinked CLI should spend verification effort when it can produce a useful result,
and retain that result only within its demonstrated scope. The October 2026 push audit
found duplicate validation, late prerequisite failures and unnecessary background work.
The changes below preserve required test scope and coverage floors.

| Problem | Behavior |
| --- | --- |
| Daemon pre-tool checks repeated typecheck/tests before Git ran them again | For a recognized push, hand execution to a pinned copy of the mandatory Git hook. Unknown cases retain legacy checks. |
| E2E baseline or inventory errors appeared after a full unit run | Build the E2E-capable CLI once and preflight its prerequisites before the unit suite. Keep the measured E2E gate after execution. |
| Runtime hook logs changed the build identity | Exclude only untracked runtime-state candidates proven absent from build inputs. Retain declaration inputs, copied assets and unknown cases. |
| A comparison launched another test run after a push | Require `INTERLINKED_PRE_PUSH_COVERAGE_COMPARE=1`. `INTERLINKED_PRE_PUSH_SKIP_COVERAGE_COMPARE=1` still wins. |
| A brief capacity shortage required retrying the push | Wait within the existing admission/request deadline, respecting cancellation and unchanged resource limits. |
| The wrapper increased a requested smaller heap cap | Preserve the smaller absolute `NODE_OPTIONS` limit. Ambiguous and percentage limits produce no verdict. |
| Legacy pre-tool checks hid their cost | Record wait time, execution time, outcome, configured memory budget and sampled peak RSS. Missing samples remain missing. |
| Bounded edit hooks repeatedly planned a full suite they could not run | Retain the durable obligation and defer before project/host admission or inventory collection. Valid shared completions still take precedence. |

`node scripts/e2e-preflight.mjs` checks deterministic prerequisites only. It is not a
passing test or coverage receipt. The protected push still runs the full unit suite,
source coverage checks, E2E execution and strict measured E2E coverage. Packaging
retains its separate release-artifact build when required.

The comparison is an optional experiment. It runs after all authoritative consumers
of the export; enabling it can consume another full test run. Indexed coverage checks
and warm runs own cancellation through discovery, execution and evidence promotion.
An interrupted run cannot promote an accepted summary or supply a passing verdict.

The managed push handoff uses native command replacement on Codex and Claude. It
recognizes a narrow plain push to a protected ref and freezes the known hook, helper
source and required loader packages in a private bounded snapshot. The command pins
Git and Node and forces the snapshot's hooks directory. Git supplies the actual ref
updates to the hook, so a branch moving after preparation does not reuse an earlier
revision's result. Changed or unsupported inputs fall back to legacy checks during
preparation; a changed snapshot or execution context after preparation refuses to push.
The ordinary pre-tool safety checks remain active. This boundary does not defend
against an owner maliciously replacing the local operating system or executables
while they run. Native client approval policies still apply to command replacement.
After reviewing changes to the gate or its runtime closure, regenerate its trust map
with `node scripts/generate-managed-push-manifest.mjs`; `--check` verifies freshness.

General test selection and past-result reuse remain off by default. Earlier classifier
escapes showed that a plausible dependency closure can omit behavioral inputs. These
changes do not restore that classifier, equate Git ignore rules with irrelevance, or
reuse a passing report solely because its revision matches. Existing request coalescing
continues to require compatible obligations; a plain run cannot satisfy a coverage request.

Inspect `.interlinked/verification-stages.jsonl` with `interlinked query stages` to
distinguish execution cost, admission waits and deferred work. A deferred request is
still unverified. Do not sum overlapping request waits as elapsed wall time.
