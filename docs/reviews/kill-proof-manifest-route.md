# Kill proof — the `--mutant <id>` manifest route, end to end

Date 2026-11-05. Cloud clone of `mutation-proof`, branch `cloud/manifest-route`,
Node v22.23.4, vitest 4.1.11, Stryker 9.6.1. First run of `tests prove-kill
--mutant` against a manifest produced in the same clone (the repo's own 47 MB
manifest is gitignored, so no cloud run had one before).

## 1. The manifest (real Stryker run, repo adapter)

```
INTERLINKED_MUTATION_TESTS='src/harness/guard-tally*.test.ts,src/harness/percentile-rank*.test.ts,src/harness/recurrence-time*.test.ts' \
  npx stryker run --mutate 'src/harness/guard-tally.ts,src/harness/percentile-rank.ts,src/harness/recurrence-time.ts'
```

Repo `stryker.conf.json` unchanged (vitest runner, `vitest.stryker.config.ts`,
perTest coverage). Engine exit 0, done in 15 s, `reports/mutation/mutation.json`.

| file | mutants | killed | timeout | survived | score |
|---|---|---|---|---|---|
| guard-tally.ts | 22 | 21 | 0 | 1 | 95.45 |
| percentile-rank.ts | 39 | 34 | 4 | 1 | 97.44 |
| recurrence-time.ts | 62 | 50 | 0 | 12 | 80.65 |
| total | 123 | 105 | 4 | 14 | 88.62 |

Conversion: a throwaway tsx driver (not committed) called `emptyManifest`,
then `adopt.ts seedFileBaseline` per file (→ `strykerToAdapted` →
`deriveIdentities` / `computeSymbolHashes` → `applyMeasuredRun`), then
`saveManifest`. All 123 report rows became records (0 dropped, 0 refused);
`loadManifestState` reloaded it `valid`, generation 3. `mutation survivors
--file` listed exactly the 1 / 1 / 12 survivors (first five of
recurrence-time: `3f05efd38cd5e4af`, `5f9ac8fb2f36c85c`, `e0589075fc9a833e`,
`d0a58875be96be07`, `532dcc0c1ccefed5`). Every file is flagged "NO measurement
provenance" — `seedFileBaseline` does not stamp provenance; expected for
adoption, worth knowing.

## 2. Five proofs by id

Test = the module's `*.mutation-kill.test.ts`. "before" = existing tests,
"after" = with the cases added on this branch.

| mutant | file:line | lexeme → replacement | qualifiedName / ord | before (receipt) | after (receipt) |
|---|---|---|---|---|---|
| 42857a68db7e7dfa | guard-tally.ts:37 | `{ blocked: 0, warned: 0, asked: 0, lastBlockRule: null }` → `{}` | (module) / 0 | survived (590bbe9ea0c9367f) | **killed** (a9c67a76174632d9) |
| b8bf17e72abc6b52 | percentile-rank.ts:43 | `values.length === 0` → `false` | percentileRanks / 0 | survived (5b55f035a477e4b1); also survived vs companion test | not attempted — equivalent (`[].map` already returns `[]`) |
| d0a58875be96be07 | recurrence-time.ts:24 | regex `^` anchor dropped | parseDurationMs / 0 | survived (3f230777e8370fea) | **killed** (5f4416a21c3f3085) |
| 5a5c7ab556b46c8d | recurrence-time.ts:24 | `\s*` → `\S*` between amount and unit | parseDurationMs / 0 | survived (4c343af74f1d56fd) | **killed** (2960bc0404b327ea) |
| 91a09824f621fd65 | recurrence-time.ts:66 | `ms < firstMs` → `ms <= firstMs` | updateSeenBounds / 0 | survived (985f112536306647) | **killed** (b09a646670306c7a) |

Resolved `mutant` blocks matched the manifest exactly (file, line, lexeme,
replacement, qualifiedName, mutator, ordinal 0, `manifestStatus: survived`,
generation 3). 4/5 survivors killed by new cases, each with a
`// test-contract:` line; 1/5 is equivalent.

## 3. Drift

**Comment line inserted above** `updateSeenBounds` (line 7). `kill-proofs
--verify` exit 1: every recurrence-time receipt `STALE: source … changed since
the proof` (receipts whose test also changed list both). Re-prove by id:
`killed` (493d3229a2b3c7bc), same mutant re-located at **line 67** (offset
2714 → 2756), ordinal 0. Correct.

Side observation: `--verify` reported the guard-tally kill as `UNCOMMITTED:
… work tree differs from HEAD` — the freshness check also requires the proven
test bytes to be committed.

**Identical earlier lexeme in the same symbol** (`const probeEarlier = ms <
firstMs; void probeEarlier;` before the real `if`). `--mutant
91a09824f621fd65` resolved to **line 67, the new dead-code site** (ordinal 0
= first occurrence), not the original `if` on line 69, and wrote a
**SURVIVED** receipt (0b13a01bfb1418a4) under the same mutant id that was
killed one run earlier. **That is the wrong site.** The identity's symbolHash
changed (the symbol's body changed), but `resolveFromManifest` /
`locateMutantOffset` does not compare it, so ordinal-within-symbol is
trusted across a body edit. Expected under the documented ordinal rule; a
silent mis-attribution in practice. Suggested fix (not made here): when the
current symbol hash differs from the manifest's `symbolHash` AND the lexeme's
occurrence count in the symbol changed, return `unavailable` (ambiguous
re-location) instead of ordinal N.

## 4. `unavailable` reasons seen on this route

| trigger | reason text |
|---|---|
| unknown id | `mutant deadbeefdeadbeef is not in the mutation manifest (generation 3)` |
| `--file` scope mismatch | `mutant 91a09824f621fd65 is not in the mutation manifest in src/harness/guard-tally.ts (generation 3)` |
| test file missing | `src/harness/nope.test.ts does not exist` |
| test outside project | `a --test path escapes the project root` |
| lexeme removed from symbol | `source drift: no site among 0 candidate token(s) (mutant 91a09824f621fd65 in updateSeenBounds)` |
| symbol renamed | `source drift: no site among 1 candidate token(s) (mutant 91a09824f621fd65 in updateSeenBounds)` |
| no manifest | ``no mutation manifest yet: run `interlinked mutation measure <file>`, or pass an explicit fault with --file/--find/--replace`` |
| corrupt manifest | `mutation manifest is corrupt: Expected property name or '}' in JSON at position 1 (line 1 column 2)` |
| source file deleted | `src/harness/percentile-rank.ts does not exist in the working tree` |

The rename message says "1 candidate token(s)" although the symbol it names
no longer exists; "symbol not found" would be clearer.

Fixed on `cloud/relocation-ambiguity` (2026-11-05): the §3 identical-earlier-
lexeme drift now returns `unavailable` with `ambiguous re-location: ms <
firstMs now occurs 2 times in updateSeenBounds (was 1); re-measure the file`
(reproduced first with the current code against a fresh Stryker manifest of
`recurrence-time.ts`: resolved to line 66 `const probeEarlier = ms < firstMs;`
and wrote `survived` receipt 0c0a118226fdadfc under the killed id, the §3
defect again; after the fix, exit 2 with that reason and no receipt; the
restored file re-locates to the real `if` and is `killed`).
`locateMutantOffset` is the seam: the target now carries the manifest's `symbolHash` and the measured site count (derived from the symbol's
own ordinals — the manifest stores none), and refuses when the hash AND the
count changed; an unchanged hash, or a changed hash with the same count, keeps
the ordinal rule. The rename row now reads `source drift: symbol
updateSeenBounds not found (mutant 91a09824f621fd65)`; the lexeme-removed row
is unchanged. Pinned by `src/harness/kill-proof/resolve.test.ts` and
`differential-fuzz-locate.test.ts` P9–P11 / N9–N12.

Gotcha: when the target module is imported by the CLI itself (`recurrence.ts`,
`metrics-coupling.ts`), running the CLI through `npx tsx src/index.ts` crashes
at import on a rename/delete. The rename and delete rows were measured with
the built `node dist/index.js`.

## Not committed

`.interlinked/mutation-manifest.json`, `reports/`, receipts under
`.interlinked/test-runs/kill-proofs/`, the driver.
