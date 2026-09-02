import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	detectBaselineGaming,
	evaluateBaselineIntegrityForEvent,
} from "./baseline-integrity-gate.js";

const alwaysExists = () => true;
const neverExists = () => false;
const COV = "/repo/.interlinked/coverage-baseline.json";
const COV_EDIT = "/repo/.interlinked/coverage-edit-baseline.json";
const MUT = "/repo/.interlinked/mutation-baseline.json";
const LARGE = "/repo/.interlinked/large-files-baseline.json";
const UNTESTED = "/repo/.interlinked/untested-files-baseline.json";
const CAPS = "/repo/.interlinked/metric-caps.json";
const SKIPPED = "/repo/.interlinked/skipped-tests-baseline.json";
const EVIDENCE = "/repo/.interlinked/check-evidence-baseline.json";

function detect(file: string, before: unknown, after: unknown, exists = alwaysExists) {
	return detectBaselineGaming(file, JSON.stringify(before), JSON.stringify(after), exists);
}

describe("detectBaselineGaming — not a baseline file / no HEAD", () => {
	it("ignores non-baseline files", () => {
		expect(detectBaselineGaming("/repo/src/foo.ts", "a", "b")).toEqual([]);
		expect(detectBaselineGaming("/repo/.interlinked/other.json", "{}", "{}")).toEqual([]);
	});
	it("returns [] for a brand-new baseline (no before text)", () => {
		expect(detectBaselineGaming(COV, "", '{"files":{}}')).toEqual([]);
	});
	it("fails open on unparseable JSON", () => {
		expect(detectBaselineGaming(COV, "{not json", '{"files":{}}')).toEqual([]);
		expect(detectBaselineGaming(COV, '{"files":{}}', "{not json")).toEqual([]);
	});
});

describe("BASELINE_RE — exact match, not substring containment", () => {
	const lowered = { files: { "src/a.ts": { lines_pct: 10, branches_pct: 10 } } };
	const raised = { files: { "src/a.ts": { lines_pct: 90, branches_pct: 90 } } };

	it("does NOT treat a suffixed filename (e.g. a .bak copy) as the real baseline", () => {
		// The regex must anchor at `.json$` — a trailing suffix after the real
		// extension must not still match.
		expect(detect("/repo/.interlinked/coverage-baseline.json.bak", raised, lowered)).toEqual([]);
	});

	it("still recognizes the baseline path when it starts at the string root (no leading slash)", () => {
		// `(?:^|\/)` must keep BOTH alternatives — a path with no character before
		// `.interlinked` (root of the string) must still match via `^`.
		const found = detect(".interlinked/coverage-baseline.json", raised, lowered);
		expect(found.length).toBeGreaterThan(0);
	});
});

describe("detectBaselineGaming — fails open per-side, not just when BOTH sides are unparseable", () => {
	const validBefore = JSON.stringify({ files: { "src/a.ts": { lines_pct: 90 } } });
	const validAfterWithEntry = JSON.stringify({ min_coverage_pct: 60, files: ["src/a.ts"] });

	it("fails open when only the PROPOSED (after) side is unparseable", () => {
		expect(detectBaselineGaming(COV, validBefore, "{not json", alwaysExists)).toEqual([]);
	});

	it("fails open when only the CURRENT (before) side is unparseable", () => {
		expect(detectBaselineGaming(UNTESTED, "{not json", validAfterWithEntry, alwaysExists)).toEqual([]);
	});
});

describe("coverage-baseline.json — values may only rise", () => {
	const base = { version: 1, files: { "src/a.ts": { lines_pct: 90, branches_pct: 80 } } };
	it("BLOCKS a lowered lines_pct", () => {
		const f = detect(COV, base, { files: { "src/a.ts": { lines_pct: 50, branches_pct: 80 } } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("coverage:src/a.ts:lines_pct");
		expect(f[0]?.message).toBe(
			"coverage-baseline lines_pct for src/a.ts lowered 90→50. This water-line may only rise; meet the bar or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.",
		);
	});
	it("BLOCKS a lowered branches_pct", () => {
		const f = detect(COV, base, { files: { "src/a.ts": { lines_pct: 90, branches_pct: 10 } } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toContain("branches_pct");
	});
	it("BLOCKS removing an entry whose source still exists", () => {
		const f = detect(COV, base, { files: {} }, alwaysExists);
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("coverage:src/a.ts");
		expect(f[0]?.message).toBe(
			"coverage-baseline entry for src/a.ts removed while the source file still exists. Restore it — the harness raises baselines via internal writes, not hand-edits.",
		);
	});
	it("ALLOWS removing an entry whose source was deleted", () => {
		expect(detect(COV, base, { files: {} }, neverExists)).toEqual([]);
	});
	it("ALLOWS raising a pct and adding a new file", () => {
		const after = {
			files: { "src/a.ts": { lines_pct: 95, branches_pct: 85 }, "src/b.ts": { lines_pct: 1, branches_pct: 1 } },
		};
		expect(detect(COV, base, after)).toEqual([]);
	});
	it("ignores a non-object `files` value rather than iterating its characters/indices", () => {
		expect(detect(COV, { files: null }, { files: {} })).toEqual([]);
		expect(detect(COV, { files: "notanobject" }, { files: {} })).toEqual([]);
	});
	it("ignores non-numeric pct values rather than string-comparing them", () => {
		expect(detect(COV, { files: { "src/a.ts": { lines_pct: "90", branches_pct: 80 } } }, { files: { "src/a.ts": { lines_pct: "10", branches_pct: 80 } } })).toEqual([]);
	});
	it("requires BOTH pct values to be numeric before comparing (not just one)", () => {
		expect(detect(COV, base, { files: { "src/a.ts": { lines_pct: "10", branches_pct: 80 } } })).toEqual([]);
	});
});

describe("coverage-edit-baseline.json — flat map, values may only rise", () => {
	it("BLOCKS a lowered value", () => {
		const f = detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": 0.4 });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("coverage-edit:src/a.ts");
		expect(f[0]?.message).toBe(
			"coverage-edit-baseline for src/a.ts lowered 0.9→0.4 within the same test scope. Per-edit coverage may only rise (a scope change re-anchors automatically).",
		);
	});
	it("ALLOWS a raised value and a new entry", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": 0.95, "src/b.ts": 0.1 })).toEqual([]);
	});
	it("ALLOWS an unchanged fraction (equal is not a lowering)", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": 0.9 })).toEqual([]);
	});
	it("BLOCKS removing an entry whose source still exists", () => {
		const f = detect(COV_EDIT, { "src/a.ts": 0.9 }, {}, alwaysExists);
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("coverage-edit:src/a.ts");
		expect(f[0]?.message).toBe("coverage-edit-baseline entry for src/a.ts removed while the source still exists.");
	});
	it("ALLOWS removing an entry whose source was deleted", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, {}, neverExists)).toEqual([]);
	});
	it("skips a before-entry it cannot decode (malformed `f`) rather than crashing on `.f` access", () => {
		expect(detect(COV_EDIT, { "src/a.ts": "garbage" }, {})).toEqual([]);
		expect(detect(COV_EDIT, { "src/a.ts": { f: "bad", scope: "x" } }, {})).toEqual([]);
	});
	it("skips a proposed entry it cannot decode rather than crashing on `.scope` access", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": "garbage" })).toEqual([]);
	});

	// Scoped-object shape ({f, scope}) — the per-edit gate stores which test set
	// measured a fraction so it re-anchors across scopes instead of false-blocking.
	it("BLOCKS a same-scope fraction lowering in the object shape", () => {
		const before = { "src/a.ts": { f: 0.9, scope: "scoped:aaa" } };
		const after = { "src/a.ts": { f: 0.4, scope: "scoped:aaa" } };
		expect(detect(COV_EDIT, before, after)).toHaveLength(1);
	});
	it("ALLOWS a lower fraction under a DIFFERENT scope (legitimate re-anchor)", () => {
		const before = { "src/a.ts": { f: 1, scope: "scoped:broad" } };
		const after = { "src/a.ts": { f: 0.66, scope: "scoped:narrow" } };
		expect(detect(COV_EDIT, before, after)).toEqual([]);
	});
	it("ALLOWS re-anchoring a legacy bare-number entry into the scoped shape", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 1 }, { "src/a.ts": { f: 0.66, scope: "scoped:x" } })).toEqual([]);
	});
	it("BLOCKS a same-scope lowering across the legacy/object boundary (null scope both sides)", () => {
		// A bare number decodes to scope null; an object with no scope also null →
		// same scope → a fraction drop is still gaming.
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": { f: 0.4 } })).toHaveLength(1);
	});
});

describe("mutation-baseline.json — score/killed may only rise", () => {
	const base = { version: 1, files: { "src/a.ts": { score: 0.8, killed: 10 } } };
	it("BLOCKS a lowered score", () => {
		const f = detect(MUT, base, { files: { "src/a.ts": { score: 0.5, killed: 10 } } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("mutation:src/a.ts:score");
	});
	it("BLOCKS a lowered killed count", () => {
		expect(detect(MUT, base, { files: { "src/a.ts": { score: 0.8, killed: 3 } } })).toHaveLength(1);
	});
	it("ALLOWS a raised score", () => {
		expect(detect(MUT, base, { files: { "src/a.ts": { score: 0.9, killed: 12 } } })).toEqual([]);
	});
});

describe("large-files-baseline.json — cap tightens, grandfather counts shrink", () => {
	const base = { version: 1, max_lines: 500, files: { "src/big.ts": 620 } };
	it("BLOCKS raising max_lines", () => {
		const f = detect(LARGE, base, { max_lines: 800, files: { "src/big.ts": 620 } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("max_lines");
		expect(f[0]?.message).toBe("large-files max_lines raised 500→800. The line cap may only tighten.");
	});
	it("BLOCKS raising a grandfather high-water count", () => {
		const f = detect(LARGE, base, { max_lines: 500, files: { "src/big.ts": 700 } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("grandfather:src/big.ts");
		expect(f[0]?.message).toBe(
			"grandfather high-water for src/big.ts raised 620→700. A grandfathered file may shrink or hold, never grow.",
		);
	});
	it("BLOCKS a new grandfather entry over the cap", () => {
		const after = { max_lines: 500, files: { "src/big.ts": 620, "src/new.ts": 550 } };
		const f = detect(LARGE, base, after);
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("grandfather-new:src/new.ts");
		expect(f[0]?.message).toBe(
			"new grandfather entry src/new.ts=550 exceeds the cap (500). That pre-authorizes an over-cap file — decompose it instead.",
		);
	});
	it("ALLOWS a new grandfather entry exactly AT the cap (not over)", () => {
		expect(detect(LARGE, { max_lines: 500, files: {} }, { max_lines: 500, files: { "new.ts": 500 } })).toEqual([]);
	});
	it("ALLOWS lowering the cap, shrinking a count, resolving (removing) an entry, new under-cap entry", () => {
		expect(detect(LARGE, base, { max_lines: 400, files: { "src/big.ts": 600 } })).toEqual([]);
		expect(detect(LARGE, base, { max_lines: 500, files: {} })).toEqual([]);
		expect(detect(LARGE, base, { max_lines: 500, files: { "src/big.ts": 620, "ok.ts": 100 } })).toEqual([]);
	});
	it("ignores non-numeric max_lines values rather than string-comparing them", () => {
		expect(detect(LARGE, { max_lines: "100", files: {} }, { max_lines: "200", files: {} })).toEqual([]);
	});
	it("requires BOTH max_lines values to be numeric before comparing", () => {
		expect(detect(LARGE, { max_lines: 500, files: {} }, { max_lines: "800", files: {} })).toEqual([]);
	});
	it("ignores non-numeric grandfather counts rather than string-comparing them", () => {
		expect(detect(LARGE, { max_lines: 500, files: { "src/big.ts": "620" } }, { max_lines: 500, files: { "src/big.ts": "700" } })).toEqual([]);
	});
	it("requires BOTH grandfather counts to be numeric before comparing", () => {
		expect(detect(LARGE, base, { max_lines: 500, files: { "src/big.ts": "700" } })).toEqual([]);
	});
});

describe("untested-files-baseline.json — INVERTED: exemption list may only shrink", () => {
	const base = { version: 1, min_coverage_pct: 60, files: ["src/a.ts"] };
	it("BLOCKS lowering min_coverage_pct", () => {
		const f = detect(UNTESTED, base, { min_coverage_pct: 30, files: ["src/a.ts"] });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("min_coverage_pct");
		expect(f[0]?.message).toBe("untested-files min_coverage_pct lowered 60→30. The coverage floor may only rise.");
	});
	it("BLOCKS adding a path to the exemption list", () => {
		const f = detect(UNTESTED, base, { min_coverage_pct: 60, files: ["src/a.ts", "src/b.ts"] });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toBe("exempt-added:src/b.ts");
		expect(f[0]?.message).toBe(
			"src/b.ts added to the untested-files exemption list — that exempts a new file from the coverage floor. Cover it instead.",
		);
	});
	it("ALLOWS raising the floor and removing an exemption", () => {
		expect(detect(UNTESTED, base, { min_coverage_pct: 80, files: [] })).toEqual([]);
	});
	it("ignores non-numeric min_coverage_pct values rather than string-comparing them", () => {
		expect(detect(UNTESTED, { min_coverage_pct: "60", files: [] }, { min_coverage_pct: "10", files: [] })).toEqual([]);
	});
	it("requires BOTH min_coverage_pct values to be numeric before comparing", () => {
		expect(detect(UNTESTED, base, { min_coverage_pct: "10", files: ["src/a.ts"] })).toEqual([]);
	});
	it("ignores a non-string entry in the exemption list", () => {
		expect(detect(UNTESTED, { min_coverage_pct: 60, files: [] }, { min_coverage_pct: 60, files: [42] })).toEqual([]);
	});
});

describe("check-evidence-baseline.json — INVERTED: exemption list may only shrink", () => {
	const base = { exempt: ["self_import", "eval_usage"] };

	it("P1: BLOCKS adding a check id to the exemption list", () => {
		const after = { exempt: ["self_import", "eval_usage", "brand_new_check"] };
		const found = detect(EVIDENCE, base, after);
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("exempt-added:brand_new_check");
		expect(found[0]?.message).toBe(
			"brand_new_check added to the check-evidence exemption list — that exempts a check from shipping MUST-FIRE / MUST-NOT-FIRE cases. Write the cases instead.",
		);
	});

	it("ignores a non-string entry in `exempt` rather than flagging it", () => {
		expect(detect(EVIDENCE, { exempt: [] }, { exempt: [42] })).toEqual([]);
	});

	it("P2: BLOCKS each added id separately so the report names all of them", () => {
		const after = { exempt: ["self_import", "eval_usage", "a_check", "b_check"] };
		expect(detect(EVIDENCE, base, after)).toHaveLength(2);
	});

	it("P3: BLOCKS an add even when another entry is simultaneously removed", () => {
		// Swapping one exemption for another keeps the count flat but still
		// exempts a check that was previously gated.
		const after = { exempt: ["self_import", "sneaky_check"] };
		expect(detect(EVIDENCE, base, after)).toHaveLength(1);
	});

	it("N1: ALLOWS removing an exemption (the ratchet direction)", () => {
		expect(detect(EVIDENCE, base, { exempt: ["self_import"] })).toEqual([]);
	});

	it("N2: ALLOWS emptying the list entirely", () => {
		expect(detect(EVIDENCE, base, { exempt: [] })).toEqual([]);
	});

	it("N3: ALLOWS an unchanged list", () => {
		expect(detect(EVIDENCE, base, base)).toEqual([]);
	});

	it("N4: ALLOWS a note-only edit", () => {
		expect(detect(EVIDENCE, base, { ...base, note: "clarified the policy" })).toEqual([]);
	});

	it("N5: ignores a malformed exempt field rather than blocking blindly", () => {
		expect(detect(EVIDENCE, base, { exempt: "not-an-array" })).toEqual([]);
	});

	describe("enforced dimensions — GROW-ONLY", () => {
		const staged = { exempt: [], enforced: ["cases", "corpus"] };

		it("P1: BLOCKS dropping an enforced dimension", () => {
			const found = detect(EVIDENCE, staged, { exempt: [], enforced: ["cases"] });
			expect(found).toHaveLength(1);
			expect(found[0]?.rule).toBe("enforced-removed:corpus");
			expect(found[0]?.message).toMatch(/corpus/);
		});

		it("ignores a non-string entry when computing enforced-shrink (does not report it)", () => {
			expect(detect(EVIDENCE, { exempt: [], enforced: [42] }, { exempt: [], enforced: [] })).toEqual([]);
		});

		it("treats an absent `enforced` field as truly empty (before-side fallback isn't seeded with a placeholder)", () => {
			// If the "before" default fallback for a missing/malformed `enforced`
			// leaked a non-empty placeholder array, widening enforcement from an
			// absent field would spuriously report that placeholder as dropped.
			expect(detect(EVIDENCE, { exempt: [] }, { exempt: [], enforced: ["cases"] })).toEqual([]);
		});

		it("treats an absent `enforced` field as truly empty (after-side fallback isn't seeded with a placeholder)", () => {
			// If the "after" default fallback leaked a placeholder, a genuinely
			// dropped dimension that happens to collide with the placeholder text
			// would be silently swallowed instead of reported.
			const staged2 = { exempt: [], enforced: ["Stryker was here"] };
			const found = detect(EVIDENCE, staged2, { exempt: [] });
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toMatch(/Stryker was here/);
		});

		it("P2: BLOCKS clearing the list entirely, once per dropped dimension", () => {
			expect(detect(EVIDENCE, staged, { exempt: [], enforced: [] })).toHaveLength(2);
		});

		it("P3: BLOCKS removing the field altogether", () => {
			expect(detect(EVIDENCE, staged, { exempt: [] })).toHaveLength(2);
		});

		it("N1: ALLOWS widening enforcement", () => {
			expect(detect(EVIDENCE, staged, { exempt: [], enforced: ["cases", "corpus", "mutation"] })).toEqual([]);
		});

		it("N2: ALLOWS an unchanged list", () => {
			expect(detect(EVIDENCE, staged, staged)).toEqual([]);
		});

		it("N3: ALLOWS reordering", () => {
			expect(detect(EVIDENCE, staged, { exempt: [], enforced: ["corpus", "cases"] })).toEqual([]);
		});

		it("reports an enforced shrink and an exemption add together", () => {
			const after = { exempt: ["new_check"], enforced: ["cases"] };
			expect(detect(EVIDENCE, staged, after)).toHaveLength(2);
		});
	});
});

describe("skipped-tests-baseline.json — skip cap tightens, grandfather counts shrink", () => {
	const base = { version: 1, max_skipped: 0, files: { "src/legacy.test.ts": 3 } };
	it("BLOCKS raising max_skipped", () => {
		const found = detect(SKIPPED, base, { max_skipped: 2, files: { "src/legacy.test.ts": 3 } });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("max_skipped");
		expect(found[0]?.message).toBe(
			"skipped-tests max_skipped raised 0→2. The skip cap may only tighten — fix or delete the skipped test instead.",
		);
	});
	it("BLOCKS raising a grandfather skip ceiling", () => {
		const found = detect(SKIPPED, base, { max_skipped: 0, files: { "src/legacy.test.ts": 5 } });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("grandfather:src/legacy.test.ts");
		expect(found[0]?.message).toBe(
			"skipped-tests grandfather for src/legacy.test.ts raised 3→5. A grandfathered file may re-enable tests, never skip more.",
		);
	});
	it("BLOCKS a new grandfather entry above the cap", () => {
		const after = { max_skipped: 0, files: { "src/legacy.test.ts": 3, "src/new.test.ts": 1 } };
		const found = detect(SKIPPED, base, after);
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("grandfather-new:src/new.test.ts");
		expect(found[0]?.message).toBe(
			"new skipped-tests grandfather entry src/new.test.ts=1 exceeds the cap (0). That pre-authorizes new skips — re-enable the tests instead.",
		);
	});
	it("ALLOWS a new grandfather entry exactly AT the cap (not over)", () => {
		expect(detect(SKIPPED, { max_skipped: 2, files: {} }, { max_skipped: 2, files: { "src/new.test.ts": 2 } })).toEqual([]);
	});
	it("ALLOWS shrinking a ceiling, resolving an entry, and holding steady", () => {
		expect(detect(SKIPPED, base, { max_skipped: 0, files: { "src/legacy.test.ts": 1 } })).toEqual([]);
		expect(detect(SKIPPED, base, { max_skipped: 0, files: {} })).toEqual([]);
		expect(detect(SKIPPED, base, base)).toEqual([]);
	});
	it("ignores non-numeric max_skipped values rather than string-comparing them", () => {
		expect(detect(SKIPPED, { max_skipped: "0", files: {} }, { max_skipped: "2", files: {} })).toEqual([]);
	});
	it("requires BOTH max_skipped values to be numeric before comparing", () => {
		expect(detect(SKIPPED, { max_skipped: 0, files: {} }, { max_skipped: "2", files: {} })).toEqual([]);
	});
	it("ignores non-numeric grandfather skip counts rather than string-comparing them", () => {
		expect(detect(SKIPPED, { max_skipped: 0, files: { "src/legacy.test.ts": "3" } }, { max_skipped: 0, files: { "src/legacy.test.ts": "5" } })).toEqual([]);
	});
	it("requires BOTH grandfather skip counts to be numeric before comparing", () => {
		expect(detect(SKIPPED, base, { max_skipped: 0, files: { "src/legacy.test.ts": "5" } })).toEqual([]);
	});
});

describe("metric-caps.json — caps may only tighten", () => {
	const base = { max_lines: 500, max_function_tokens: 500, max_cyclomatic: 25, crap_threshold: 30, min_coverage: 60 };
	it("BLOCKS raising max_function_tokens", () => {
		const found = detect(CAPS, { ...base, max_function_tokens: 400 }, { ...base, max_function_tokens: 401 });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("max_function_tokens");
	});
	it("BLOCKS raising max_cyclomatic", () => {
		const found = detect(CAPS, base, { ...base, max_cyclomatic: 40 });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("max_cyclomatic");
		expect(found[0]?.message).toBe("metric-caps max_cyclomatic raised 25→40. Caps may only tighten.");
	});
	it("BLOCKS raising max_cognitive", () => {
		const found = detect(CAPS, { ...base, max_cognitive: 30 }, { ...base, max_cognitive: 45 });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("max_cognitive");
	});
	it("BLOCKS raising crap_threshold and max_lines", () => {
		expect(detect(CAPS, base, { ...base, crap_threshold: 50, max_lines: 900 })).toHaveLength(2);
	});
	it("BLOCKS lowering min_coverage", () => {
		const found = detect(CAPS, base, { ...base, min_coverage: 0 });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("min_coverage");
		expect(found[0]?.message).toBe("metric-caps min_coverage lowered 60→0. The coverage floor may only rise.");
	});
	it("ignores non-numeric metric-cap values rather than string-comparing them", () => {
		expect(detect(CAPS, { ...base, max_cyclomatic: "20" }, { ...base, max_cyclomatic: "99" })).toEqual([]);
	});
	it("requires BOTH metric-cap values to be numeric before comparing", () => {
		expect(detect(CAPS, { ...base, max_cyclomatic: 25 }, { ...base, max_cyclomatic: "99" })).toEqual([]);
	});
	it("ignores non-numeric min_coverage values rather than string-comparing them", () => {
		expect(detect(CAPS, { ...base, min_coverage: "80" }, { ...base, min_coverage: "10" })).toEqual([]);
	});
	it("requires BOTH min_coverage values to be numeric before comparing", () => {
		expect(detect(CAPS, { ...base, min_coverage: 60 }, { ...base, min_coverage: "10" })).toEqual([]);
	});
	it("BLOCKS raising max_predicate_drift — the drift count may only fall", () => {
		const b = { ...base, max_predicate_drift: 7 };
		const found = detect(CAPS, b, { ...b, max_predicate_drift: 9 });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("max_predicate_drift");
	});
	it("ALLOWS ratcheting max_predicate_drift down toward zero", () => {
		const b = { ...base, max_predicate_drift: 7 };
		expect(detect(CAPS, b, { ...b, max_predicate_drift: 0 })).toEqual([]);
	});
	it("ALLOWS tightening every cap", () => {
		expect(detect(CAPS, base, { max_lines: 400, max_cyclomatic: 20, crap_threshold: 25, min_coverage: 80 })).toEqual([]);
	});
});

describe("default sourceExists (real fs)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	it("blocks removal of an entry whose real source file exists", () => {
		const root = mkdtempSync(join(tmpdir(), "bi-"));
		dirs.push(root);
		writeFileSync(join(root, "real.ts"), "export const x = 1;");
		const file = join(root, ".interlinked", "coverage-baseline.json");
		const before = JSON.stringify({ files: { "real.ts": { lines_pct: 90 } } });
		// no injected predicate → uses makeDefaultSourceExists rooted at `root`
		expect(detectBaselineGaming(file, before, JSON.stringify({ files: {} }))).toHaveLength(1);
		// a phantom source → removal allowed
		const before2 = JSON.stringify({ files: { "ghost.ts": { lines_pct: 90 } } });
		expect(detectBaselineGaming(file, before2, JSON.stringify({ files: {} }))).toEqual([]);
	});

	it("normalizes a backslash-separated (Windows-style) baseline path before computing the source root", () => {
		const root = mkdtempSync(join(tmpdir(), "bi-win-"));
		dirs.push(root);
		writeFileSync(join(root, "real.ts"), "export const x = 1;");
		const posixFile = join(root, ".interlinked", "coverage-baseline.json");
		const winFile = posixFile.replace(/\//g, "\\");
		const before = JSON.stringify({ files: { "real.ts": { lines_pct: 90 } } });
		expect(detectBaselineGaming(winFile, before, JSON.stringify({ files: {} }))).toHaveLength(1);
	});
});

function mkEvent(toolInput: Record<string, unknown>, cwd?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "t",
		tool_name: "Write",
		tool_input: toolInput,
		cwd,
	} as unknown as HarnessEvent;
}

describe("evaluateBaselineIntegrityForEvent", () => {
	const lower = JSON.stringify({ files: { "src/a.ts": { lines_pct: 10 } } });
	const head = JSON.stringify({ files: { "src/a.ts": { lines_pct: 90 } } });
	const deps = { getDisk: () => head };

	it("returns null for a non-baseline file", () => {
		expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: "/repo/src/a.ts", content: lower }), deps)).toBeNull();
	});
	it("respects the INTERLINKED_DISABLE_BASELINE_GUARD bypass", () => {
		const prev = process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
		process.env.INTERLINKED_DISABLE_BASELINE_GUARD = "1";
		try {
			expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: lower }), deps)).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
			else process.env.INTERLINKED_DISABLE_BASELINE_GUARD = prev;
		}
	});
	it("BLOCKS a Write that lowers a baseline", () => {
		const d = evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: lower }), deps);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
	});
	it("BLOCKS an Edit (old_string/new_string) that lowers a baseline", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, old_string: '"lines_pct":90', new_string: '"lines_pct":10' }),
			{ getDisk: () => head },
		);
		expect(d?.decision).toBe("block");
	});
	it("BLOCKS a MultiEdit that lowers a baseline", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, edits: [{ old_string: '"lines_pct":90', new_string: '"lines_pct":10' }] }),
			{ getDisk: () => head },
		);
		expect(d?.decision).toBe("block");
	});
	it("ALLOWS a Write that raises a baseline", () => {
		const raise = JSON.stringify({ files: { "src/a.ts": { lines_pct: 99 } } });
		expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: raise }), deps)).toBeNull();
	});
	it("fails open when the baseline does not exist yet", () => {
		expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: lower }), { getDisk: () => null })).toBeNull();
	});
	it("fails open when an Edit cannot be reconstructed", () => {
		expect(
			evaluateBaselineIntegrityForEvent(
				mkEvent({ file_path: COV, old_string: "absent", new_string: "x" }),
				{ getDisk: () => head },
			),
		).toBeNull();
	});

	it("does not touch disk for a non-baseline file (early-return guard fires before reading)", () => {
		let called = false;
		const spyDeps = {
			getDisk: () => {
				called = true;
				return head;
			},
		};
		evaluateBaselineIntegrityForEvent(mkEvent({ file_path: "/repo/src/a.ts", content: lower }), spyDeps);
		expect(called).toBe(false);
	});

	it("does not attempt to reconstruct an Edit against a non-existent baseline (fails open before crashing)", () => {
		expect(() =>
			evaluateBaselineIntegrityForEvent(
				mkEvent({ file_path: COV, old_string: "x", new_string: "y" }),
				{ getDisk: () => null },
			),
		).not.toThrow();
		expect(
			evaluateBaselineIntegrityForEvent(
				mkEvent({ file_path: COV, old_string: "x", new_string: "y" }),
				{ getDisk: () => null },
			),
		).toBeNull();
	});

	it("stops reconstructing a MultiEdit chain once a step fails, rather than crashing on the next step", () => {
		expect(() =>
			evaluateBaselineIntegrityForEvent(
				mkEvent({
					file_path: COV,
					edits: [
						{ old_string: "does-not-exist", new_string: "x" },
						{ old_string: "still-not-there", new_string: "y" },
					],
				}),
				{ getDisk: () => head },
			),
		).not.toThrow();
	});

	it("skips a malformed MultiEdit step (missing new_string) instead of corrupting the reconstruction", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({
				file_path: COV,
				edits: [
					{ old_string: '"lines_pct":90' }, // malformed: no new_string
					{ old_string: '"lines_pct":90', new_string: '"lines_pct":10' },
				],
			}),
			{ getDisk: () => head },
		);
		expect(d?.decision).toBe("block");
	});

	it("skips a malformed MultiEdit step (missing old_string) instead of misreconstructing", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({
				file_path: COV,
				edits: [
					{ new_string: "ignored" }, // malformed: no old_string
					{ old_string: '"lines_pct":90', new_string: '"lines_pct":10' },
				],
			}),
			{ getDisk: () => head },
		);
		expect(d?.decision).toBe("block");
	});

	it("requires old_string to actually be a string type (rejects a numeric old_string rather than coercing it)", () => {
		const customHead = JSON.stringify({ files: { "src/a.ts": { lines_pct: 123 } } });
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, old_string: 123, new_string: "10" }),
			{ getDisk: () => customHead },
		);
		expect(d).toBeNull();
	});

	it("requires new_string to actually be a string type (rejects a numeric new_string rather than coercing it)", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, old_string: "90", new_string: 10 }),
			{ getDisk: () => head },
		);
		expect(d).toBeNull();
	});

	it("shapes the block decision precisely: severity, category, reason text, and multi-finding join separator", () => {
		const beforeTwo = JSON.stringify({ files: { "src/a.ts": { lines_pct: 90, branches_pct: 80 } } });
		const afterTwo = JSON.stringify({ files: { "src/a.ts": { lines_pct: 10, branches_pct: 5 } } });
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, content: afterTwo }),
			{ getDisk: () => beforeTwo },
		);
		expect(d?.severity).toBe("high");
		expect(d?.category).toBe("config");
		expect(d?.reason).toContain(`BLOCKED: this edit loosens a ratchet baseline in ${COV}:`);
		expect(d?.reason).toContain(
			"[coverage:src/a.ts:lines_pct] coverage-baseline lines_pct for src/a.ts lowered 90→10. This water-line may only rise; meet the bar or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.\n  " +
				"[coverage:src/a.ts:branches_pct] coverage-baseline branches_pct for src/a.ts lowered 80→5. This water-line may only rise; meet the bar or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.",
		);
		expect(d?.reason).toContain(
			"Ratchet water-lines may only move in the tightening direction. The harness raises them itself via internal writes; an agent hand-lowering one defeats every ratchet at once. If this is an intentional reset, set INTERLINKED_DISABLE_BASELINE_GUARD=1.",
		);
	});
});

describe("mutation-manifest accepted-survivor set may only shrink (spec §7)", () => {
	const MUT_MANIFEST = "/repo/.interlinked/mutation-manifest.json";
	const mm = (status: string) => ({ version: 1, files: { "a.ts": { sym1: { mutants: { m1: { status } } } } } });

	it("blocks hand-adding a survived/equivalent entry to silence the gate", () => {
		const findings = detect(MUT_MANIFEST, mm("killed"), mm("survived"));
		expect(findings.some((f) => f.rule.includes("accepted-survivor-added"))).toBe(true);
		const f = findings.find((x) => x.rule.includes("accepted-survivor-added"));
		expect(f?.message).toMatch(/hand-added to the accepted-survivor set/);
	});

	it("also blocks hand-adding an EQUIVALENT-status entry, not just survived", () => {
		const findings = detect(MUT_MANIFEST, mm("killed"), mm("equivalent"));
		expect(findings.some((f) => f.rule.includes("accepted-survivor-added"))).toBe(true);
	});

	it("allows shrinking the accepted set (survived → killed)", () => {
		expect(detect(MUT_MANIFEST, mm("survived"), mm("killed"))).toEqual([]);
	});

	it("allows an unchanged manifest", () => {
		expect(detect(MUT_MANIFEST, mm("survived"), mm("survived"))).toEqual([]);
	});
});

describe("function-complexity-baseline.json — the per-function grandfather ledger is shrink-only", () => {
	const LEDGER = "/repo/.interlinked/function-complexity-baseline.json";
	const before = {
		version: 1,
		metrics: { cyclomatic: { cap: 16, entries: [{ file: "src/a.ts", name: "big", line: 3, value: 20 }] } },
	};

	it("BLOCKS raising a metric cap through detectBaselineGaming (a water-line kind, dispatched via KIND_MAP)", () => {
		const after = { version: 1, metrics: { cyclomatic: { cap: 18, entries: before.metrics.cyclomatic.entries } } };
		expect(detect(LEDGER, before, after).map((f) => f.rule)).toEqual(["cyclomatic:cap"]);
	});

	it("BLOCKS a Write that adds an entry or raises one, under the baseline_integrity_gate rule id", () => {
		const after = {
			version: 1,
			metrics: {
				cyclomatic: {
					cap: 16,
					entries: [
						{ file: "src/a.ts", name: "big", line: 3, value: 21 },
						{ file: "src/b.ts", name: "fresh", line: 1, value: 30 },
					],
				},
			},
		};
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: LEDGER, content: JSON.stringify(after) }),
			{ getDisk: () => JSON.stringify(before) },
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
		expect(d?.reason).toContain("cyclomatic:grandfather:src/a.ts:big");
		expect(d?.reason).toContain("cyclomatic:grandfather-new:src/b.ts:fresh");
	});

	it("allows a Write that tightens the cap and drops an entry (the burn-down path)", () => {
		const after = { version: 1, metrics: { cyclomatic: { cap: 12, entries: [] } } };
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: LEDGER, content: JSON.stringify(after) }),
			{ getDisk: () => JSON.stringify(before) },
		);
		expect(d).toBeNull();
	});

	it("P: BLOCKS a Write that CREATES the ledger — only `caps ratchet` (internal write) creates it", () => {
		// No ledger = legacy delta semantics (the stricter state); a hand-written
		// first ledger pre-authorizes every function it lists, so creation is the
		// one loosening move the other water-lines' "new baseline" rule misses.
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: LEDGER, content: JSON.stringify(before) }),
			{ getDisk: () => null },
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
		expect(d?.reason).toContain("caps ratchet");
	});

	it("N: creating any OTHER water-line for the first time is still not a loosening", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: CAPS, content: JSON.stringify({ version: 1, max_cyclomatic: 999 }) }),
			{ getDisk: () => null },
		);
		expect(d).toBeNull();
	});

	it("N: a tightening ratchet may list functions the tightening newly put over the cap (value ≤ old cap)", () => {
		const after = {
			version: 1,
			metrics: {
				cyclomatic: {
					cap: 12,
					entries: [
						{ file: "src/a.ts", name: "big", line: 3, value: 20 },
						{ file: "src/a.ts", name: "mid", line: 40, value: 14 },
					],
				},
			},
		};
		expect(detect(LEDGER, before, after)).toEqual([]);
	});

	it("P: a tightening that smuggles an entry ABOVE the old cap still blocks", () => {
		const after = {
			version: 1,
			metrics: {
				cyclomatic: {
					cap: 12,
					entries: [
						{ file: "src/a.ts", name: "big", line: 3, value: 20 },
						{ file: "src/a.ts", name: "huge", line: 40, value: 17 },
					],
				},
			},
		};
		expect(detect(LEDGER, before, after).map((f) => f.rule)).toEqual([
			"cyclomatic:grandfather-new:src/a.ts:huge",
		]);
	});
});
