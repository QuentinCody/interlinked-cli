# claim_liveness — claim-vs-import-graph detector, spike with measured precision

Branch: `cloud/claim-vs-import` from `mutation-proof` at `681e7052` (2026-11-04). Author: cloud session,
2026-11-05. Status: **SPIKE** — `src/harness/checks/claim-liveness.ts` is not registered, not in `verify`,
has no CLI verb. Measurement script: `scripts/scan-claim-liveness.mts` (read-only). Tests:
`src/harness/checks/claim-liveness.test.ts`, **21/21 pass** (8 MUST-FIRE, 9 MUST-NOT-FIRE, 4 grammar).
`npm run typecheck` clean.

## 1. What it is for

CLAUDE.md (*Deletion wave, 2026-09-02*): seven product files carried a commit message or design doc
claiming the feature was live while nothing imported them; "the generalizable check: *commit/doc says X
now runs, nothing imports X* — a claim-vs-import-graph detector, not yet built". The repo already has the
model-backed half (`src/harness/jev/doc-claim-liveness.ts`, Jev decides whether a paragraph asserts
liveness; `interlinked jev doc-claims`). This spike is the fully deterministic counterpart the check
pipeline could actually carry under `feedback_harness_deterministic_only`.

## 2. Design

`detectClaimLiveness({ claims, files, importers, entryPoints?, negation?, verbs?, basenames? })`
is pure over its inputs (no I/O; `fully_deterministic`). A finding needs ALL of:

| step | rule | where |
|---|---|---|
| claim unit | markdown paragraph (fences dropped) or one commit message → table rows whole; list items and prose split at `[.!?]` + space + capital/backtick/bracket, or `;` | `splitMarkdownParagraphs`, `splitIntoSentences` |
| liveness verb | `now runs \| runs \| wired \| live (not "live in") \| enabled \| lands \| ships \| is called \| default-on`, word-bounded, case-insensitive, in the SAME unit as the path | `LIVENESS_VERB_RE` |
| hedge (v1) | unit containing `not` / `never` is skipped | `NEGATION_RE` (input `negation: null` disables) |
| path mention | backtick relative path with a `/` and a code extension (`./` stripped), or a bare `src/…` path (lookbehind refuses `cloud/src/x.ts`, lookahead refuses `x.ts.bak`); iteration 2 adds a bare backtick basename | `extractPathMentions` |
| resolution | exact match in `files`; else unique `/`-anchored suffix (`evaluator/gate.ts` → `src/harness/evaluator/gate.ts`); a basename resolves only against product-code files and only when unique (`store.ts` names five files here, `server.ts` two plus four fixtures) | `resolveMention` |
| product code | code extension; not `.d.ts`, test (`isTestSourcePath`), `__fixtures__`, `__mocks__`, `fixtures/`, `test-setup/`, `scratch/`, `docs/`, `dist/`, `generated` | `isProductCodePath` |
| not an entry | caller list (bin, package `exports`, npm-script args, bundler entries, knip entries, vitest `setupFiles`) ∪ shape (`scripts/`, `bin/`, root `*.config.*`, `src/index.*`, `test-setup/`) | `ENTRY_SHAPE_RE` |
| no importer | `importers(file)` minus self and minus test/fixture importers is empty | detector |

The importer contract is the caller's. The scan script counts `import … from`, `export … from`,
dynamic `import("…")` and `require("…")` with a literal relative specifier (comment lines stripped, as
`interlinked deadcode` does), resolved with `project-graph/resolve.ts`, unioned with the
`ProjectGraph` static edges — so the barrel and dynamic-import blind spots that make
`testOnlyImporterFiles` over-report ~3x do not apply here.

## 3. Measurement

Corpus A (today): `CLAUDE.md` + top-level `docs/*.md` (33 files, `docs/reviews` excluded) + the last 400
commit messages = **10,821 prose lines, 1,779 claim units, 6,551 sentences**; 31 declared entry points.
Corpus B (historical recall probe): a worktree at `928c7f6c` (2026-09-02, the commit before the deletion
wave `3324a7ab`), same sources as they existed then = **5,884 lines, 938 units, 3,341 sentences** (8 doc
files, 171 commits reachable in this clone, which starts 2026-08-07).

Funnel (sentences with a verb → with a mention → mention resolves to a product file):

| corpus | verbs | basenames | verb sentences | +mention | → product files | fired |
|---|---|---|---|---|---|---|
| A | brief | off | 261 | 21 | 18 | **0** |
| A | wide | off | 421 | 33 | 28 | 0 |
| A | brief | on | 261 | 39 | 43 | 0 |
| A | wide | on | 421 | 57 | 60 | 0 |
| B | brief | off | 126 | 14 | 14 | 0 |
| B | wide | off | 229 | 23 | 23 | 0 |
| B | brief | on | 126 | 18 | 24 | **1** |
| B | wide | on | 229 | 31 | 38 | 1 |

The hedge filter (`negation on/off`) changed nothing in any cell. Every product file the prose claims
live today has a non-test importer; the detector's funnel is working (the 18 resolved product files are
the ones CLAUDE.md says are wired, and they are).

### Precision history

| version | change | A fired | B fired | precision |
|---|---|---|---|---|
| v0 | brief verbs, path grammar, no hedge | 0 / 10,821 lines | 0 / 5,884 | 0/0 (undefined) |
| iteration 1 | + past-tense/descriptive verbs (`landed`, `shipped`, `lives in`, `runs on`, `enforced`, `blocks`, `added`, `promoted`, `registered`) and the `not`/`never` hedge | 0 | 0 | 0/0 |
| iteration 2 | + unique product-code basename resolution (`--basenames`) | 0 | 1 | **1/1** |

Fire rate: 0 per 1k prose lines today; 0.17 per 1k on corpus B with iteration 2.

### Adjudication — every finding

| # | corpus | claim | file | verdict |
|---|---|---|---|---|
| 1 | B, `CLAUDE.md:473` (2026-09-02) | "Supporting modules: `corpus.ts` / `corpus-scan.ts` (dogfood **runs** + adjudication, `.interlinked/check-corpus.json`) …" | `src/harness/check-evidence/corpus-scan.ts` | **TRUE.** At `928c7f6c` the only importers were `check-evidence/contract.test.ts` and `corpus-scan.test.ts`; the first non-test importer (`check-evidence/corpus-current.ts`, then `commands/harness-corpus.ts`) arrived in `7ce33188` on 2026-10-06, five weeks after the doc listed it as a live supporting module. **Caveat:** the verb token is the NOUN "runs" ("dogfood runs"); the sentence asserts liveness by listing the module under *Supporting modules*, not by the matched word. The file verdict is right, the trigger was lucky. |

Precision **1/1** on findings; recall against the seven motivating files: **0/7** directly (see §4).

Portability stress (`--no-entries`, wide verbs, basenames): A fires once on `src/lib/viz/reporter-vitest.ts`
("each **live** lens …", the row for `src/lib/viz/`); B fires on that plus #1. Both extra hits are package
`exports` entries the declared list removes, which is the shape a foreign repo will produce when its
entry discovery is incomplete — and the matched "live" is an adjective in both.

## 4. False-positive and recall taxonomy

Observed while measuring (A and B, all grammars, including the candidates the entry list and the
uniqueness rule removed):

| class | example | handled by |
|---|---|---|
| **Verb is a noun/adjective** | "dogfood *runs*", "each *live* lens", "verify-*runs*" | not handled; the one TRUE hit fired through it |
| **Location idiom** | "its helpers *live in* `x.ts`" | `live(?! in\b)` (found writing N3) |
| **Entry point** | `src/harness/server.ts`, `reporter-vitest.ts` (package export) | declared entry list; the shape rule alone misses package `exports` |
| **Ambiguous basename** | "`store.ts`" in the project-e2e paragraph would resolve to the orphaned `agent-io/store.ts` by stem | uniqueness rule → silent (correct) |
| **Claim names a directory or module, not a file** | commit `559866fd`: "- `agent-io/`: subagent I/O capture module"; CLAUDE.md names "retrieval-cost", "graph-prediction harvester" | not handled — the main recall gap |
| **Claim is in a gitignored doc** | the design docs that motivated the check live in `docs/design/` and `docs/plans/`, versioned in the operator overlay, absent from this tree | out of scope for a public-tree scan |
| **Claim verb lives in the commit SUBJECT** | `feat(harness): detector tranche — … agent-io capture` + a body list item with no verb | not handled; a conventional-commit `feat(` subject is a liveness claim for the whole body |
| **Historical sentence** | "NOT LANDED", "deleted 2026-08", "was reverted" | `not`/`never` hedge covers the first; past tense is not detected |

Recall against the seven files named in the deletion-wave paragraph (Stop-phase self-heal, CRAP
telemetry, `public_symbol_test_case`, agent-io primitives, dead-code-signal, retrieval-cost,
graph-prediction harvester): none is named by a code PATH in any claim unit of corpus B; three
(`agent-io/*`, `trajectory/retrieval-cost.ts`, `graph-prediction-stop-hook.ts`) are still importer-less
today and still unnamed by path. The claim shape the brief specified — a file path and a present-tense
verb in one sentence — is not how this corpus makes the claim; it names modules by directory, stem or
feature name, and it does so in private design docs and commit subjects.

## 5. Recommendation

**Do not register it; keep it as a verify-only advisory behind `--all-checks` only if the module/stem
grammar is added first, otherwise redesign.** The deterministic detector is sound where it applies
(1/1, zero noise on 10.8k lines, tests 21/21), and the fire-rate doctrine says a quiet check is not
dead weight — *fire rate measures the agent, not the check*, and this repo is the hardened N=1 where
the agent already wires what it documents. But the doctrine cuts the other way too: a check earns
per-edit latency by catching defects, and this one's evidence of catching the motivating defect class
is one hit, through a noun, on a historical tree. The miss is structural, not a threshold: the claims
name directories, stems and features, and the verb sits in a `feat(` subject or in a gitignored design
doc. The next spike should (a) resolve a backtick directory (`agent-io/`) to "every direct product file
in it is importer-less", (b) treat a conventional-commit `feat`/`wire`/`land` subject as the verb for
every path in the body, and (c) run over the operator overlay's `docs/design` and `docs/plans` as a
Stop-phase nudge keyed to the files edited this session — the only surface where the evidence
("they documented X as live and X has no importer") coexists with the moment the agent can still fix
it. Re-measure precision with an independent adjudication before any registry entry; the builder's
own read is the one the evidence contract warns against.

## 6. Reproduce

```bash
npx tsx scripts/scan-claim-liveness.mts --verbs brief --negation off            # v0, today
npx tsx scripts/scan-claim-liveness.mts --verbs wide --negation on --basenames  # iteration 2, today
git worktree add --detach /tmp/pre-deletion 928c7f6c
npx tsx scripts/scan-claim-liveness.mts --root /tmp/pre-deletion --basenames    # the one TRUE finding
npx vitest run src/harness/checks/claim-liveness.test.ts
```
