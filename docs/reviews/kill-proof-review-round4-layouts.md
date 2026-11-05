# Kill proof — adversarial review, round 4: module systems and vitest layouts

Branch reviewed: `mutation-proof` at `681e705` (round-3 fixes landed). Reviewer: cloud session, 2026-11-05,
branch `cloud/falsifier-round4-layouts`. Method: throwaway git repos under `/tmp/kp4/<name>` (node_modules
symlinked to the clone's, or a directory of per-package links plus `vite-tsconfig-paths@5` installed with
`npm install --ignore-scripts`), driven through the real command
`npx tsx src/index.ts tests prove-kill --cwd <repo> … --json`, then `tests kill-proofs --verify` where a
binding claim was at stake. Every REPRODUCED wrong verdict or unbound input is a red case in
`src/harness/kill-proof/review-regressions-round4-layouts.test.ts` (11 cases, **11/11 fail** on this branch,
`npm run typecheck` clean). No product code was changed.

Scope was the seven layout families the fixtures never covered: plain-JS module systems, vitest workspaces,
config resolution, path aliases and resolvers, transforms and mocks, globals / setup files / child processes,
and a source file that is only a test helper.

## Findings

| id | severity | class | where | status | test |
|---|---|---|---|---|---|
| M1 | **medium** | wrong verdict | `run.ts:98-116` `mutantParses`, `run.ts:118` `containsJsx` | REPRODUCED | N1, N2 |
| M2 | **medium** | receipt binding | `receipt.ts:76` `resolveVitestConfig`, `receipt.ts:82` `configDeclaredInputs`, `receipt.ts:98` `captureEnvironment` | REPRODUCED | N3, N4 |
| M3 | **medium** | receipt binding | `receipt.ts:82-96` `configDeclaredInputs` (text regex over one file) | REPRODUCED | N5, N6 |
| M4 | **medium** | receipt binding | `receipt.ts:90` (setup path resolved against the config's directory) | REPRODUCED | N7 |
| M5 | **medium** | false `unavailable` | `run.ts:182` `missingVitest`; `snapshot.ts:75` (copy links `<root>/node_modules` only) | REPRODUCED | N9 |
| M6 | low | reason quality | `fail-before-fix/index.ts:69` `runVitestDetailed` (stderr dropped); `classify.ts:70` `parseVitestReport` (suite `message` dropped) | REPRODUCED | N10, N11 |
| M7 | low | false `unavailable` | `run.ts:261` `join(root, options.vitestConfig)` | REPRODUCED | N8 |
| A1 | low | wrong-ish verdict | `run.ts:98` (dialect = extension only) | ARGUED | — |
| A2 | low | documentation | `run.ts:299` canary reason text; guide "Limits" | ARGUED | — |
| A3 | low | policy | `run.ts:200` `targetProblem` | ARGUED | — |
| A4 | low | validation | `run.ts:261` (config outside the root passed through) | ARGUED | — |
| A5 | low | receipt binding | `receipt.ts:124` `receiptId` (environment variables not bound) | ARGUED | — |
| A6 | cosmetic | normalization | `receipt.ts:62` `declaredVitestConfig` (config path recorded as the script spelled it) | ARGUED | — |

### M1 — a `.js` file that already holds JSX cannot be proven at all (wrong verdict)

Round 3 (L6) made the parse check refuse JSX in a `.js`/`.ts` file. The check looks at the MUTATED bytes only, so a
file that already held JSX — the CRA-era React layout, still common — fails it for every mutant, including one
that touches a comment. The project's own vitest runs the file (a `enforce: "pre"` plugin calling vite's
`transformWithOxc(code, id, { lang: "jsx" })`), and the BASELINE ran green in the copy, which proves the runtime
accepts the file:

```
.js holding JSX, comment-only mutant        verdict: INCONCLUSIVE  EXIT=2   "contains JSX, which .js files cannot hold; a compile error is not a kill"
.js holding JSX, class="badge" → "chip"     verdict: INCONCLUSIVE  EXIT=2   (same)                          — the test would fail by assertion
.js holding JSX, <span> → <em>              verdict: INCONCLUSIVE  EXIT=2   (same)
```

Fix direction: refuse JSX only when the ORIGINAL file held none (introduced-only, the same rule the pre-block gate
uses), or classify from the mutant run's actual load failure instead of predicting it.

### M2 — `test.projects`: the project config and its setup files are not bound (receipt binding)

In a workspace root (`vitest.config.ts` with `test: { projects: ["packages/*"] }`, vitest hoisted to the root),
`--cwd <root> --test packages/a/test/math.test.ts` works and KILLS. The receipt binds the ROOT config and
`setupFiles: []`. The file that selected the tests and declared the setup is `packages/a/vitest.config.ts`, and
`packages/a/test/setup.ts` ran (the fixture's second case asserts a global it sets):

```
receipt 81824c67  killed   config: vitest.config.ts   setup: []
edit packages/a/test/setup.ts (41 → 40) and packages/a/vitest.config.ts; tests kill-proofs --verify → FRESH  EXIT=0
live vitest with the edited setup: × setup ran                                  (the file matters)
```

Round 3 N9 bound setup files for the single-config layout; the projects layout re-opens it. Fix direction: bind
every project config vitest would load for the named files (vitest can print the resolved config), and their
`setupFiles` / `globalSetup`.

### M3 — setupFiles declared through an imported helper are not bound (receipt binding)

`vite.config.ts` doing `import { testOptions } from "./config/test-options"; export default defineConfig({ test:
testOptions })` is a common shape (shared options across a vite app and its tests). `configDeclaredInputs` is a
regex over the config file's own text, so it sees no `setupFiles:` at all:

```
vite.config.ts → config/test-options.ts { setupFiles: ["./test/setup.ts"] }     verdict: KILLED   setup: -
edit test/setup.ts AND config/test-options.ts → --verify                        FRESH  EXIT=0
```

The helper is itself unbound: it decides `include` and `setupFiles` and can change without staling the receipt.
Same class as the documented "an edited helper does not stale a receipt" limit, but this helper is CONFIG, which
the receipt claims to bind. Fix direction: ask vitest for the resolved config (or bundle the config the way vite
does and hash the bundle's inputs).

### M4 — a config in a subdirectory binds the wrong setup path (receipt binding)

`scripts.test = "vitest run -c ./configs/vitest.unit.mts"` with `setupFiles: ["./test/setup.ts"]`. vitest
resolves setup files against the PROJECT ROOT (`<cwd>/test/setup.ts` ran; the fixture asserts it). The receipt
resolves them against the config's directory (`configs/test/setup.ts`, which does not exist, so it is dropped
silently):

```
verdict: KILLED   config: ./configs/vitest.unit.mts   setup: -
edit test/setup.ts → --verify  FRESH
```

The same config placed at the root (`vitest.config.cjs`) binds `test/setup.ts` and goes STALE on the same edit —
so the binding depends on where the config lives. Fix direction: resolve against `test.root` / the project root,
as vitest does.

### M5 — hoisted vitest: the guide's monorepo advice fails (false `unavailable`)

The guide says "A monorepo root without its own `vitest` is `unavailable`; run with `--cwd <package>`." In a
hoisted workspace (npm/pnpm/yarn default), the package has no `node_modules` and `npx vitest` from the package
finds the root's. prove-kill refuses:

```
--cwd /tmp/kp4/mono/packages/a   verdict: UNAVAILABLE — vitest is not installed in this project; v1 of prove-kill runs vitest only   EXIT=2
```

`missingVitest` checks `<root>/node_modules/.bin/vitest` only, and the copy would link only `<root>/node_modules`.
So a hoisted member can be proven only from the root — where M2 mis-binds the receipt. Fix direction: walk up for
the nearest `node_modules` holding vitest, and link THAT into the package copy.

### M6 — startup and load failures are anonymous (reason quality)

Every vitest failure that produces no per-case rows reads the same. Three different causes, one message:

```
packages/a config imports ../../vitest.shared (not in the package copy)   UNAVAILABLE — baseline run failed: vitest wrote no JSON report
test file does require("vitest") in a CJS package                        UNAVAILABLE — test/math.test.js reported no executed test case in the baseline copy
mutant adds a decorator to an enum / TS annotation in .jsx / import of a missing file   INCONCLUSIVE — no result under the mutant
```

vitest said, respectively: `failed to load config … Could not resolve '../../vitest.shared'`, `Vitest cannot be
imported in a CommonJS module using require()`, and a file-level error with the offending import. The first is on
stderr, which `runVitestDetailed` discards; the other two are the suite-level `message` in the JSON report, which
`parseVitestReport` drops because it keeps `assertionResults` only. Not a false pass, but the user cannot act on
the verdict. Fix direction: keep the last stderr lines on a no-report run, and surface `testResults[].message`
as the reason for a file with no cases.

### M7 — an absolute `--vitest-config` is "does not exist" (false `unavailable`)

`--vitest-config /tmp/kp4/cfg2/vitest.config.cjs` → `UNAVAILABLE — /tmp/kp4/cfg2/vitest.config.cjs does not
exist`, because the existence check is `existsSync(join(root, options.vitestConfig))`. The relative spelling of
the same file works. Low, but it is the spelling a shell completion produces.

### Argued

- **A1 — ESM/CJS semantics are vitest's, not Node's.** In a `.mjs` source, a mutant that adds `module.exports =
  {}`, `const fs = require("node:fs")` or `const d = __dirname` is SURVIVED (exit 1): vitest's module runner shims
  all three, while Node's ESM loader throws at load. Likewise `export { clamp }` in a `.cjs` file under a CJS
  package runs fine under vitest and is SURVIVED, although Node refuses it. The parse check models the dialect by
  extension only (JS vs TS vs JSX), not the module system. The verdict is true for the runtime certified
  (the receipt binds vitest), so this is a documented-limit candidate, not a bug; "survived" here does send the
  agent to strengthen a test for a mutant that would never ship. A `.cts` file with an `export` mutant IS
  caught — as an anonymous load failure (M6).
- **A2 — cross-package imports in a workspace are never provable.** `import { mul } from "@mono/b"` resolves
  through `node_modules/@mono/b → ../../packages/b`, i.e. into the LIVE tree, so from the root the canary turns
  every mutant in `packages/b` into `UNAVAILABLE` ("an absolute path, an alias or a link into the live tree").
  Fail-closed and correct, but the message never says "workspace link", and the guide's Limits section does not
  say that the standard monorepo layout is out of scope beyond "run with `--cwd <package>`" (which M5 refuses).
- **A3 — a manual mock is product code.** Mutating `src/__mocks__/math.ts` (used through `vi.mock("../src/math")`)
  yields `KILLED` and a receipt: a proof over a mock. `targetProblem` knows `node_modules` and test paths only.
- **A4 — a config outside the project is passed through.** `--vitest-config ../cfg/vite.config.ts` is not refused;
  it is handed to vitest in the copy, where it does not resolve, and ends as "vitest wrote no JSON report" (M6).
- **A5 — the environment is not part of the receipt.** `configs/vitest.env.mts` reading `process.env.KP_SETUP`
  runs a setup file when the variable is set and none when it is not (NOT-PASSING-NOW, correctly). The two proofs
  have the same id and the same bound config sha; the second overwrites the first and nothing records which
  environment produced the kill.
- **A6 — config path spelling.** The receipt records `./configs/vitest.unit.mts` exactly as `scripts.test`
  spelled it; the same file named through `--vitest-config configs/vitest.unit.mts` records `configs/…`. The
  sha256 is what the id binds, so this is cosmetic.

## Tried and did not break

Plain JavaScript (family 1):
- CommonJS package (no `type`), `.js` source with `module.exports`, test doing `const { add } = require("../src/math")` after `import … from "vitest"`: minus KILLED, comment SURVIVED. The same source through `import { add } from "../src/math.js"` (ESM-import of CJS): KILLED.
- `.cjs` source + `.test.cjs`: KILLED. `.mjs` source + `.test.mjs` with no `type` field: KILLED / SURVIVED.
- `type: "commonjs"` TypeScript project: `.ts` KILLED; `.cts` via `require("../src/legacy.cts")` KILLED; `.mts` via `../src/modern.mjs` specifier KILLED.
- `.js` test importing a `.ts` source: minus, `enum` member and `namespace` body all KILLED; comment SURVIVED.
- JSX: `.jsx` and `.tsx` JSX→JSX mutants accepted and KILLED; attribute mutant KILLED; comment SURVIVED; JSX in the TEST file (`.test.jsx`) fine. A generic arrow `<T,>(x: T) => x` in `.tsx` accepted (SURVIVED, not refused); an angle-bracket cast `<string>label` in `.ts` accepted (SURVIVED, not refused). JSX introduced into `.js` or `.ts` refused (INCONCLUSIVE); a TS annotation or `as` cast introduced into `.jsx` → load failure → INCONCLUSIVE (anonymous, M6); unclosed JSX in `.jsx` refused with vitest's own wording.
- A test file that `require("vitest")`s cannot run under vitest 4 at all (vitest's rule, not the proof's); the proof says UNAVAILABLE (anonymously, M6).

Workspaces (family 2):
- `vitest.workspace.ts` is removed in vitest 4 ("migrate to `test.projects`"); not a layout this runtime can present.
- `test.projects` root, `--cwd <root>`, test in `packages/a`: KILLED / SURVIVED with the right cases (binding gap M2 aside). Mutating `packages/a/test/setup.ts` refused as a test file.
- A root config that only globs `packages/*/test/**`: KILLED; `./packages/a/test/math.test.ts` spelling: KILLED.
- `--cwd packages/a` with the package's OWN `node_modules` link and a self-contained config: works (the M5 refusal is only the hoisted case).

Config resolution (family 3):
- `vite.config.ts` alone is found and bound (sha). `vitest.config.mts` through `scripts.test -c` found; `vitest.config.cjs` in a `type: module` package through `--vitest-config` found and its `setupFiles` bound → STALE on edit (the control for M4). `scripts.test` with `-c ./configs/…` honoured.
- An env-dependent config without its variable: NOT-PASSING-NOW with the assertion text (correct; A5 is only about binding).

Aliases and resolvers (family 4):
- `vite-tsconfig-paths` + `paths: { "@src/*", "~lib" }`: KILLED / SURVIVED. `resolve.alias` computed from `import.meta.url` (points into whichever tree holds the config — the copy): KILLED. `resolve.alias` of the `/src/math.ts` root form: KILLED. A barrel `index.ts` (`export { add } from "./math"; export * from "./math"`) through an alias and through a relative import: KILLED. The canary passes on every SURVIVED above (the copy's file was loaded).
- A HARD-CODED absolute alias (`"/tmp/kp4/hardalias/src/math.ts"`): UNAVAILABLE on both the minus and the comment mutant (the round-3 L9 class, now caught by the canary).

Transforms and mocks (family 5):
- `vi.mock` with an `importOriginal` factory that re-exports the real module and stubs one function: a mutant in the real function KILLED; a mutant in the stubbed function SURVIVED (the stub masks it — correct). A full stub factory: UNAVAILABLE (the file is never loaded). `vi.doMock` + dynamic import: KILLED. `vi.hoisted`: KILLED.
- A class decorator (`experimentalDecorators`), `enum` and `namespace` in one file: decorator argument, decorator removal, enum member and namespace body each KILLED by their own case only.

Globals, setup files, child processes (family 6):
- `globals: true` with a test that imports nothing from vitest: KILLED / SURVIVED. A root `setupFiles` entry that mutates a global the source reads: bound, and the mutant that only matters without the setup correctly SURVIVED.
- A `beforeAll` that spawns `process.execPath src/cli.mjs` relative to cwd: KILLED; comment SURVIVED, and the canary breaks the child (so the survivor is accepted). The same spawn with an absolute path into the live tree: UNAVAILABLE.

Source-as-helper (family 7):
- `src/testing/builders.ts` (imported by tests only, not a test path): KILLED like any product file. `test/helpers/math-helper.ts`: refused as a test file. A colocated `src/math.test.ts`: KILLED. A helper named as `--test`: refused ("reported no executed test case"), as round 3 recorded (K11 still open).
- `src/math.ts` mutated while the test uses `vi.mock("../src/math")` with a `__mocks__` twin: UNAVAILABLE via the canary (A3 is about mutating the twin itself).

Not tried: manifest (`--mutant`) mutants (no manifest in a throwaway repo, as in rounds 2–3); pnpm's isolated
`node_modules/.pnpm` layout; a Windows path form; vitest `browser` mode; `test.root` / `test.dir` set to a
subdirectory of the project.

## Resolution (2026-11-05, branch `cloud/fix-round4-layouts`)

Every red case in `review-regressions-round4-layouts.test.ts` is green through product changes only (11/11, no case
weakened or skipped; the `verifyKillProof` import was re-aimed to `receipt-freshness.ts`, where the function moved after
681e705). Each fix is pinned from the other side in `round4-layouts-fixes.test.ts` (25 cases, positive and negative).

| id | status | where | what changed |
|---|---|---|---|
| M1 | **FIXED** | `proof-preconditions.ts` `mutantParses(file, mutated, original)` (moved out of `run.ts` for the line cap) | JSX in a `.js`/`.ts` file is refused INTRODUCED-ONLY: the ORIGINAL file is parsed too and a file that already held JSX is proven normally (N1 survived, N2 killed); a mutant adding JSX to a JSX-free file is still refused. |
| M2 | **FIXED** | `config-binding.ts bindVitestConfig`; `receipt.ts captureEnvironment`; `types.ts ProofEnvironment.configFiles` | `test.projects` entries are expanded (glob / directory / file, `!` negation honoured); each project's config is bound under `configFiles` and its `setupFiles` / `globalSetup` resolved against the config's directory (vitest's project root). Freshness: a changed project config or setup file stales, a project config loaded since the proof stales (N3, N4). |
| M3 | **FIXED** | `config-binding.ts configImportClosure` + `declarationsIn` | The config's static local import closure is bound (`configFiles`) and walked for declarations, so `test: testOptions` from `./config/test-options` binds the helper AND the setup files it names (N5, N6). Values come from a TypeScript AST walk: arrays, string literals, expression-free templates; anything computed (spread, call, identifier, `${}` template) or a path that is not a project file is recorded in `environment.unresolvable`, part of the id, and printed by `tests kill-proofs --verify` as `LIMIT (not bound): …`. Without `typescript` the old text pattern runs and that too is recorded. |
| M4 | **FIXED** | `config-binding.ts walkConfig` / `baseFor` | Setup paths of the root config resolve against the PROJECT ROOT (vite's `root` = cwd), never the config file's directory; a static `test.root` re-bases them; a project config resolves against its own directory (N7). |
| M5 | **FIXED** | `proof-preconditions.ts vitestHome` / `hoistLayout`, `missingVitest`; `fail-before-fix/index.ts nearestVitestBin`; `snapshot.ts createProjectCopyAsync(…, hoist)` | vitest is found walking up from `--cwd` to the git root; the copy places the package at `<copy>/<prefix>` with the hoisted `node_modules` linked at `<copy>/node_modules` (plus the package's own beside its files), and the runner invokes the nearest `node_modules/.bin/vitest` above the copy (N9). The walk never leaves the repository: a package without vitest below a git root is still `unavailable`. |
| M6 | **FIXED** | `fail-before-fix/index.ts stderrHead` (`VitestRun.stderrHead`), `classify.ts parseVitestSuiteFailures` (`VitestRun.suiteFailures`); `run.ts baselineProblems` / `judgeCases` | A no-report run carries the first 2 KB of vitest's stderr (ANSI stripped) under the reason; a file that reports no case carries vitest's file-level message, in the baseline `unavailable` reason and in the per-case `inconclusive` reason under the mutant (N10, N11). |
| M7 | **FIXED** | `proof-preconditions.ts explicitVitestConfig` | `--vitest-config` resolves absolute, then relative to the invoking cwd, then relative to the project root — the first that exists INSIDE the project — and is recorded repo-relative (N8). |
| A1 | POLICY | guide Limits | Module-system semantics are vitest's: its runner shims `require` / `module.exports` / `__dirname` in `.mjs` and accepts `export` in `.cjs`; a mutant introducing them is judged by the tests. The receipt binds vitest, so the verdict is true for the runtime certified; refusing by Node's rules would reject files vitest runs. Documented, not modelled. |
| A2 | **FIXED** (wording + guide) | `run.ts canaryProblem`; guide Limits | The canary message names the workspace link (`node_modules/<name> → ../../packages/<name>`), and the Limits say cross-package imports resolve into the live tree: prove a package's files from that package. |
| A3 | **FIXED** | `proof-preconditions.ts targetProblem` | A path with a `__mocks__` segment is refused as a target: a proof over a mock proves nothing about the module it stands in for. |
| A4 | **FIXED** | `proof-preconditions.ts explicitVitestConfig` | A config that resolves outside the project is refused up front with the resolved path, instead of being handed to vitest in the copy and ending as an anonymous "no JSON report". |
| A5 | POLICY | guide Limits | Environment variables are not bound: the set a config may read is unbounded and the values are the shell's, not the project's. The guide states that two proofs under different environments share one id and that receipts are evidence of execution on this machine, not of its shell. |
| A6 | **FIXED** | `receipt.ts declaredVitestConfig` / `resolveVitestConfig` (`normalizeRel`) | `./configs/x.mts` and `configs/x.mts` record one spelling; the discovery order is `vitest.config.*` then `vite.config.*`, as vitest's. |

Receipt shape: `environment` gains `configFiles` and `unresolvable` (both part of `receiptId`; both REQUIRED by the
parser, as `boundImports` is — a receipt written before this change does not bind the configs vitest loads and is
re-proven, not trusted). Not addressed: pnpm's isolated `node_modules/.pnpm` layout, `test.dir`, browser mode and
Windows paths were not tried by the review and are not tried here.
