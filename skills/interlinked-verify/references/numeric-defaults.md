# Numeric zero-default advice

`numeric_zero_default` is a heuristic post-edit warning, included by
`interlinked verify --all-checks`. It records a source relation. If a numeric
parser returns zero, a logical-or default selects its right operand. Review the
caller's intended zero/default contract. A deliberate zero sentinel may be valid.

Supported producers are unshadowed runtime `Number`, `parseInt`, `parseFloat`,
`Number.parseInt` and `Number.parseFloat`. Stable local result bindings and
one-hop relative imports of stable raw parser wrappers supply additional
provenance. A wrapper must synchronously return a directly resolved numeric
parser call with stable parameter forwarding. Supported exports include named
functions, default function declarations, named constant arrows and local export
aliases. Async functions and generators return other kinds of objects.

Literal numeric zero, negative zero and resolved same-value constant defaults are
excluded. Nullish operators and normalized outputs are outside this logical-or
predicate. Local value declarations and module imports prevent builtin
attribution. Source-visible parser or receiver mutation, reassigned numeric
bindings and relevant opaque numeric contracts retain unavailable evidence.

If zero should survive numeric conversion, distinguish invalid numeric input
explicitly, such as with a NaN check. Nullish coalescing alone preserves NaN and
cannot supply a general repair. The warning supplies no gate or metric threshold.

## Project and runtime scope

Foreground verification uses its selected invocation snapshots. Current source
overlays replace dependency bytes, and relevant deleted dependencies remain
unknown. Forward findings belong to the logical-or caller's source coordinate.
Complete foreground populations retain every recognized occurrence with source
spans. The detector has no hidden per-file result count or body-size ceiling.

PostToolUse can reuse the already-maintained reverse-import candidate index for
helper-only edits. A helper-local warning names the proved consumer coordinate.
The maintained importer index remains partial, including after initialization.
The detector rereads current candidate dependencies within a fresh invocation and
memoizes their bytes there. Standalone evaluation starts no repository scan or
compiler program.

Supporting parser and consumer paths, exact captured source hashes and line
coordinates are retained as `sourceEvidence` in verify findings, actions and
structured runtime check-results v2. Hashes bind the captured dependency versions.
They establish no claim that every dependency was discovered or is still current.
The older observation-v1 schema retains its existing line/text scope.

Advisory missingness uses the same check ID with unavailable measurement state
and zero finding count. Hook receipts preserve it in `advisoryGaps`. Required
completed checks can settle their pending version normally. This advice creates
no required retry loop or Stop gate.

## Coverage limits

Arbitrary opaque helpers supply no numeric provenance. A fresh unresolved
arbitrary import does not manufacture a numeric gap from its name. A previously
resolved numeric helper lost within the invocation can retain an explicit gap.
General alias/control-flow analysis, package imports, namespace imports,
re-export chains, dynamic imports and arbitrary normalizers remain outside the
initial cross-file wrapper relation. Ambient monkey-patching outside selected
evidence and unmodeled object escapes can also limit builtin attribution.

An executed detector or an empty result does not prove complete semantic
coverage. Exact arithmetic source observations retain heuristic review status.
