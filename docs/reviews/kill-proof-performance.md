# Kill-proof performance pass (2026-11-05)

Goal: make `interlinked tests prove-kill` faster **without changing any verdict**.
Host: cloud container, 4 vCPU, ext4 (no reflink, so `COPYFILE_FICLONE` falls back
to a byte copy), Node 22, vitest 4.1.11. Repo at `origin/mutation-proof`: 5,990
git-visible files, about 97 MB (two `docs/demo/*.html` files account for 39 MB of it).

Proof measured (the specified case; its verdict is `survived`, so it runs three
copies: baseline, mutant, reachability canary):

```
npx tsx src/index.ts tests prove-kill --file src/harness/guard-tally.ts \
  --find 'blocked: 0, warned: 0, asked: 0' --replace 'blocked: 1, warned: 0, asked: 0' \
  --test src/harness/guard-tally.mutation-kill.test.ts --json
```

## Baseline (before any change)

| measure | n | min | median | max |
|---|---|---|---|---|
| CLI wall time, full proof | 5 | 8,108 ms | 8,994 ms | 10,400 ms |
| `receipt.baseline.durationMs` | 5 | 737 | 763 | 920 |
| `receipt.underMutant.durationMs` | 5 | 739 | 762 | 1,006 |
| `createProjectCopy` alone (sync) | 5 | 1,228 | 2,383 | 2,437 |
| `copy.cleanup()` alone (sync `rmSync`) | 5 | 526 | 543 | 622 |
| `gitVisibleFiles` | 5 | 13 | 14 | 14 |
| `npx tsx src/index.ts --version` (start-up) | 5 | 1,548 | 1,584 | 1,657 |

## Profile: where the time goes

Measured with manual timers around each stage, in-process with `persist: false`. The timing scripts
(`scratch/time-*.mts`) are ignored by git and not committed; each is about 10 lines.

- **Vitest, about 0.8 s × 3 runs.** Almost all of it is vitest start-up; the test itself is trivial.
- **Copies, about 2 s × 3, plus about 0.55 s × 3 for removal.** This is the bulk of the time (about 7.5 s
  of a 9 s proof).
- **Start-up, about 1.6 s.** This is the cost of tsx transpiling the CLI; a built `dist/` CLI avoids it.
- **`mutantParses`, about 0.35 s.** This is the cost of loading TypeScript.
- **`resolveMutant`, receipt and environment capture: under 5 ms each.**

The copy is bound by **per-file create latency, not bytes**: the median `copyFileSync` takes
0.41 ms (n=5,990), and the two 26 MB and 12 MB files take only 10 ms and 5 ms. A
read+write copy is no faster (2.0 s). So the lever is concurrency and overlap, not
skipping bulk.

## Changes kept

1. **`createProjectCopyAsync`** (`fail-before-fix/snapshot.ts`) builds the same tree as before:
   - Entries are visited in the same order.
   - Directories and links are created synchronously, exactly as `copyEntry` does.
   - Regular files are copied with `fs.promises.copyFile` (still `COPYFILE_FICLONE`), 64 at a time.
   - The node_modules link and the overrides are written after every copy has finished.

   Copy time by concurrency limit (n=5 each): limit 4: 858–1,896 ms; limit 64: 634–1,460 ms; limit 256: 609–777 ms.
   64 was chosen. The parent directory of each file is created once, not once per file.

   Equivalence is pinned by the new test `snapshot.test.ts` P2. It builds both a sync copy and an async copy
   (links, an absolute in-repo link, nested directories, a 0755 mode, a tracked file deleted from the
   working tree, overrides) and compares kind, mode, bytes and link target of every entry. N2 checks that a
   refused override still removes the partial copy.
2. **Removal overlapped with the next stage** (`fsp.rm`). `proveKill` awaits every removal before it returns,
   so the "every copy is gone" contract still holds (new test `kill-proof.test.ts` N18).
3. **Next copy built while the current stage's vitest runs.** Each stage takes a fresh *unmutated* copy and
   then writes its own override with `applyOverrides`, the same code and order `createProjectCopy` used.
   - The baseline copy is started before `mutantParses`, so it overlaps the TypeScript load.
   - The mutant copy is built during the baseline run (not when the mutant does not parse).
   - The third (repeat-baseline or canary) copy is built during the mutant run.
   - vitest is spawned before the prefetch's synchronous directory walk starts.
   - A prefetched copy that no stage takes (an early end) is removed before return (N18).
   - Each stage's copy holds only its own override (N19).
4. **fail-before-fix and requirement-faults** use the async copy too. Their order is unchanged: each copy is
   still built before the live vitest run, so the copy cannot pick up anything that run writes.

## After: interleaved before/after (same machine, same minutes)

"Before" is a worktree of `origin/mutation-proof` that shares `node_modules`. Runs alternate B, A, B, A, …
because this host drifts by several seconds over a few minutes, which makes unpaired numbers misleading.

| series | n | before min / med / max | after min / med / max |
|---|---|---|---|
| CLI, survived proof (series 1; after had changes 1–3, not yet the parse overlap) | 8 pairs | 8,261 / 9,754 / 15,254 | 6,322 / 7,033 / 10,773 |
| CLI, survived proof (series 2, final code) | 8 pairs | 8,678 / 12,202 / 12,682 | 7,425 / 9,197 / 10,565 |
| CLI, killed proof (`tally.blocked += 1` → `+= 2`, final code) | 4 pairs | 9,891 / 10,065 / 11,573 | 8,580 / 9,129 / 9,757 |
| in-process total, survived (final code) | 4 pairs | 10,277 / 10,580 / 10,887 | 7,507 / 8,032 / 8,308 |
| in-process non-vitest time ("other") | 4 pairs | 7,862 / 8,072 / 8,416 | 5,027 / 5,288 / 5,436 |

After is faster in 19 of 20 CLI pairs. The one exception is series 2, pair 2: 8,678 vs 8,676 ms, a tie.
The median saving is about 1–3 s per proof (about 20–30%).

**Cost:** the vitest runs that overlap a prefetch get slower, from about 0.8 s to 0.95–1.05 s in-process,
because the copy competes for CPU and disk. The run that has no prefetch (the third) is unchanged.

**Verdicts, before vs after:**

| proof | before | after |
|---|---|---|
| survived | `survived` (5 of 5 + 16 of 16 interleaved) | `survived` (5 of 5 + 16 of 16 interleaved) |
| killed | `killed` (3 of 3 + 4 of 4), same `killedTests` | `killed` (3 of 3 + 4 of 4), same `killedTests` |
| mutant does not parse (`+= ;`) | `inconclusive` (2 of 2) | `inconclusive` (2 of 2) |

No temporary copy directories were left behind after any run (0 `interlinked-fail-before-fix-*` in `/tmp`).

## Rejected

- **Excluding non-test bulk** (`docs/demo/**`, `*.tar.gz`). With these 4 files excluded, the copy measured
  814–1,249 ms vs 352–1,418 ms with them (n=6, interleaved): no measurable gain, because the cost is file
  count, not bytes. Any exclusion also risks a verdict (a test that reads a doc), so none was kept.
- **Building all three copies in parallel up front.** 3 parallel copies took 2.2–2.8 s vs about 3 s for 3
  sequential ones (n=4). The disk saturates, the third copy is wasted on an inconclusive result, and
  overlapping with vitest gains more.
- **`UV_THREADPOOL_SIZE=16`.** No gain at limit 64 (592–895 ms vs 634–1,460 ms; within noise). It can only be
  set before the process starts anyway.
- **Building the file list once.** Already the case (`gitVisibleFiles` once per proof, 14 ms).
- **Vitest flags.** Coverage is opt-in in `vitest.config.ts`, and the runner already uses only the JSON
  reporter, so `--no-coverage` and `--silent` change nothing. Reusing one vitest process across copies was
  not attempted: each run must load the copy's own module graph (the K1 and L1 isolation reviews).
- **Hardlinks or symlinking source directories.** Not attempted: a test that writes into its copy would write
  into the live tree.

## Residual risk and remaining time

- **Prefetch timing.** A prefetched copy reads the live tree while a vitest run executes in *another* copy.
  The proof never writes the live tree. Before this change, the next copy was read only after a run had
  finished, so the two versions differ only if a test escapes its copy and writes git-visible files in the
  live tree. That breaks the proof's isolation assumption in both versions; the reachability canary already
  covers the read side of such escapes.
- **Remaining time (final code).**
  - CLI start-up: about 1.6 s.
  - Vitest: 3 × about 0.8–1 s.
  - Copies: the first copy and whatever part of a copy outlasts the vitest run it overlaps. On this host a
    copy (0.6–2 s) takes longer than a vitest run (0.8 s).
  - The final removal: about 0.4 s.

  The next lever is the copy itself, for example a lazily materialized overlay. That would need its own
  isolation argument.
