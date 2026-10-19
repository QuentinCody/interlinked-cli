# Test-planning performance, October 6, 2026

The operator requested savings measured in seconds without removing checks,
loosening security or quality policies, or reducing verification coverage.

Two internal optimizations preserve the complete test plan:

- Companion lookup indexes every matching `.test.` and `.spec.` prefix once per
  plan. It preserves nested `__tests__` matches, prefixes within directory names,
  all matching sources and their inventory order.
- Dependency analysis retains content-derived module summaries in a process-local
  LRU cache. Keys include path and a SHA-256 of the actual source bytes, including
  extra fixture modules. Import targets are resolved against the current inventory
  every time. The cache retains neither ASTs, resolved edges nor test verdicts.
  It is capped at 8,192 entries and 8 MiB of serialized key/summary accounting;
  JavaScript object overhead is additional. Restarting the daemon clears it.

Static selection and execution-result reuse remain disabled by default. Test
deadlines, queue obligations, execution budgets, project sweeps and Biome launching
are unchanged. Invalid syntax and unavailable analysis remain uncertain.

## Verification

The focused planner, graph, runtime-effects and scheduler suites passed 177 tests.
Both TypeScript compilers and the build passed. Regression cases cover multiple
companions, prefix collisions, changing fixture bytes, unresolved/import-target
changes and callers mutating a previously returned graph.

The local comparison used the pre-change planner and dependency-graph implementations
saved before editing, against the same captured repository inventory (about 5,100
files and 2,673 tests). Every field of the resulting plans compared equal, including
selected/omitted tests, reasons, uncertainty, snapshot and classifier telemetry.

| Planner scenario | Before | After |
| --- | ---: | ---: |
| Warm process, default policy | 12.030 s | 0.254 s |
| Warm process after one in-memory source edit | 12.304 s | 0.104 s |
| Experimental static-selection opt-in | 11.034 s | 0.098 s |

These are single paired observations under concurrent workspace load, not latency
percentiles. The benchmark supplies a known changed source and no shared setup
files, exercising the formerly quadratic companion-selection path and default
classifier telemetry. A forced-full plan already bypasses that lookup and benefits
primarily from cached module analysis. Cold analysis still took about 5.7 seconds.
Native discovery, inventory reads, subprocess execution and hook scheduling are
outside these planner measurements; whole-hook savings have not been established.

Local reproduction and raw measurements are in
`scratch/test-plan-performance/compare.mjs` and `results.json`, with the saved
pre-change source beside them. No benchmark assertion or test verdict is reused
by the production harness.
