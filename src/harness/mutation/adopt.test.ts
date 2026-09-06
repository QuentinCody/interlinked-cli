import { describe, expect, it, vi } from "vitest";
import { seedFileBaseline } from "./adopt.js";
import { acceptedSurvivors, applyMeasuredRun, emptyManifest, MutationManifestTestTargetError } from "./manifest.js";
import type { MutationManifest } from "./types.js";

// `applyMeasuredRun` is delegated to its real implementation by default — only
// the two tests below override it, and only for one call each
// (`mockImplementationOnce`), so every other test in this file still exercises
// the genuine manifest-write path.
vi.mock("./manifest.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./manifest.js")>();
	return { ...actual, applyMeasuredRun: vi.fn(actual.applyMeasuredRun) };
});

const FILE = "src/a.ts";
const CONTENT = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

/** Assert a baseline was produced. Fails the test with a readable message rather
 *  than casting a possible null into the type system and crashing downstream. */
function must(m: MutationManifest | null): MutationManifest {
	if (m === null) throw new Error("expected a seeded manifest, got null");
	return m;
}

/** A Stryker report for CONTENT with one survivor at the `>`. */
function report(status: string) {
	// Column is LINE-relative and 1-based. Deriving it from the line (rather than
	// a global string offset, which is what I got wrong first) keeps the fixture
	// pointing at the `>` even if the source above it changes.
	const line2 = CONTENT.split("\n")[1] ?? "";
	const col = line2.indexOf(">") + 1;
	return {
		files: {
			[FILE]: {
				source: CONTENT,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status,
						location: { start: { line: 2, column: col }, end: { line: 2, column: col + 1 } },
					},
				],
			},
		},
	};
}

describe("seedFileBaseline — brownfield adoption", () => {
	it("records a pre-existing survivor as an ACCEPTED baseline", () => {
		// The whole point: on legacy code most files are dirty. The per-edit gate
		// refuses to persist a dirty run (correctly — that would let an agent
		// launder a survivor it just introduced into the accepted floor). Adoption
		// is the explicit, human-invoked path that establishes the floor ONCE, so
		// the ratchet has something to ratchet against.
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "2026-07-28T00:00:00Z",
		});
		expect(seeded).not.toBeNull();
		expect(acceptedSurvivors(must(seeded), FILE).size).toBe(1);
	});

	it("makes that survivor stop counting as new", () => {
		// The behavioural consequence — this is what lets enforcement be turned on
		// for a brownfield repo without blocking every edit on day one.
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "2026-07-28T00:00:00Z",
		});
		const accepted = acceptedSurvivors(must(seeded), FILE);
		expect([...accepted]).toHaveLength(1);
	});

	it("records a killed mutant without marking it accepted", () => {
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Killed"),
			at: "2026-07-28T00:00:00Z",
		});
		expect(acceptedSurvivors(must(seeded), FILE).size).toBe(0);
	});

	it("returns null for an unrecognisable report rather than an empty baseline", () => {
		// An empty baseline is WORSE than none: it would claim the file is measured
		// and clean, so a real survivor introduced later would read as accepted.
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: { nonsense: true },
				at: "t",
			}),
		).toBeNull();
	});

	it("returns null when the report names no mutants for this file", () => {
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: { files: {} },
				at: "t",
			}),
		).toBeNull();
	});

	it("preserves baselines for other files already in the manifest", () => {
		const first = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "t",
		});
		const second = seedFileBaseline({
			base: must(first),
			file: "src/b.ts",
			content: CONTENT,
			report: {
				files: { "src/b.ts": { source: CONTENT, mutants: report("Survived").files[FILE]?.mutants } },
			},
			at: "t",
		});
		expect(Object.keys(must(second).files)).toContain(FILE);
		expect(Object.keys(must(second).files)).toContain("src/b.ts");
	});

	// -------------------------------------------------------------------------
	// Key normalization + test-file rejection at the OTHER live write path
	// (spec of the 2026-07-31 fix): unlike the per-edit gate, this entry point
	// has NO test-file filter of its own — it is driven by an operator-supplied
	// file list, not a changeset `isMutationTarget` already screened.
	// -------------------------------------------------------------------------

	it("N: rejects a test-file target upfront — never trusts the report enough to write", () => {
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: "src/a.test.ts",
				content: CONTENT,
				report: report("Survived"),
				at: "t",
			}),
		).toBeNull();
	});

	it("N: rejects a test-file target reached through an absolute path", () => {
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: "/repo/root/src/a.test.ts",
				content: CONTENT,
				report: report("Survived"),
				at: "t",
				cwd: "/repo/root",
			}),
		).toBeNull();
	});

	it("keys an absolute-path adoption under the SAME repo-relative key a relative one would use", () => {
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: "/repo/root/src/a.ts",
			content: CONTENT,
			report: report("Survived"),
			at: "t",
			cwd: "/repo/root",
		});
		expect(Object.keys(must(seeded).files)).toEqual([FILE]);
	});
});

// ---------------------------------------------------------------------------
// The applyMeasuredRun catch — a non-bypassable BACKSTOP (spec comment on the
// try/catch in adopt.ts). The upfront isTestPath check above already screens
// out test-file targets using the same normalizer applyMeasuredRun uses
// internally, so in normal use this catch never fires; it exists as the one
// choke point every writer funnels through. Exercised here by making
// applyMeasuredRun itself throw, since the upfront check makes it otherwise
// unreachable through seedFileBaseline's public arguments.
// ---------------------------------------------------------------------------

describe("seedFileBaseline — applyMeasuredRun backstop", () => {
	it("folds a MutationManifestTestTargetError from applyMeasuredRun into the same null refusal", () => {
		vi.mocked(applyMeasuredRun).mockImplementationOnce(() => {
			throw new MutationManifestTestTargetError(FILE);
		});
		const result = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "t",
		});
		// Same contract as every other refusal in this module: null, not a thrown
		// error the caller would have to handle specially. Inverting the `if` to
		// `throw err` unconditionally would instead crash this call.
		expect(result).toBeNull();
	});

	it("rethrows any OTHER error from applyMeasuredRun rather than swallowing it", () => {
		vi.mocked(applyMeasuredRun).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		// Inverting the branch to `return null` for every error (not just the
		// test-target backstop) would silently hide a real write failure instead
		// of propagating it.
		expect(() =>
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: report("Survived"),
				at: "t",
			}),
		).toThrow("disk full");
	});
});

// ---------------------------------------------------------------------------
// Target selection — the report must describe THIS file, or nothing is written
// ---------------------------------------------------------------------------
// Review 2026-08-27: selection was `adapted.find((f) => f.file === args.file) ??
// adapted[0]`, and `forFile.content` was never compared against `args.content`.
// Two consequences, both live: a report that did not name the target seeded the
// target's baseline from a FOREIGN file's mutants, and a report measured against
// different source text seeded it from a stale measurement. `deriveIdentities`
// anchors those mutants' offsets in `args.content`, so the recorded identities
// describe spans the engine never measured — and this is the write path most of
// this repo's baselines were created through.
//
// The refusals now match `selectTargetEntry` in cloud-runner.ts: exact canonical
// path equality, no ambiguity, exact source equality.

const FOREIGN = "src/other.ts";
const FOREIGN_CONTENT = "export const z = 1;\n";

/** A well-formed report for a file that is NOT the adoption target. */
function foreignReport() {
	return {
		files: {
			[FOREIGN]: {
				source: FOREIGN_CONTENT,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status: "Survived",
						location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
					},
				],
			},
		},
	};
}

describe("seedFileBaseline — target selection (must refuse)", () => {
	it("N: refuses when the target is absent and only a FOREIGN entry is present", () => {
		// The removed `?? adapted[0]` fallback: src/other.ts's survivor became
		// src/a.ts's accepted floor, keyed under src/a.ts, anchored at offsets
		// resolved in src/a.ts's text.
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: foreignReport(),
				at: "t",
			}),
		).toBeNull();
	});

	it("N: refuses even when the foreign entry is the only one and carries the target's own source", () => {
		// Content equality alone is not enough — the path must match too, or a
		// report for a file that merely happens to be a byte-for-byte twin seeds
		// the target.
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: { files: { [FOREIGN]: report("Survived").files[FILE] } },
				at: "t",
			}),
		).toBeNull();
	});

	it("N: refuses when the entry's source differs from the content being adopted", () => {
		// A stale measurement. The mutants' offsets index the report's source, the
		// identities index `content`; recording the pair asserts a measurement that
		// never happened.
		const stale = report("Survived");
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: `${CONTENT}// one line later\n`,
				report: stale,
				at: "t",
			}),
		).toBeNull();
	});

	it("N: refuses an AMBIGUOUS target — two report entries collapsing onto one canonical key", () => {
		// `./src/a.ts` and `src/a.ts` normalize to the same manifest key, so there
		// is no single entry to trust. Same refusal cloud-runner.ts makes.
		const one = report("Survived").files[FILE];
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: { files: { [FILE]: one, [`./${FILE}`]: one } },
				at: "t",
			}),
		).toBeNull();
	});

	it("N: writes NOTHING to the manifest when it refuses a foreign report", () => {
		// The consequence that matters: a refusal must leave the caller's manifest
		// untouched, not extend it with an empty or foreign-seeded record.
		const base = emptyManifest(META);
		const seeded = seedFileBaseline({
			base,
			file: FILE,
			content: CONTENT,
			report: foreignReport(),
			at: "t",
		});
		expect(seeded).toBeNull();
		expect(Object.keys(base.files)).toEqual([]);
	});

	it("P: seeds when path and content both match exactly", () => {
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "t",
		});
		expect(Object.keys(must(seeded).files)).toEqual([FILE]);
		expect(acceptedSurvivors(must(seeded), FILE).size).toBe(1);
	});

	it("P: seeds from the target's OWN entry when a foreign entry sits ahead of it", () => {
		// The positive half of the fallback fix: an unrelated entry earlier in the
		// report must neither be selected nor contribute mutants.
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: { files: { ...foreignReport().files, [FILE]: report("Survived").files[FILE] } },
			at: "t",
		});
		expect(Object.keys(must(seeded).files)).toEqual([FILE]);
		expect(acceptedSurvivors(must(seeded), FILE).size).toBe(1);
	});
});
