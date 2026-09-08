import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        // `scripts/**` is included because seven sibling *.test.mjs files
        // already existed there and NONE of them ran — the glob stopped at
        // `src/`, so 33 passing assertions covering the build/codegen scripts
        // were dead weight nobody could tell was dead. All seven are offline
        // (URLs appear only as fixture strings), so they are CI-safe. The `.mts`
        // glob covers TypeScript script tests (build-steering-corpus.test.mts).
        include: ["src/**/*.test.ts", "scripts/**/*.test.mjs", "scripts/**/*.test.mts", "test/agent-driven/run-scenario.test.ts"],
        // Per-edit property-test budget (DW P0.1). Inert unless the per-edit
        // coverage runner sets INTERLINKED_PROPERTY_NUMRUNS — then fast-check's
        // case count is capped so property tests fit the tight per-edit latency
        // budget. Normal / CI / coverage runs (env unset) keep full numRuns.
        // home-sandbox FIRST: it must own HOME before any test module loads —
        // it is the suite-wide defense against tests (and Stryker mutants of
        // env-override fallbacks) writing into the user's real home.
        setupFiles: ["./src/test-setup/home-sandbox.ts", "./src/test-setup/property-budget.ts"],
        // Live test feed for `interlinked viz` — OPT-IN via INTERLINKED_VIZ=1.
        // Off by default so a normal `vitest run` keeps vitest's own reporter
        // output byte-identical (the harness parses it) and writes nothing to
        // `.interlinked/`. With the flag set, every finished case is appended to
        // `.interlinked/test-events.jsonl` and the dashboard's TESTS lens plays
        // the run back live. Same one-line opt-in any other repo uses.
        ...(process.env.INTERLINKED_VIZ
            ? { reporters: ["default", "./src/lib/viz/reporter-vitest.ts"] }
            : {}),
        // Integration tests spawn real `npx biome` / `tsc` / CLI subprocesses.
        // Under the worker-capped full-suite run (see `maxWorkers` below) a
        // cold start can take tens of seconds, so vitest's 10s default
        // produced timeout flakes that reddened `CI=1 npm test`. A 30s floor
        // gives ~3x headroom; genuinely-heavier cases keep explicit per-test
        // overrides (e.g. write.test.ts at 60s). hookTimeout matches so a slow
        // `beforeAll`/`afterAll` (biome warm-up, fixture I/O) is covered too.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // A single retry absorbs rare transient flakes without masking real
        // regressions — a genuinely broken test still fails on every retry.
        // Dropped 2 → 1 with the CI lane split (2026-07): the flaky real-git
        // tests now live in the integration lane with 120s timeouts, so the
        // aggressive double-retry (which tripled a flake's cost) is no longer
        // needed. One retry is the flake-tolerance floor.
        retry: 1,
        // Test isolation for the distilled-rules layer: the per-developer
        // `.interlinked/distilled-rules.json` (output of `/enforce`) varies
        // by whoever ran the skill against what — leaving it on means
        // evaluator tests pick up rules generated from the running dev's
        // AGENTS.md and assert against the wrong baseline. The opt-out
        // affects only `loadRules()`; tests that exercise
        // `loadDistilledRules` directly (e.g. `distilled-rules.test.ts`)
        // bypass this gate.
        env: {
            INTERLINKED_SKIP_DISTILLED_RULES: "1",
        },
        // CI-only parallelism cap. On macOS GitHub runners (the lower-
        // resource members of the matrix), running the full ~6700-test
        // suite with vitest's default parallelism produces enough
        // reporter IPC traffic to occasionally trip
        //   "[vitest-worker]: Timeout calling onTaskUpdate"
        // — every test passes, but the main↔worker RPC times out and
        // vitest exits non-zero, turning main red despite no real
        // regression. Capping concurrent worker threads in CI keeps
        // the IPC pressure under the timeout budget; local dev keeps
        // full parallelism (`undefined` lets vitest pick).
        //
        // Tracked symptom: CI run 25736848966 on commit 4d647ea (rerun
        // passed without any code change). The cap is pool-agnostic, so it
        // holds whether vitest picks the threads or forks pool.
        //
        // 2026-05-19: the 2-worker cap was no longer enough after the
        // supply-chain allowlist tests landed (+~150 tests, ~7800 total).
        // Three consecutive local pre-push runs on macOS hit the IPC
        // timeout despite all 7799 tests passing. Dropped to 1 worker in
        // CI to eliminate IPC contention entirely. Local dev keeps
        // unbounded parallelism via the `undefined` branch.
        //
        // 2026-06-02: Vitest 4's pool rework removed `poolOptions` and
        // unified the per-pool `{threads,forks}.max*` caps into one
        // top-level `maxWorkers`. One number now bounds concurrency
        // regardless of which pool vitest picks; `undefined` = vitest default.
        // Present only in CI (1 worker); absent locally so vitest picks its
        // default — a conditional spread instead of an explicit `undefined`,
        // which exactOptionalPropertyTypes rejects for an optional field.
        ...(process.env.CI ? { maxWorkers: 1 } : {}),
        // Coverage — opt-in via `--coverage` / `npm run test:coverage`; the
        // default `vitest run` stays uninstrumented and fast. The v8 provider
        // emits BOTH json (coverage-final.json → per-function, feeds CRAP via
        // file-checks-agent-safety.ts) and json-summary (coverage-summary.json
        // → per-file, feeds the coverage ratchet). reportsDirectory matches the
        // paths the harness readers already resolve. Keystone for the
        // local-first test-quality enforcement stack.
        coverage: {
            provider: "v8",
            // Scope strictly to our source. A custom `exclude` REPLACES vitest's
            // default exclude (which drops node_modules), so without an explicit
            // `include` the v8 provider instruments all of node_modules
            // (~3.6M statements, 16k files). `include` bounds it to src.
            // Scope to TS sources only. `src/**` also pulls in .md/.py/.json
            // sidecars, which v8's instrumenter can't parse (the C2 PARSE_ERROR).
            include: ["src/**/*.ts", "src/**/*.tsx"],
            // `lcov` (coverage/lcov.info) feeds the language-agnostic canonical
            // coverage model (`coverage-lcov.ts` → `coverage-canonical.ts`): the
            // same interchange format coverage.py / cargo-llvm-cov / gcov emit,
            // so the ratchet + CRAP consume every language through one parser.
            reporter: ["text-summary", "json", "json-summary", "lcov"],
            // Emit the report even when tests fail (vitest default withholds
            // it). 2026-08-09: ~204 tests fail ONLY under coverage mode (they
            // pass plain — subprocess/stdout interplay, root cause open), and
            // the withheld report starved every coverage consumer. A partial
            // report labeled by a red run beats no report.
            reportOnFailure: true,
            reportsDirectory: "coverage",
            exclude: [
                "node_modules/**",
                "coverage/**",
                "**/*.test.ts",
                "**/__tests__/**",
                "**/__fixtures__/**",
                "**/*.d.ts",
                "**/*.config.ts",
                "dist/**",
                "bench/**",
                "scripts/**",
                // C1 denominator fix: drop non-logic so coverage/CRAP measure
                // real code. Conservative — only codegen DATA, graph shards, and
                // the commander entry wiring. Commands/types stay IN scope (the
                // coverage goal targets every logic file, including them).
                "src/lib/hook-template-chunks/**", // @codegen-data: .mjs hook template strings
                "**/*.graph.ts", // Supermodel graph-shard data
                "src/index.ts", // commander entry-point wiring
            ],
        },
    },
});
