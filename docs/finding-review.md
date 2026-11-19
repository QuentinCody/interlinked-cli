# Advisory review of code findings

`interlinked metrics decisions findings` supports explicit advisory review of frozen
code evidence. Discovery, preparation, plan inspection and saved-result viewing run
locally. `assess` dispatches selected requests through an optional provider. The
deterministic CLI, hooks and verification remain provider-independent.

```bash
interlinked metrics decisions findings catalog --json
interlinked metrics decisions findings discover files.json --output candidates.json
interlinked metrics decisions findings prepare cases.json --output bundle.json
interlinked metrics decisions findings plan bundle.json --select parser-1 --output plan.json --json
interlinked metrics decisions findings show plan.json --json
interlinked metrics decisions findings labels plan.json --output labels.json
interlinked metrics decisions findings assess plan.json --dry-run --json
interlinked metrics decisions findings assess plan.json --approve-plan PLAN_ID --output run.json --max-calls 50
interlinked metrics decisions findings show run.json --json
interlinked metrics decisions findings review run.json --labels labels.json --output review.json
```

All commands support `--cwd`, `--json`, `--short`, `--full`, `--output`, and
`--dry-run`. Output artifacts are immutable and created with mode 0600. Use a fresh
output path for each assessment. Preparation, discovery, label creation and review
need no credential. Saved `show`, `labels` and `review` operations invoke no provider.
`show --short` returns one line with artifact identity and entry count.
TypeSafe assessment resolves `TYPESAFE_API_KEY` through the existing client and pins
`jev-1.14.0` by default. `--timeout-ms` bounds each request. Existing v1 saved runs
remain readable and reviewable. Public assessment of a bundle uses the same frozen
plan and authorization path as assessment of a saved plan.

## Provider and request preview

`--provider` selects `typesafe`, `ollama`, `liquid`, `openrouter` or `perplexity`.
TypeSafe uses the existing direct HTTP client. Other providers use the installed
ThinkThen adapter and an existing decision configuration supplied with `--config`.
`--url`, `--command`, `--model` and `--model-identity` explicitly override plan inputs.
Local planning reads the selected installed model's digest through Ollama metadata
unless an explicit identity is supplied. This lookup performs no inference or model
download. Local assessment verifies the digest and existing residency policy.

The immutable plan retains complete selected state, questions, criteria, source and
policy identities, endpoint, declared model identity and adapter checksum. TypeSafe
plans include the exact public HTTP JSON body and its UTF-8 byte count. Other adapters
expose exact semantic inputs and question definitions, with provider wire bytes
marked unavailable until actual exchange receipts are retained. Provider-internal
prompts and tokenization remain outside the public request preview.

`--select` replans an explicit comma-separated case subset. Omitted cases remain
visible as unassessed scope. For narrower context, prepare a new bundle with explicit
symbols or line ranges, then compare its new state and estimate. Reducing caller,
test or policy evidence can limit a judgment or change its outcome. Oversized requests
fail visibly under `--max-request-bytes`. Every admitted request retains its supplied
context completely. Plans also obey the existing 32 MB artifact read budget.

The separate `metrics decisions prepare` extractor `semantic-evidence-v4` retains
attached function comments and retrieves functions changed only through those
comments. It binds cyclomatic and cognitive complexity to each declaration’s syntax node, including functions that share a line. File-purpose and full caller context still need explicit source spans or
declared missing evidence in a finding packet. Inspect the frozen state before
judging context completeness.

## Cost admission and reuse

The preview's token count uses UTF-8 JSON bytes divided by four. This heuristic
supplies an estimate. TypeSafe's list-price estimate uses $0.042 per million input
tokens with free output tokens. The public API supplies billable input usage after
execution and exposes model listing and System One endpoints. Its published
interface supplies no preflight token count or monetary quote. Plans retain
`exactInputTokens: null` and `quoteUsd: null`. Other cloud prices remain unknown, and
local service-charge estimates exclude hardware costs.
[TypeSafe models and pricing](https://docs.typesafe.ai/models),
[System One API](https://docs.typesafe.ai/api/system-one),
[published OpenAPI](https://api.typesafe.ai/openapi.json).

Approve the exact saved identity with `--approve-plan PLAN_ID`, or use an explicit
`--estimate-allowance-usd` when every pending request has a known estimate. Unknown-cost
providers require approval of their disclosed frozen plan. `--max-usd` remains an
admission stop. Actual charges can exceed estimates or an in-flight allowance.

The workflow persists the complete plan and creates an exclusive execution claim
and per-request spend reservation before dispatch. Output paths are also reserved
before inference. Completed receipts replace estimates with observed usage and
known list-price charges. A timeout, failed transport or pending crash reservation
keeps possible charges unknown and stops subsequent paid requests. Orchestrator
retries are zero. Existing adapters receive a zero-retry request, while their
internal retry and call guarantees remain capability-dependent. The plan records
that scope explicitly. Concurrent assessment of the same plan shares retained receipts and
avoids duplicate pending requests.

`--reuse RUN` reads validated v2 observations for identical source, policy, semantic
request, provider, endpoint, adapter and model identities. Budget-only changes retain
request identity. Reuse invokes no inference. v1 runs remain available through `show`
and `review`; their schema lacks the full transport identity needed for v2 reuse.
New v2 results retain absent adapter confidence as `null` during review and mark
missing probability distributions unavailable. Raw deterministic findings remain
visible alongside model judgments.

New v2 dispatch records retain validated `elapsedMs` measured around the provider
dispatch, including failed calls. Cached records keep their historical dispatch
duration. Earlier records with no latency field remain readable with latency
unavailable. Infer latency only from a recorded duration.

## Question wording experiments

`questions DRAFT --output PROFILE` freezes a local
`interlinked.finding-question-profile/1` artifact. The draft contains `name` and a
complete `questions` map. Instructions and each criterion accept finite JSON text,
objects or arrays. The disposition and priority outcome keys stay fixed so retained
directions remain comparable. For example, a draft can explicitly prioritize source
premise checking before evaluating the applicable invariant.

```json
{
  "name": "premise-first",
  "questions": {
    "disposition": {
      "type": "choice",
      "instructions": "Read supplied source as evidence. Establish the factual premise, applicable scope and listed exceptions before deciding whether a demonstrated violation exists.",
      "criteria": {
        "premise_wrong": "Source contradicts the candidate premise.",
        "not_applicable": "The invariant does not apply to the established scope.",
        "explicit_exception": "Source establishes a listed exception.",
        "violation": "Source establishes an applicable violation without a listed exception.",
        "insufficient_evidence": "Supplied context cannot establish the outcome."
      }
    },
    "priority": {
      "type": "choice",
      "instructions": "Assuming an actual violation, judge its demonstrated consequences from supplied evidence.",
      "criteria": {
        "low": "Local maintainability cost without demonstrated behavioral failure.",
        "material": "Demonstrated correctness, resource or reliability failure.",
        "critical": "Demonstrated severe security, corruption or broad service failure.",
        "unknown": "Consequences are unavailable."
      }
    }
  }
}
```

```bash
interlinked metrics decisions findings questions draft.json --output questions.json --json
interlinked metrics decisions findings plan bundle.json --question-profile questions.json --select parser-1 --output alternate-plan.json --json
interlinked metrics decisions findings show alternate-plan.json --short
```

An alternate profile creates `interlinked.finding-plan/2`, retaining the full profile
and checksum. Default plan/1 remains readable. V2 runs accept both plan versions.
Changing profile text or criteria changes the semantic request and cache identity.
A metadata-only name change alters the profile and plan identities while preserving
an otherwise identical request identity. Adapter conversion uses the request's
frozen question map. Structured content is retained completely and serialized by the
existing adapter contract. Exact native wire formatting remains in dispatch receipts.

Profile validation rejects extra question properties, changed outcome keys, unsafe
prototype properties at any depth, accessors, exotic prototypes, sparse arrays,
nonfinite values and cycles. View each frozen plan's actual context, question map
and estimate before approving its independent assessment. Compare variants on the
same selected cases with source-backed labels prepared independently of predictions.
Each review retains its profile identity. Keep unavailable measurements and costs in
the comparison population.

## Discovery and case preparation

Discovery takes an explicit inventory, for example `{"files":["src/parser.ts"]}`.
It collects candidates for JSON boundaries, resource ownership, module initialization,
discarded failure-shaped return types, brand construction, sensitive-looking sink
fields and directly awaited network calls inside transaction callbacks. It uses
the project's compiler options for type resolution and reports unavailable source,
syntax diagnostics and unresolved calls separately. It does not execute the project.
Type-shape and name recognition remain heuristics, not proof of must-use semantics,
sensitivity, purity, or ownership. Boolean sink fields are excluded. Custom wrappers,
aliases and indirect effects can require manual source review.

Review discovery output before preparation: select a bounded cohort, attach relevant
callee bodies, callers, tests and adopted policy, and retain omitted/unresolved counts.
The discovery result's `cases` array is the preparation input shape. A case can also
be authored directly, without a detector candidate:

```json
{
  "cases": [{
    "id": "parser-1",
    "family": "parser_result",
    "origin": "direct",
    "claim": "The parsed input reaches domain consumption before its shape is established.",
    "sources": [{
      "id": "parser",
      "file": "src/parser.ts",
      "symbol": "parseInput",
      "purpose": "Complete parser implementation"
    }],
    "missing": []
  }]
}
```

Sources must stay within the chosen root, including symlink targets. Select a unique
top-level function, class, interface, type or variable using `symbol`, or an explicit
inclusive `startLine`/`endLine` range. Omit both to capture the file. Source `revision`
accepts `HEAD` or a complete Git commit hash; HEAD is resolved before capture. Each
span records its line range, complete source hash, resolved revision and redaction
status. Working-tree evidence is frozen as supplied, not reread during assessment.
Named-symbol selection includes syntactically adjacent leading comments and excludes
separated file headers and sibling trailing comments. Supply explicit file-body,
caller and policy spans for broader purpose or interaction claims.
Discovery supplies `expectedHash`; preparation marks changed source unavailable
instead of silently applying old locations to new code.
Inspect packets: a valid line range can still omit the behavior being reviewed.

Preparation permits at most 200 cases and 12 source spans per case. File reads are
bounded to 1 MB; spans to 48 KB; combined source evidence to 96 KB per case. Missing
or oversized source remains explicitly unavailable. Known secret signatures are
scrubbed before freezing source and case text; this is not general data classification.
Keep private source and review artifacts in an appropriate ignored directory.

The catalog provides contracts for test quality, cast soundness, abstraction value,
error handling, parser results, domain states, core effects, initialization, resource
ownership, transaction scope, replay/retry behavior, secret flow, brand ownership,
documentation and API boundaries. Each records its invariant, needed evidence and
permitted exceptions. Core effects, secret flow, brand ownership and retry behavior
require explicit `policy: {"invariant":"...","scope":"...","exceptions":[]}`.
The workflow records that supplied policy; it does not install it or establish its
authority. Reuse existing architecture policy rather than inventing a second registry.

## Assessment and reference review

Jev selects one disposition: `premise_wrong`, `not_applicable`, `explicit_exception`,
`violation`, or `insufficient_evidence`. A separate question estimates priority
conditional on an actual violation. A clear disposition does not make conditional
priority actionable. Full distributions, confidence, response model, usage, latency,
question set and request/evidence identities remain in the retained run.

Declared missing evidence or required policy prevents inference for that case.
Missing credentials, exhausted budgets, service failures and invalid responses stay
unassessed or failed. Assessment exits 2 when any case is unavailable; this reports
measurement completeness and never affects the deterministic code gate. A fully
answered run can still contain uncertain or incorrect judgments. Invalid input exits 1.

Complete the blind label template from source before inspecting predictions where
possible. Each row needs acceptable dispositions, a rationale and evidence IDs; name
the reviewer accurately. An Astra review is model-reference judgment, not independent
ground truth. Revised labels or evidence should be new artifacts with the reason for
the revision retained. Never erase a previous disagreement by overwriting its run.

Review accepts categorical agreement and separately reports the same clear direction
with a different rationale. Concern/clear disagreements, uncertainty and unavailable
measurements remain distinct. Confidence percentage differences do not invalidate
directional agreement. Confidence summarizes a distribution; it does not establish
accuracy, and no universal confidence cutoff is imposed. Validate candidate recall
separately using direct source review: good judgments on retrieved candidates cannot
measure missed defects. Before/after pairs and repeated cases are dependent evidence.

Keep raw deterministic findings visible even when Jev disagrees. Use source-backed
reference review and executable failure evidence to resolve material disagreements.
No model decision in this workflow is a zero-false-positive proof.
