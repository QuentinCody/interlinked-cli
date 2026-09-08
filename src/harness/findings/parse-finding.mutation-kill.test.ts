// Survivor-kill tests for src/harness/findings/parse-finding.ts, sourced from
// `npx tsx src/index.ts mutation survivors --file src/harness/findings/parse-finding.ts --json`
// (107 survivors, fleet-r3). Each `it()`'s leading comment names the exact
// mutantId(s) it kills. Shadow-verified against
// scratch/fleet-r3/src_harness_findings_parse-finding.ts-shadow-verify.mts.
//
// Recurring technique: several survivors are a `field !== undefined ? {field}
// : {}` return-spread ternary forced to always take its `true` branch. When
// `field` really is absent that adds a stray `field: undefined` property —
// invisible to `toEqual` (which drops undefined-valued keys) but visible to
// `Object.prototype.hasOwnProperty`. `hasOwn` below is the deliberate,
// explicit check for that shape, used throughout instead of `toEqual`.
import { describe, expect, it } from "vitest";
import type { Finding } from "./corpus.js";
import { parseFinding, parseProvenanceEntry } from "./parse-finding.js";

function hasOwn(obj: unknown, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

const prov = {
	provenance_id: "p1",
	provenance_completeness: "anchored_line",
	source_runner: "codex-sol",
};

const row: Finding = {
	id: "f1",
	bug_class: "nan_guard",
	aliases: [],
	check: null,
	file: "src/x.ts",
	line: 12,
	message: "boom",
	severity: "high",
	provenance: [{ ...prov, provenance_completeness: "anchored_line" as const }],
	provenance_tier: "site",
	dedup_key: "dk1",
	times_observed: 1,
	source_runners: ["codex-sol"],
	status: "candidate",
	first_seen: "2026-08-09T00:00:00Z",
	last_seen: "2026-08-09T00:00:00Z",
};

/** Every FindingProvenance optional-extra field populated with a valid
 *  value — the "all present" half of the absent/present pair used to kill
 *  the `!== undefined` ternary-inclusion mutants in provenanceExtras. */
const fullProv = {
	...prov,
	lines: [10, 20],
	is_outdated: true,
	is_resolved: false,
	enriched_fields: ["migrated"],
	actionability: "bug" as const,
};

describe("module-level Set literals — every member must be individually accepted", () => {
	// Kills: 0f8755c06f3e11f9 ("critical" -> "")
	it("P1: severity 'critical' round-trips", () => {
		expect(parseFinding({ ...row, severity: "critical" })?.severity).toBe("critical");
	});
	// Kills: c8aba19b98465072 ("performance" -> "")
	it("P2: category 'performance' round-trips", () => {
		expect(parseFinding({ ...row, category: "performance" })?.category).toBe("performance");
	});
	// Kills: 2e8daf9765eb985a ("quality" -> "")
	it("P3: category 'quality' round-trips", () => {
		expect(parseFinding({ ...row, category: "quality" })?.category).toBe("quality");
	});
	// Kills: 463c333b31878a53 ("distilled" -> "")
	it("P4: status 'distilled' round-trips", () => {
		expect(parseFinding({ ...row, status: "distilled" })?.status).toBe("distilled");
	});
	// Kills: 4e74e6031b2022e5 ("superseded" -> "")
	it("P5: status 'superseded' round-trips", () => {
		expect(parseFinding({ ...row, status: "superseded" })?.status).toBe("superseded");
	});
	// Kills: dd5e3ec0129e219c ("approved" -> "")
	it("P6: status 'approved' round-trips", () => {
		expect(parseFinding({ ...row, status: "approved" })?.status).toBe("approved");
	});
	// Kills all six ACTIONABILITIES StringLiteral mutants AND the whole-array
	// ArrayDeclaration -> [] mutant (142242363b9c5b82): any one accepted value
	// already proves the array survived intact; testing all six additionally
	// kills each individual literal mutant.
	const actionabilities = ["bug", "nit", "question", "suggestion", "praise", "out_of_scope"] as const;
	for (const act of actionabilities) {
		it(`P7[${act}]: provenance actionability '${act}' round-trips`, () => {
			expect(parseProvenanceEntry({ ...prov, actionability: act })?.actionability).toBe(act);
		});
	}
});

describe("lineRange — via a provenance entry's `lines` tuple", () => {
	// Kills: e8988d6e1b1a61d0 (whole shape-check -> false), e71d9d55bc877ef8
	// (OR -> AND), b585455aed83b73d (length check -> false). A 3-element array
	// is a real Array (isArray true) but has the wrong length; forcing any of
	// these three checks off lets `[a, b]` destructure the first two elements
	// and slip through as a "valid" 2-tuple.
	it("N1: a 3-element lines array is rejected, not silently truncated to 2", () => {
		expect(parseProvenanceEntry({ ...prov, lines: [5, 7, 9] })).toBeNull();
	});
	// Kills: 8f34f70db549c56d (typeof a === "number" -> true)
	it("N2: a lines tuple with a non-number first element is rejected", () => {
		expect(parseProvenanceEntry({ ...prov, lines: ["x", 7] })).toBeNull();
	});
	// Kills: d3524603724dffbd ([a, b] -> [])
	it("P1: a valid 2-number lines tuple round-trips its exact values", () => {
		expect(parseProvenanceEntry({ ...prov, lines: [10, 20] })?.lines).toEqual([10, 20]);
	});
});

describe("optionalBool — is_outdated / is_resolved", () => {
	// Kills: b0abbb822541daf5 (function body -> {}), 7956f23eaa14e99a
	// (v === undefined -> true, forcing every input down the undefined path)
	it("P1: is_outdated: true and is_resolved: false both round-trip (not silently dropped)", () => {
		const parsed = parseProvenanceEntry({ ...prov, is_outdated: true, is_resolved: false });
		expect(parsed?.is_outdated).toBe(true);
		expect(parsed?.is_resolved).toBe(false);
	});
});

describe("parseArrayFields — provenance array propagates its own validity", () => {
	// Kills: 75f05837cec2eeb5 (provenance === null -> false)
	it("N1: a malformed provenance entry rejects the whole finding, not just that entry", () => {
		expect(parseFinding({ ...row, provenance: [{ bad: "shape" }] })).toBeNull();
	});
});

describe("parseCheckField", () => {
	// Kills: eaeb50057b4f1862 (typeof check !== "string" -> true) and
	// 8de5daa006607998 ("string" -> "") — both collapse to "reject every
	// non-null check", so a valid string check id is the one fixture that
	// kills both.
	it("P1: a string check id round-trips", () => {
		expect(parseFinding({ ...row, check: "nan_coercion_guard" })?.check).toBe("nan_coercion_guard");
	});
});

describe("parseDistilled — via parseFinding's top-level `distilled` field", () => {
	// Kills: 0ba951db954eaccb (!isJsonObject(v) -> false). `null` would make
	// the bypassed code destructure `{...} = null`, which throws — a valid
	// divergence from the pristine clean `null` return.
	it("N1: distilled: null is rejected, not thrown through", () => {
		expect(parseFinding({ ...row, distilled: null })).toBeNull();
	});
	// Kills: e4520a4bfa01193b (detector_id type check -> false), and (the
	// OUTER check in parseOptionalScalars) 977e394d92b8b16f (distilled===null
	// -> false)
	it("N2: distilled.detector_id must be a string", () => {
		expect(parseFinding({ ...row, distilled: { detector_id: 123, kind: "guard_rule" } })).toBeNull();
	});
	// Kills: 37fe6e2ee1778505 (kind validity check -> false)
	it("N3: distilled.kind must be 'guard_rule' or 'inline_check'", () => {
		expect(parseFinding({ ...row, distilled: { detector_id: "d1", kind: "bogus" } })).toBeNull();
	});
	// Kills: d0411293b0d82bd4, 986ebdd227febf85, 6b44e5d45f019185 (three
	// different mutations of the kind==="guard_rule" validity arm — "guard_rule"
	// was never separately exercised before, only "inline_check" was), plus
	// 6268e71eca5625b4 / cc944a261fc6fa12 (cold_path_wired absence check, 1st
	// textual occurrence, in the `if`) and 1882a488e8964222 (2nd occurrence, in
	// the return spread ternary — forcing it `true` adds a stray
	// `cold_path_wired: undefined` key).
	it("P4: kind 'guard_rule' with cold_path_wired absent round-trips with no stray key", () => {
		const parsed = parseFinding({ ...row, distilled: { detector_id: "d1", kind: "guard_rule" } });
		expect(parsed).not.toBeNull();
		expect(parsed?.distilled).toEqual({ detector_id: "d1", kind: "guard_rule" });
		expect(hasOwn(parsed?.distilled, "cold_path_wired")).toBe(false);
	});
	// Kills: d01646a55f1b8309 (cold_path_wired type-validity check -> false)
	it("N5: distilled.cold_path_wired must be a boolean when present", () => {
		expect(
			parseFinding({
				...row,
				distilled: { detector_id: "d1", kind: "guard_rule", cold_path_wired: "yes" },
			}),
		).toBeNull();
	});
});

describe("parseOptionalScalars", () => {
	// Kills: 4f2cd2feb8dc7baf (validity OR -> AND), 1255ec1fb398103e (whole
	// validity check -> false), and (at the parseFinding level)
	// 709db1291092340c (`optional === null` -> false, which would silently
	// spread `...null` — a no-op — and drop the bad field instead of
	// rejecting the whole row). Note: `typeof category !== "string"` alone
	// (6d31679bbe8930b3) is a separate, EQUIVALENT mutant — see receipts.
	it("N1: an out-of-union category rejects the whole finding", () => {
		expect(parseFinding({ ...row, category: "nonsense" })).toBeNull();
	});

	// Kills: 662c417297bf7d21 (OR -> AND), b5d927cccb6bdd1d (whole -> false),
	// 8d8f159be268afc2 (fix_instruction===null -> false), and (inside the
	// shared `optionalString` helper, reached via this same call)
	// b5db9471beacf8ce (typeof v === "string" -> true, which would let the
	// wrongly-typed 42 through as non-null).
	it("N2: a non-string fix_instruction rejects the whole finding", () => {
		expect(parseFinding({ ...row, fix_instruction: 42, approved_by: "ok" })).toBeNull();
	});
	// Kills: 0ed6bf0059e303e3 (approved_by===null -> false)
	it("N3: a non-string approved_by rejects the whole finding", () => {
		expect(parseFinding({ ...row, fix_instruction: "ok", approved_by: 42 })).toBeNull();
	});

	// Kills: aae3afaf88af77ab (whole -> false), 68d85662933aa167 (OR -> AND),
	// 0801953c25296646 (anchor_span_sha256===null -> false)
	it("N4: a non-string anchor_span_sha256 rejects the whole finding", () => {
		expect(parseFinding({ ...row, anchor_span_sha256: 42, anchor_tree: "sha1" })).toBeNull();
	});
	// Kills: 14d6734f9b53455a (anchor_tree===null -> false)
	it("N5: a non-string anchor_tree rejects the whole finding", () => {
		expect(parseFinding({ ...row, anchor_span_sha256: "sha1", anchor_tree: 42 })).toBeNull();
	});

	// Kills: a1df2b4e8b288686 (anchor_context===null -> false)
	it("N6: an anchor_context array holding a non-string rejects the whole finding", () => {
		expect(parseFinding({ ...row, anchor_context: [1, 2] })).toBeNull();
	});

	// Kills all seven `!== undefined` return-spread ternary mutants forced to
	// `true` (3228003dd420008e, a2d5e1721af8b3bb, 8260dca58d383f77,
	// 1025cfa5c585e755, dea78d5e094bb9fb, f3d39f8a9957c781, ba7f01d3f1a1fd1b):
	// `row` carries none of these seven optional fields, so each ternary's
	// false branch must be taken; forcing any one to `true` adds a stray
	// `key: undefined` property that plain `toEqual` would silently ignore.
	it("N7: a finding with none of the seven optional scalars has none of their keys", () => {
		const parsed = parseFinding(row);
		expect(parsed).not.toBeNull();
		for (const key of [
			"category",
			"fix_instruction",
			"approved_by",
			"distilled",
			"anchor_span_sha256",
			"anchor_context",
			"anchor_tree",
		]) {
			expect(hasOwn(parsed, key)).toBe(false);
		}
	});
});

describe("parseProvenanceEntry — shape and required-scalar guards", () => {
	// Kills: 1fa44e4f2b409578 (!isJsonObject(value) -> false). `null` makes
	// the bypassed code destructure `{...} = null`, which throws — a valid
	// divergence from the pristine clean `null` return.
	it("N1: a null provenance entry is rejected, not thrown through", () => {
		expect(parseProvenanceEntry(null)).toBeNull();
	});

	// Kills: 4ac4aa3c7783856d (whole OR -> false), 2f9f09afc8f175e5
	// (provenance_id check -> false), 7883f938fbda7f5e (OR -> AND). Note:
	// `typeof provenance_completeness !== "string"` alone (aa3484b07e11f813)
	// is a separate, EQUIVALENT mutant — see receipts.
	it("N2: a non-string provenance_id rejects the entry even with a valid source_runner", () => {
		expect(parseProvenanceEntry({ ...prov, provenance_id: 123 })).toBeNull();
	});
	// Kills: 72e7aca8f768517f (source_runner check -> false)
	it("N3: a non-string source_runner rejects the entry even with a valid provenance_id", () => {
		expect(parseProvenanceEntry({ ...prov, source_runner: 123 })).toBeNull();
	});

	// Kills: db02c32b86a58d63 (strings===null -> false, the outer check in
	// parseProvenanceEntry) AND 64186e45eecebad2 (typeof raw !== "string" ->
	// false, inside provenanceStrings itself) — a wrongly-typed free-text
	// field makes both the inner helper and the outer null-check individually
	// responsible for rejection; one fixture isolates each in turn since only
	// one mutant is live per run.
	it("N4: a non-string free-text provenance field (repo) rejects the whole entry", () => {
		expect(parseProvenanceEntry({ ...prov, repo: 123 })).toBeNull();
	});
});

describe("provenanceExtras — is_outdated / is_resolved / enriched_fields / actionability / lines", () => {
	// Kills 11 mutants at once: the ternary-inclusion mutants forced to `true`
	// or flipped to `===` (3b64e6cb0d0794a9, 81c03f8edd8f5783, e8065fd18b88c692,
	// 40a0e0a4ad8dcf50, 281847b1c9616d35, 1d8fb827e5d21e52, f2b5b45db1208b89,
	// d62e7885e15b09cf, 48e6662c488eb4f5, f8706e5de609c69b) all add a stray
	// `key: undefined` when the source field is genuinely absent; plus, at the
	// parseProvenanceEntry level, 5550b18518afa9e3 does the same for
	// raw_sha256.
	it("N1: no optional extra keys appear on a provenance entry with none of them set", () => {
		const parsed = parseProvenanceEntry(prov);
		expect(parsed).not.toBeNull();
		for (const key of ["lines", "actionability", "is_outdated", "is_resolved", "enriched_fields", "raw_sha256"]) {
			expect(hasOwn(parsed, key)).toBe(false);
		}
	});

	// Kills 8 mutants at once: the ternary-inclusion mutants forced to `false`
	// (526d92cb3f0fec0e makes enriched_fields always-undefined regardless of
	// input, 80a5e3da63ea905e, f6f71088560b0ffd, d5cd28526860dd4c,
	// 2939bbda2814170d, 5f5caceb5e78c173) and the two ObjectLiteral mutants
	// that blank the return value (3a4442a9e42c39aa whole object -> {},
	// aabffc965e512eb9 `{ lines }` -> `{}`) — all silently drop a field that
	// IS present and valid.
	it("P1: every optional extra field round-trips its exact value when all are present", () => {
		const parsed = parseProvenanceEntry(fullProv);
		expect(parsed?.lines).toEqual([10, 20]);
		expect(parsed?.actionability).toBe("bug");
		expect(parsed?.is_outdated).toBe(true);
		expect(parsed?.is_resolved).toBe(false);
		expect(parsed?.enriched_fields).toEqual(["migrated"]);
	});

	// Kills: 649dd43934183058 (OR -> AND), ce7017e461c75897 (whole -> false),
	// 257485e05b7d3298 (is_outdated===null -> false)
	it("N2: a non-boolean is_outdated rejects the whole entry", () => {
		expect(parseProvenanceEntry({ ...prov, is_outdated: "bad", is_resolved: true })).toBeNull();
	});
	// Kills: bcb68fad46867c0f (is_resolved===null -> false)
	it("N3: a non-boolean is_resolved rejects the whole entry", () => {
		expect(parseProvenanceEntry({ ...prov, is_outdated: true, is_resolved: "bad" })).toBeNull();
	});

	// Kills: 2cf4fab46e94cec3 (enriched_fields===null -> false)
	it("N4: an enriched_fields array holding a non-string rejects the whole entry", () => {
		expect(parseProvenanceEntry({ ...prov, enriched_fields: [1, 2] })).toBeNull();
	});

	// Kills: ad159ea0226bf5f0 (actionability validity check -> false)
	it("N5: an out-of-union actionability rejects the whole entry", () => {
		expect(parseProvenanceEntry({ ...prov, actionability: "bogus" })).toBeNull();
	});
});

describe("rawSha256 — Buffer-shape legacy recovery", () => {
	// Kills: 8fef36a9fc95d7f5, 645e5121ddc2f5a0, ee0dd4bbc3952ed0,
	// e66c8b4fdb0a9f7d — all four bypass the Buffer-shape check when `data` is
	// a genuine array, letting a wrongly-typed `type` field through.
	it("N1: a wrong `type` with a valid array `data` is still rejected", () => {
		expect(parseProvenanceEntry({ ...prov, raw_sha256: { type: "NotBuffer", data: [1, 2, 3] } })).toBeNull();
	});

	// Kills: 50737def5e172009 (bytes.every -> bytes.some)
	it("N2: ALL bytes must be in range, not just one", () => {
		expect(parseProvenanceEntry({ ...prov, raw_sha256: { type: "Buffer", data: [500, 10] } })).toBeNull();
	});
});

describe("rawSha256 byte predicate — (b): b is number => typeof b === \"number\" && b >= 0 && b <= 255", () => {
	// Kills: 0ee0d740052b22cd (typeof+>=0 sub-expr -> true), 39077ba06d24b8ea
	// (b>=0 -> true)
	it("N1: a negative byte is rejected even alongside a valid one", () => {
		expect(parseProvenanceEntry({ ...prov, raw_sha256: { type: "Buffer", data: [-5, 10] } })).toBeNull();
	});
	// Kills: a908658603eb2f2e (typeof check -> true), dcb5c015e80e4564 (&& -> ||)
	it("N2: a numeric-string byte is rejected — must be typeof number, not coercible", () => {
		expect(parseProvenanceEntry({ ...prov, raw_sha256: { type: "Buffer", data: ["100", 10] } })).toBeNull();
	});
});

describe("provenanceList", () => {
	// Kills: 6906f5248ce51703 (!Array.isArray(v) -> false). A `null`
	// provenance makes the bypassed code `for...of null`, which throws.
	it("N1: a null provenance list is rejected, not thrown through", () => {
		expect(parseFinding({ ...row, provenance: null })).toBeNull();
	});
	// Kills: 103237a9ae62ba8f (parsed===null -> false)
	it("N2: one malformed entry rejects the whole list, not just itself", () => {
		expect(
			parseFinding({
				...row,
				provenance: [{ ...prov, provenance_completeness: "anchored_line" }, { bad: "shape" }],
			}),
		).toBeNull();
	});
});

describe("requiredCore — id / bug_class / message", () => {
	// The pre-existing "rejects a row missing a required field" loop in
	// parse-finding.test.ts covers aliases/check/file/line/severity/
	// provenance_tier/dedup_key/times_observed/source_runners/status/
	// first_seen/last_seen. id, bug_class, and message were never exercised —
	// that's exactly why these three survived.
	// Kills: c012b5eef30bb17c (whole OR -> false), deea13daa36e3768 (id check
	// -> false), 51519d750e859733 (OR -> AND)
	it("N1: rejects a row with no `id`", () => {
		const bad: Record<string, unknown> = { ...row };
		delete bad.id;
		expect(parseFinding(bad)).toBeNull();
	});
	// Kills: ae60950420e25e0e (bug_class check -> false)
	it("N2: rejects a row with no `bug_class`", () => {
		const bad: Record<string, unknown> = { ...row };
		delete bad.bug_class;
		expect(parseFinding(bad)).toBeNull();
	});
	// Kills: e30fb42b6779e697 (message check -> false)
	it("N3: rejects a row with no `message`", () => {
		const bad: Record<string, unknown> = { ...row };
		delete bad.message;
		expect(parseFinding(bad)).toBeNull();
	});
	// NOT killable: 385c3d69c2836249 (typeof severity !== "string" -> false),
	// 04336e1e543f519b (typeof provenance_tier !== "string" -> false),
	// f9ab288d435e29ea (typeof status !== "string" -> false) are each
	// immediately followed by a same-line `!SET.has(x)` check over a
	// string-only Set — see receipts (equivalent_candidate, fuzz-verified).
});
