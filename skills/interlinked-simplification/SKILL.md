---
name: interlinked-simplification
description: "Find, review, record, and audit opportunities to delete, replace, defer, or shrink code with Interlinked's advisory simplification evidence. Load this for `simplify scan`, `simplify review`, `simplify audit`, `simplify status`, a simplification deep-review handoff, or when interpreting simplification findings, validation, overlap, and coverage. Use interlinked-quality-gates instead for metric ratchets, automatic obligation debt, or mutation enforcement."
---

# interlinked-simplification — evidence before removal

Interlinked's simplification surface finds code that may be unnecessary without treating static
signals as permission to delete it. Local analysis is deterministic, offline, advisory, and does
not invoke an LLM or apply a fix. The only optional write, `--record`, stores findings metadata;
it never edits source or changes the branch.

## Choose the scope

| Command | Scope and effect |
|---|---|
| `interlinked simplify scan [--cwd <path>] [--json] [--record]` | Run the deterministic repository scan. |
| `interlinked simplify review [--changed\|--staged\|--range <base..head>] [--deep-handoff] [--json] [--record]` | Emit findings for one git-selected path set while retaining whole-repo context. `--changed` is the default; the three selectors are mutually exclusive. |
| `interlinked simplify audit [--deep-handoff] [--json] [--record]` | Run the deterministic repository audit. `--deep-handoff` embeds a portable Agent CI request but does not submit it. |
| `interlinked simplify status [--cwd <path>] [--json]` | Read locally recorded run receipts and their materialized common-corpus findings. No network. |

`simplify audit` is intentionally distinct from top-level `interlinked audit verify`, which
checks the tamper-evident guard-decision chain. It is also distinct from `interlinked debt`,
whose `list`, `show`, and `resolve` verbs operate the automatic obligation ledger.

## Metrics deletion trials

The separate `metrics deletions [--cwd <path>] [--json]` command joins static redundancy
candidates with current coverage and exact-site mutation receipts. Public APIs, dynamic
consumers and missing measurements remain review blockers. A surviving mutant, including
paired forced-true/forced-false survivors, is not proof that source can be removed.

`metrics deletions validate plan.json [--timeout <ms>] [--json]` tests an explicit removal
plan in a disposable copy. Schema 1 edits specify relative paths, exact `sourceSha256`,
and UTF-16 half-open `start`/`end` ranges. Checks specify `kind` and argv; both `test` and
`typecheck` are required, with optional `build`. Baseline checks must pass before candidate
checks. A `checks-passed` verdict records only the supplied checks' scope, keeps review
required and leaves the source checkout unchanged. Use **interlinked-quality-gates** for
the associated receipt freshness, operator-policy and scoring contracts.

## The five remedy lenses

| Remedy | Question |
|---|---|
| `delete` | Is this code unused, duplicated, superseded, or behaviorally inert? |
| `stdlib` | Can a language standard-library facility replace the custom implementation? |
| `native` | Can an existing framework, platform, or already-approved dependency replace it? |
| `yagni` | Is the abstraction, option, factory, or seam speculative rather than currently needed? |
| `shrink` | Can the same supported behavior be expressed with less code or branching? |

The current local adapters cover JavaScript/TypeScript dead-code and mutation-disposition
evidence, the single-implementation-interface signal, private delegate-only wrappers, private
one-product factories, never-read configuration fields, root runtime dependencies without a
covered static import, and cyclomatic hotspots. They emit advisory `delete`, `yagni`, and
`shrink` candidates. `stdlib` and `native` replacement—and semantic safety for every remedy—still
require deeper review; a handoff requests all five without pretending the local scanner checked
them.

## Read the evidence literally

| State | What it supports |
|---|---|
| `candidate` | A lead worth review; no safety claim. |
| `heuristic` | A repeatable static signal that may still have runtime, framework, public-API, or test-seam consumers. |
| `proven` | A deterministic fact in the stated scope; not proof that a deletion preserves behavior. |
| `sandbox-validated` | A candidate patch passed independently recorded checks in an isolated executor. |

Every finding is advisory and `auto_fix:false`. Inspect its exact location, evidence, confidence,
replacement, repository identity, and validation receipt. Local runs set validated impact to
`null` because they do not create a patch or run typecheck, tests, security checks, or mutation.
`--record` persists the same evidence; it does not promote its state.

Estimated line/dependency deltas are prioritization hints. `overlap_group` is non-null only for a
connected component of intersecting known source spans or a shared dependency-removal claim;
same-file non-overlapping candidates stay independent. Never sum members of one group. Prefer
independently validated impact when it exists.

## Coverage is part of the result

Read `coverage.status`, selected/analyzed file counts, per-language/source status, exclusions,
missing paths, and limitations before making a repository-wide claim. Each source's
`analyzed_paths` is the exact sorted repository-relative read set; the top-level analyzed count is
their in-scope union, not a supported-extension count. Local detectors currently support JS/TS;
runtime loading, reflection, framework wiring, and public surfaces can escape static reachability.

An empty report means **“No findings in covered scope.”** It does not mean the repository is
globally lean. `partial` or `unavailable` coverage must remain visible in summaries and handoffs.

## Recording and reconciliation

Without `--record`, a report is ephemeral. With it, Interlinked appends a local run receipt to
`.interlinked/findings/simplification-runs.jsonl` and upserts each finding into the existing
`.interlinked/findings/corpus.jsonl` under `extensions.simplification`. Corpus IDs bind a stable
repository ID plus finding fingerprint, not the absolute checkout path. This is not a parallel
database, but generic `findings`/reconciliation commands still filter legacy review rows;
`simplify status` and `impact` are the current simplification-aware projections. `--record --json`
keeps stdout as the canonical simplification report.

Use `simplify status` to inspect recorded coverage and materialized findings. Recording is an
explicit user action: a scanner must not create a debt receipt or finding merely because a
candidate was deferred.

## Safe review workflow

1. Select the smallest useful scope; use `review` for a patch and `audit` for repository work.
2. Check coverage and evidence state before reading the ranked findings.
3. For a candidate removal or replacement, inspect runtime registration, public API,
   compatibility, security/trust boundaries, data-loss behavior, accessibility, and tests.
4. Make a source change only when the user's task authorizes it, then validate that patch with
   the project's typecheck/tests and any relevant security or mutation checks.
5. Record or reconcile the result explicitly; never infer validation from a clean static scan.

For deeper semantic work, emit `interlinked simplify review --deep-handoff --json` or
`interlinked simplify audit --deep-handoff --json`. A deep handoff requires readable non-null Git
commit and tree identities; ordinary local reports may retain nullable Git provenance. The
artifact is scope-bound, carries deterministic finding fingerprints, and says
`submission.status: not_submitted`. It is schema-portable but not submission-ready: internal
source-only Agent CI builders add workspace, inventory, exact-version capability, P4 v2 partition,
and request-bound P5 validation bindings. No Cloud job, Workflow, model, or Sandbox runs here.

## Related skills

- **interlinked-quality-gates** — metric water-lines, dead-code categorization, mutation evidence,
  automatic obligations, and manual debt-marker syntax.
- **interlinked-spec-audit** — prose-spec drift and the legacy review-finding reconciliation tools.
- **interlinked-observability** — evidence-classed `interlinked impact` reporting.
