# Local standards measurements

`metrics standards` measures the pinned `dmmulroy-typescript` guidance profile.
Every pass runs locally and exports `modelCalls: 0`. The report retains all 35
source groups, including guidance that requires additional context. Each group
keeps `compliance: null`.

```bash
interlinked metrics standards --profile dmmulroy-typescript --cwd /path/to/repo --json
interlinked metrics standards --profile dmmulroy-typescript --scope product --short
interlinked metrics standards --profile dmmulroy-typescript --full > standards.json
```

The default profile is `dmmulroy-typescript` and the default scope is `all`.
`--cwd`, `--json`, `--short` and `--full` also work before `standards` on its
`metrics` parent. Unknown profiles and scopes fail before source scanning.

Normal output includes every standard's counts and measurement state. Short
output prints one summary line. Full and JSON output export the complete
`interlinked.standards-report/1` structure with every occurrence, retained
discovery case, source unit, method coverage record and context gap.

## Source provenance

The profile references dmmulroy's published guidance at revision
`db1b93212222dc5b1a723e48aedb2ed1835b1ed7`. Its source SHA-256 is
`059a56054945277ea835ebcbf2030bb6613113c2cd066226f88e1424e7307642`.
Each group retains its original line range and range hash alongside a brief
paraphrased title. The public profile contains measurement mappings and source
attribution. [Pinned guidance source](https://gist.github.com/dmmulroy/9c80f1f499b031aa0b6525b5d9ae25f0)

## Evidence and coverage

| Field | Interpretation |
|---|---|
| `astOccurrences` | Written JS/TS syntax matching the mapped AST patterns |
| `detectorMatches` | Raw matches from mapped fully deterministic registry detectors |
| `semanticCandidates` | Name/shape patterns, partially deterministic or heuristic check matches and discovery candidates requiring review |
| `discoveryCandidates` | The subset retained as existing finding-workflow cases |
| `suppressedMatches` | Raw detector matches carrying inline or file suppression metadata |
| `configurationObservations` | Known boolean settings for the five mapped compiler options |

Counts can overlap across groups and across methods. Review each occurrence's
rule, source span, text and determinism before interpreting it. Identifier names
establish a syntactic pattern. Binding, ownership, behavior and adopted policy
require further evidence.

The inventory retains every discovered role and its denominator. `--scope product`
selects product JS/TS for measurement while preserving the all-role census.
Unsupported languages, unreadable files, parser failures, missing registry
capabilities and unresolved calls remain explicit. Foreground discovery and final snapshot
validation use the same resource policy, without implicit file-count, source-body-size,
Git deadline or Git output-capture limits. Filesystem fallback follows the shared explicit
inventory exclusions and retains enumeration failures. Failed discovery in a known Git
worktree remains unavailable; it does not silently replace Git ignore scope. OS limits
still apply, and synchronous native operations do not provide cooperative cancellation.

The optional CLI TypeScript compiler supplies AST and compiler-metadata passes.
Inherited JSON configuration is read without running target scripts or compiler
plugins. Absent compiler flags remain `null`. Discovery reuses its existing strict,
allow-JS, no-emit, skip-lib-check configuration with JS checking disabled. Its
unresolved discarded-call count describes that specific population.

Typed discovery uses one compiler population for all selected files, including
unimported global declarations across the population. Its foreground source
admission has no implicit 1 MB per-file cutoff or 10000-file compiler partition.
The selected-review discovery API retains its default runtime bounds unless its
caller explicitly selects foreground survey policy.

Detector counts retain observed matches. Some detectors still apply traversal or
result limits, so their counts remain lower bounds. `measuredFiles` records that
the detector executed on a file. Consult retained method gaps and the detector's
predicate before interpreting coverage. Participating foreground detectors collect
all recognized results through an invocation-local collection policy. Their
ordinary runtime result bounds remain in place. The following twenty-eight mapped
functions participate, comprising the earlier five and twenty-three additional
collection repairs.

| Family | Check IDs |
|---|---|
| Error and boundary evidence | `throw_literal`, `promise_reject_non_error`, `unvalidated_json_boundary`, `json_stringify_error`, `catch_rewrap_loses_cause`, `resource_handle_leak`, `lossy_error_rethrow`, `error_dispatch_by_instanceof`, `unvalidated_input_boundary` |
| Type and module evidence | `non_null_assertion`, `double_cast_unknown`, `discriminated_union_exhaustiveness`, `import_from_own_barrel`, `public_api_leaks_internal_type`, `jsdoc_param_drift` |
| Function and class review | `floating_promises`, `boolean_trap`, `positional_optional_boolean`, `many_optional_params`, `same_typed_primitive_params`, `hybrid_class`, `fuzzy_responsibility_name` |
| Test evidence | `mocking_the_sut_self`, `mock_only_test`, `catch_without_assertion_guard`, `mock_return_echo`, `mocking_the_sut`, `private_member_test_access` |

Standards evidence runs the listed registry detectors with this collection policy.
Foreground verification uses it for their existing verify integrations, subject to
the requested check selection. The existing phase coverage of
`public_api_leaks_internal_type`, `jsdoc_param_drift` and
`unvalidated_input_boundary` remains registry/census-only. Large-result verify
accumulators and inline-suppression repacking append observations individually to
preserve populations beyond JavaScript's function-argument ceiling.

Recognition boundaries remain detector-specific. Examples include twenty-line
parameter signatures, sixty-line floating-promise statements, twelve-line API
signatures, twenty-thousand-character test-call spans and adjacent-line validator
recognition. The own-barrel foreground walk follows the complete reachable static
value-edge population within its declared directory scope. Runtime retains its
64-module budget; exhausted or unsupported graph inputs become unavailable evidence.
Actual resolved return edges and exact own-package specifiers remain distinct
observations, neither of which alone proves a runtime bug. Per-unit aggregation, such as one
observation per signature, retains its existing meaning. These collection repairs
establish complete retention within the participating predicates.

Source units reuse `semantic-evidence-v3` stable function identities and attached
adjacent comments. Snapshot IDs also bind the captured source hash and exact
function span. Occurrences reference enclosing units. Line-only detector locations
may reference multiple enclosing functions. Module-level syntax has an empty unit
list. Unit context retains `callers: "not_collected"` and
`filePurpose: "not_established"` until the workflow receives that evidence.

`provenance.sourceConsistency` compares selected source hashes and the discovered
path population at the end of the census. Changed, missing or added inputs remain
visible. Failed final discovery makes consistency inconclusive instead of inventing
deleted paths. Compiler dependencies and configuration are live read-only inputs with
separate limitations and metadata hashes.

The shared action inventory retains raw AST occurrences and deterministic detector
matches as `measurement`, semantic/discovery observations as `candidate`, and
unavailable evidence as `evidence_gap`. Source spans distinguish observations on
the same line. `evidenceRefs` retain occurrence, unit, case and source identities;
`producerRefs` link original report records and captured profile, inventory and
suppression identities. These classifications describe the captured evidence and
keep enforcement at `report`.

When a mapped detector supplies `sourceEvidence`, raw occurrences and action
evidence retain its producer/consumer file, line and captured SHA-256. Projection
uses those supplied snapshots without reading supporting files again. Conflicting
primary or supporting source versions leave action freshness `unknown` while
retaining every supplied observation.

Suppressed rows retain their classification and explicit suppression metadata.
The census captures suppression bytes once before detector execution and applies
that parsed snapshot throughout the run. `suppressionPolicy` retains the applied
identity plus a final comparison. A missing policy is ordinary absence. An invalid
capture retains unknown suppression state and an evidence gap; inline suppression
evidence can still establish a known suppression. Runtime loaders retain their
existing behavior.

Action export also retains registry/unit measurement notices, unresolved-call
counts, discovery failures and missing case context, compiler settings and
diagnostics, inventory failures, per-standard unknown context and source-snapshot
changes. Known compiler booleans are measurements; absent settings remain gaps.
Normal method limitations remain report limitations. Candidate cases retain every
source reference and source-less cases retain an explicit evidence gap.
Selected `discovery.cases` can enter
`metrics decisions findings prepare` with explicit contracts and context. The
finding workflow supplies its own selection, preview and spend controls for
optional assessment.
