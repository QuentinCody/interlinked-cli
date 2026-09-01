// Mutation-kill campaign for corpus.ts (fleet-r3, pass1_w24). Each `it()` is
// aimed at one or more specific surviving mutantIds from
// .interlinked/mutation-manifest.json; see the receipt JSONL for the mapping.
//
// A structural note on mutants NOT covered here (suspected equivalent — no
// test written; each has a one-line rationale in the receipt):
//   - slug()'s two `+`-removal mutants on the SECOND regex (`/^_+|_+$/g`):
//     the FIRST regex (`/[^a-z0-9]+/g`) always collapses any run of non-alnum
//     chars — including literal `_` — to a single `_`, so the second regex
//     never sees a run longer than 1 char; the removed `+` is unreachable.
//   - lessStrictSeverity's `<=`→`<` (and the mirrored mergeFindings/
//     foldByBugClass tie-breaks `<`→`<=`/`>`→`>=`): these only change which
//     branch fires when the two ranks are EQUAL, and equal rank means the
//     two inputs are the same value already — the extracted primitive is
//     identical either way.
//   - recordFinding/loadFindings's `"utf-8"`→`""` StringLiteral mutants:
//     Node's Buffer.from(str, encoding) treats an empty-string encoding as
//     the default ("utf8") via a `encoding.length === 0` fallback, so the
//     bytes written are identical.
//   - both `void e; // ...` catch-block→`{}` BlockStatement mutants: `void e`
//     has zero observable effect; an empty catch body behaves identically.
//   - loadFindings's `paths: string[] = []`→sentinel-array mutant: the
//     sentinel path is immediately filtered by the `existsSync` guard before
//     any read, so it never reaches the byId map.
//   - loadFindings's `!rawLine.trim()`→`false` and `.trim()`-removal
//     mutants: a blank/whitespace-only line is never valid JSON either way,
//     so bypassing the early `continue` just routes it through the same
//     enclosing try/catch (JSON.parse throws, swallowed) with the same net
//     effect on the returned array.
//   - loadFindings's `if (finding)`→`if (true)` mutant: parseFinding only
//     ever returns a Finding or exactly `null` (verified in parse-finding.ts);
//     forcing the branch to run on a `null` dereferences `.id`, which throws
//     and is caught by the SAME enclosing try/catch — same net effect.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Finding,
	foldByBugClass,
	getFinding,
	globalCorpusPath,
	loadFindings,
	makeFinding,
	recordFinding,
	upsertFinding,
} from "./corpus.js";

let cwd: string;
let home: string;
const prevHome = process.env.INTERLINKED_HOME;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "findings-mk-cwd-"));
	home = mkdtempSync(join(tmpdir(), "findings-mk-home-"));
	process.env.INTERLINKED_HOME = home;
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	if (prevHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevHome;
});

describe("slug (private, exercised via makeFinding's id)", () => {
	// test-contract: invariant — 890fadc6933c248d (Regex /[^a-z0-9]+/g -> /[^a-z0-9]/g):
	// without the `+` quantifier, each non-alnum char in a run is replaced
	// individually instead of the whole run collapsing to one underscore.
	it("collapses a run of non-alnum chars to ONE underscore, not one per char", () => {
		const f = makeFinding({ bug_class: "foo!!bar", message: "m", source_runner: "paste" }, cwd);
		expect(f.id.startsWith("foo_bar-")).toBe(true);
	});
});

describe("lessStrictSeverity (private, exercised via upsertFinding merge)", () => {
	// test-contract: invariant — lessStrictSeverity must return the LESS
	// severe of the two inputs (never-raise-severity merge policy, see the
	// function's own doc comment in corpus.ts).
	it("keeps the existing (less-severe) severity over a more-severe incoming one", () => {
		const mk = (runner: string, severity: "low" | "critical") => ({
			bug_class: "sev-tie",
			message: "m",
			file: "sev.ts",
			line: 1,
			severity,
			source_runner: runner,
		});
		const a = makeFinding(mk("r1", "low"), cwd);
		upsertFinding(a, cwd, { mirrorGlobal: false });
		const b = makeFinding(mk("r2", "critical"), cwd);
		expect(b.id).toBe(a.id);
		upsertFinding(b, cwd, { mirrorGlobal: false });
		expect(getFinding(a.id, cwd)?.severity).toBe("low");
	});
});

describe("makeFinding — file-argument mutants (normFile || undefined)", () => {
	// test-contract: invariant — one of {6bc446b00a843289, 02fad4e8fd72320a,
	// fb46d126ee3d5d2b}: computeProvenanceId's `file` argument neutralized to
	// a constant (false/undefined) regardless of the actual file makes two
	// findings that differ ONLY by file collapse to the same provenance_id.
	it("gives different files different provenance_id (holding everything else fixed)", () => {
		const base = { bug_class: "pid", message: "m", line: 1, source_runner: "paste" };
		const f1 = makeFinding({ ...base, file: "src/a.ts" }, cwd);
		const f2 = makeFinding({ ...base, file: "src/b.ts" }, cwd);
		const [p1] = f1.provenance;
		const [p2] = f2.provenance;
		expect(p1?.provenance_id).not.toBe(p2?.provenance_id);
	});

	// test-contract: invariant — the remaining of {6bc446b00a843289,
	// 02fad4e8fd72320a, fb46d126ee3d5d2b}: the provenance object literal's
	// own `file: normFile || undefined` field, checked directly.
	it("stores the exact normalized file on the single provenance entry", () => {
		const f = makeFinding(
			{ bug_class: "pfield", message: "m", file: "src/a.ts", line: 1, source_runner: "paste" },
			cwd,
		);
		const [p] = f.provenance;
		expect(p?.file).toBe("src/a.ts");
	});
});

describe("makeFinding — id suffix and default aliases", () => {
	// test-contract: invariant — 712f55c723c98a5f (MethodExpression
	// key.slice(0, ID_KEY_LENGTH) -> key): without the slice, the full
	// 64-char sha256 hex digest is appended instead of a 12-char prefix.
	it("truncates the id's key suffix to 12 hex chars", () => {
		const f = makeFinding(
			{ bug_class: "c", message: "m", file: "a.ts", line: 1, source_runner: "paste" },
			cwd,
		);
		const suffix = f.id.slice(f.id.lastIndexOf("-") + 1);
		expect(suffix).toHaveLength(12);
	});

	// test-contract: invariant — 640fa46ad4740c14 (ArrayDeclaration
	// aliases default [] -> ["Stryker was here"]).
	it("defaults aliases to an empty array when omitted", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		expect(f.aliases).toEqual([]);
	});
});

describe("recordFinding — mirrorGlobal gating and nested-dir creation", () => {
	// test-contract: invariant — 5d7ecd9d72e345fb (BooleanLiteral false ->
	// true inside `opts.mirrorGlobal !== false`, i.e. `!== true`): an
	// explicit `mirrorGlobal: true` would then compare equal and SKIP the
	// mirror instead of performing it.
	it("still mirrors when mirrorGlobal is explicitly true", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, { mirrorGlobal: true });
		expect(existsSync(globalCorpusPath())).toBe(true);
		expect(readFileSync(globalCorpusPath(), "utf-8")).toContain(f.id);
	});

	// test-contract: invariant — 0aef4a05cc02c17b (ConditionalExpression
	// `opts.mirrorGlobal !== false` -> `true`): would mirror unconditionally,
	// even when the caller explicitly opted out.
	it("does not mirror when mirrorGlobal is explicitly false", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, { mirrorGlobal: false });
		expect(existsSync(globalCorpusPath())).toBe(false);
	});

	// test-contract: invariant — recordFinding's global mirror must create ALL
	// missing intermediate directories (mkdirSync recursive:true), not just
	// one level, per its own doc comment ("best-effort mirror").
	it("creates multiple missing intermediate directories for the global mirror", () => {
		const deepHome = join(home, "nested", "deeper");
		process.env.INTERLINKED_HOME = deepHome;
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, { mirrorGlobal: true });
		expect(existsSync(globalCorpusPath())).toBe(true);
	});
});

describe("loadFindings — scope precision", () => {
	let fLocal: Finding;
	let fGlobal: Finding;

	beforeEach(() => {
		fLocal = makeFinding({ bug_class: "local_only", message: "m", source_runner: "paste" }, cwd);
		recordFinding(fLocal, cwd, { mirrorGlobal: false });

		fGlobal = makeFinding({ bug_class: "global_only", message: "m", source_runner: "paste" }, cwd);
		const gpath = globalCorpusPath();
		mkdirSync(dirname(gpath), { recursive: true });
		appendFileSync(gpath, `${JSON.stringify(fGlobal)}\n`, "utf-8");
	});

	// test-contract: invariant — loadFindings' LoadOpts.scope contract:
	// "local" reads ONLY the per-repo corpus, never the global cache.
	it("scope:'local' returns only the local-only finding", () => {
		const ids = loadFindings(cwd, { scope: "local" }).map((x) => x.id);
		expect(ids).toContain(fLocal.id);
		expect(ids).not.toContain(fGlobal.id);
	});

	// test-contract: invariant — 4a3b94c359378ed1 (whole `scope === "local"
	// || scope === "both"` -> true): would push the local path even when
	// scope is "global", leaking the local-only finding into a global-scoped
	// read.
	it("scope:'global' returns only the global-only finding", () => {
		const ids = loadFindings(cwd, { scope: "global" }).map((x) => x.id);
		expect(ids).toContain(fGlobal.id);
		expect(ids).not.toContain(fLocal.id);
	});

	// test-contract: invariant — the remaining `scope === "both"` mutants on
	// whichever of the two disjunction lines they land on: with scope:"both",
	// EITHER neutralized comparison drops one side's path from the read.
	it("scope:'both' returns both findings", () => {
		const ids = loadFindings(cwd, { scope: "both" }).map((x) => x.id);
		expect(ids).toContain(fLocal.id);
		expect(ids).toContain(fGlobal.id);
	});
});

describe("carryAnchor (private, exercised via upsertFinding merge)", () => {
	// test-contract: invariant — carryAnchor's documented policy: "a first
	// capture fills legacy rows in" — incoming's anchor fields must populate
	// the merge when existing has none.
	it("fills in anchor fields from incoming when existing has none", () => {
		const existing = makeFinding(
			{ bug_class: "anchor", message: "m", file: "a.ts", line: 1, source_runner: "r1" },
			cwd,
		);
		upsertFinding(existing, cwd, { mirrorGlobal: false });

		const incomingBase = makeFinding(
			{ bug_class: "anchor", message: "m", file: "a.ts", line: 1, source_runner: "r2" },
			cwd,
		);
		const incoming: Finding = {
			...incomingBase,
			anchor_span_sha256: "deadbeef",
			anchor_context: ["l1", "l2"],
			anchor_tree: "abc123+dirty",
		};
		upsertFinding(incoming, cwd, { mirrorGlobal: false });

		const merged = getFinding(existing.id, cwd);
		expect(merged?.anchor_span_sha256).toBe("deadbeef");
		expect(merged?.anchor_context).toEqual(["l1", "l2"]);
		expect(merged?.anchor_tree).toBe("abc123+dirty");
	});
});

describe("mergeFindings — provenance dedup and first/last seen", () => {
	// test-contract: invariant — d98b7f7246b09646 (ConditionalExpression
	// `!byProv.has(...)` -> true): re-ingesting the same provenance_id would
	// OVERWRITE the first-seen provenance entry instead of preserving it.
	it("keeps the first-seen provenance entry when the same provenance_id re-arrives", () => {
		const mk = (quote: string) => ({
			bug_class: "dedupprov",
			message: "m",
			file: "a.ts",
			line: 1,
			source_runner: "r1",
			repo: "o/r",
			commit_sha: "sha1",
			quote,
		});
		const existing = makeFinding(mk("original-quote"), cwd);
		upsertFinding(existing, cwd, { mirrorGlobal: false });
		const dup = makeFinding(mk("clobbered-quote"), cwd);
		upsertFinding(dup, cwd, { mirrorGlobal: false });
		const merged = getFinding(existing.id, cwd);
		expect(merged?.times_observed).toBe(1);
		expect(merged?.provenance[0]?.quote).toBe("original-quote");
	});

	// test-contract: invariant — 235a8c1f7ce0d834 (`existing.first_seen <
	// incoming.first_seen` -> false) and f255bde06fa9e34d (EqualityOperator
	// `<` -> `>=`): both would incorrectly pick the LATER incoming timestamp
	// when existing predates it.
	it("keeps the earlier first_seen when existing predates incoming", () => {
		const mk = (runner: string, now: string) => ({
			bug_class: "fseen1",
			message: "m",
			file: "a.ts",
			line: 1,
			source_runner: runner,
			now,
		});
		const existing = makeFinding(mk("r1", "2026-01-01T00:00:00.000Z"), cwd);
		upsertFinding(existing, cwd, { mirrorGlobal: false });
		const incoming = makeFinding(mk("r2", "2026-06-01T00:00:00.000Z"), cwd);
		upsertFinding(incoming, cwd, { mirrorGlobal: false });
		expect(getFinding(existing.id, cwd)?.first_seen).toBe("2026-01-01T00:00:00.000Z");
	});

	// test-contract: invariant — 0de41cbbebb96e27 (`existing.first_seen <
	// incoming.first_seen` -> true): would incorrectly pick the LATER
	// existing timestamp when incoming predates it.
	it("keeps the earlier first_seen when incoming predates existing", () => {
		const mk = (runner: string, now: string) => ({
			bug_class: "fseen2",
			message: "m",
			file: "b.ts",
			line: 1,
			source_runner: runner,
			now,
		});
		const existing = makeFinding(mk("r1", "2026-06-01T00:00:00.000Z"), cwd);
		upsertFinding(existing, cwd, { mirrorGlobal: false });
		const incoming = makeFinding(mk("r2", "2026-01-01T00:00:00.000Z"), cwd);
		upsertFinding(incoming, cwd, { mirrorGlobal: false });
		expect(getFinding(existing.id, cwd)?.first_seen).toBe("2026-01-01T00:00:00.000Z");
	});

	// test-contract: invariant — 4b569a132856f0d9 (`existing.last_seen >
	// incoming.last_seen` -> true): would incorrectly keep the EARLIER
	// existing timestamp when incoming is more recent.
	it("keeps the later last_seen when incoming is more recent", () => {
		const mk = (runner: string, now: string) => ({
			bug_class: "lseen1",
			message: "m",
			file: "c.ts",
			line: 1,
			source_runner: runner,
			now,
		});
		const existing = makeFinding(mk("r1", "2026-01-01T00:00:00.000Z"), cwd);
		upsertFinding(existing, cwd, { mirrorGlobal: false });
		const incoming = makeFinding(mk("r2", "2026-06-01T00:00:00.000Z"), cwd);
		upsertFinding(incoming, cwd, { mirrorGlobal: false });
		expect(getFinding(existing.id, cwd)?.last_seen).toBe("2026-06-01T00:00:00.000Z");
	});

	// test-contract: invariant — b1f81aedf44b45ca (`existing.last_seen >
	// incoming.last_seen` -> false) and b13d9631a7b6fdde (EqualityOperator
	// `>` -> `<=`): both would incorrectly pick the EARLIER incoming
	// timestamp when existing is more recent.
	it("keeps the later last_seen when existing is more recent", () => {
		const mk = (runner: string, now: string) => ({
			bug_class: "lseen2",
			message: "m",
			file: "d.ts",
			line: 1,
			source_runner: runner,
			now,
		});
		const existing = makeFinding(mk("r1", "2026-06-01T00:00:00.000Z"), cwd);
		upsertFinding(existing, cwd, { mirrorGlobal: false });
		const incoming = makeFinding(mk("r2", "2026-01-01T00:00:00.000Z"), cwd);
		upsertFinding(incoming, cwd, { mirrorGlobal: false });
		expect(getFinding(existing.id, cwd)?.last_seen).toBe("2026-06-01T00:00:00.000Z");
	});

	// test-contract: invariant — 5ef2c4827be9ed9f (MethodExpression
	// removes .sort() from source_runners): without the sort, runners stay
	// in first-seen insertion order instead of alphabetical.
	it("sorts merged source_runners alphabetically regardless of merge order", () => {
		const mk = (runner: string) => ({
			bug_class: "runnersort",
			message: "m",
			file: "e.ts",
			line: 1,
			source_runner: runner,
		});
		const existing = makeFinding(mk("zzz-runner"), cwd);
		upsertFinding(existing, cwd, { mirrorGlobal: false });
		const incoming = makeFinding(mk("aaa-runner"), cwd);
		upsertFinding(incoming, cwd, { mirrorGlobal: false });
		expect(getFinding(existing.id, cwd)?.source_runners).toEqual(["aaa-runner", "zzz-runner"]);
	});
});

describe("foldByBugClass", () => {
	// test-contract: invariant — dd6bc4d0bb46d0a1 (ConditionalExpression
	// `f.file` -> true): would add an unanchored finding's empty file string
	// to sample_files instead of excluding it.
	it("excludes unanchored (no-file) findings from sample_files", () => {
		upsertFinding(
			makeFinding({ bug_class: "noloc", message: "m", source_runner: "paste" }, cwd),
			cwd,
			{ mirrorGlobal: false },
		);
		const rows = foldByBugClass(loadFindings(cwd));
		const row = rows.find((r) => r.bug_class === "noloc");
		expect(row?.sample_files).toEqual([]);
	});

	// test-contract: invariant — 42d4b04cc9b57f13 (MethodExpression removes
	// .sort() from the row's source_runners map callback).
	it("sorts a row's source_runners alphabetically", () => {
		upsertFinding(
			makeFinding(
				{ bug_class: "sortme", message: "m", file: "f1.ts", line: 1, source_runner: "zzz" },
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		upsertFinding(
			makeFinding(
				{ bug_class: "sortme", message: "m", file: "f2.ts", line: 2, source_runner: "aaa" },
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		const rows = foldByBugClass(loadFindings(cwd));
		const row = rows.find((r) => r.bug_class === "sortme");
		expect(row?.source_runners).toEqual(["aaa", "zzz"]);
	});

	// test-contract: invariant — 0575b2ec2b018b28 (MethodExpression removes
	// .slice(0, 5) from the row's sample_files map callback).
	it("caps sample_files at 5 even with more distinct files", () => {
		for (let i = 0; i < 7; i++) {
			upsertFinding(
				makeFinding(
					{
						bug_class: "manyfiles",
						message: "m",
						file: `f${i}.ts`,
						line: 1,
						source_runner: `r${i}`,
					},
					cwd,
				),
				cwd,
				{ mirrorGlobal: false },
			);
		}
		const rows = foldByBugClass(loadFindings(cwd));
		const row = rows.find((r) => r.bug_class === "manyfiles");
		expect(row?.sample_files).toHaveLength(5);
	});

	// test-contract: invariant — 6df11fa6f4b9cd31 (LogicalOperator `||` ->
	// `&&` in the final sort comparator): would sort alphabetically whenever
	// times_observed differs, instead of by times_observed descending.
	it("sorts rows by times_observed descending, not alphabetically", () => {
		upsertFinding(
			makeFinding(
				{ bug_class: "zzz_common", message: "m", file: "z1.ts", line: 1, source_runner: "a" },
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		upsertFinding(
			makeFinding(
				{ bug_class: "zzz_common", message: "m", file: "z2.ts", line: 2, source_runner: "b" },
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		upsertFinding(
			makeFinding(
				{ bug_class: "aaa_rare", message: "m", file: "a1.ts", line: 1, source_runner: "c" },
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		const rows = foldByBugClass(loadFindings(cwd));
		const order = rows.map((r) => r.bug_class);
		expect(order.indexOf("zzz_common")).toBeLessThan(order.indexOf("aaa_rare"));
	});
});
