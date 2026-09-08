import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIMITIVE_CALL_SITE_THRESHOLD } from "../discovered-primitives.js";
import type { PreEditBaseline } from "../types.js";
import { type RatchetContext, runRatchetComparison } from "./ratchet-comparison.js";

// ===========================================
// Fixture helpers
// ===========================================
//
// runRatchetComparison(ctx) compares post-edit metric counts in
// `ctx.postContent` against the pre-edit counts in `ctx.baseline` and emits
// one warning per dimension that regressed. The guard at the top short-
// circuits unless diff-aware is OFF (`diffAwareEnabled === false`) AND a
// baseline is present. Everything below assumes that gate is open unless the
// test is specifically exercising the gate.

/** Build a fully-populated baseline with every counter at zero so each
 *  ratchet dimension starts from a clean slate; callers bump only the
 *  dimension(s) they care about. `exactOptionalPropertyTypes` is on, so we
 *  only set keys we want present — but for the "all zero" baseline we want
 *  every optional ratchet active, so we set them all explicitly to 0. */
function zeroBaseline(overrides: Partial<PreEditBaseline> = {}): PreEditBaseline {
	const base: PreEditBaseline = {
		missingReturnTypes: new Set<string>(),
		complexFunctions: new Set<string>(),
		capturedAt: 0,
		suppressionCount: 0,
		asAnyCastCount: 0,
		nonNullAssertionCount: 0,
		todoMarkerCount: 0,
		consoleStatementCount: 0,
		publicApiSurfaceCount: 0,
		typeDensity: {
			anyAnnotations: 0,
			unknownAnnotations: 0,
			functionType: 0,
			emptyObjectType: 0,
			untypedExportedParams: 0,
			missingExportedReturnType: 0,
		},
	};
	return { ...base, ...overrides };
}

/** Minimal baseline carrying ONLY the always-present required counters, so
 *  the optional Batch-7 / type-density / primitive ratchets are all skipped
 *  (their `!== undefined` guards are false). */
function requiredOnlyBaseline(overrides: Partial<PreEditBaseline> = {}): PreEditBaseline {
	const base: PreEditBaseline = {
		missingReturnTypes: new Set<string>(),
		complexFunctions: new Set<string>(),
		capturedAt: 0,
		suppressionCount: 0,
		asAnyCastCount: 0,
		nonNullAssertionCount: 0,
	};
	return { ...base, ...overrides };
}

function makeCtx(overrides: Partial<RatchetContext> = {}): RatchetContext {
	return {
		absPath: "/repo/src/touched.ts",
		postContent: "",
		baseline: zeroBaseline(),
		cwd: "/repo",
		diffAwareEnabled: false,
		...overrides,
	};
}

function names(results: ReturnType<typeof runRatchetComparison>): string[] {
	return results.map((r) => r.name);
}

// ===========================================
// Gate: when does the ratchet run at all
// ===========================================

describe("runRatchetComparison — activation gate", () => {
	it("returns [] when diff-aware is enabled (true)", () => {
		const results = runRatchetComparison(
			makeCtx({
				diffAwareEnabled: true,
				baseline: zeroBaseline(),
				// content that WOULD regress every dimension — must still be ignored
				postContent: "// @ts-ignore\nconst x = y as any;\nconst z = a!.b;\n// TODO",
			}),
		);
		expect(results).toEqual([]);
	});

	it("returns [] when diff-aware is undefined (not explicitly disabled)", () => {
		const results = runRatchetComparison(
			makeCtx({
				diffAwareEnabled: undefined,
				postContent: "const x = y as any;",
			}),
		);
		expect(results).toEqual([]);
	});

	it("returns [] when no baseline is present even if diff-aware is off", () => {
		const results = runRatchetComparison(
			makeCtx({
				diffAwareEnabled: false,
				baseline: undefined,
				postContent: "const x = y as any;",
			}),
		);
		expect(results).toEqual([]);
	});

	it("runs (produces a finding) only when diff-aware is false AND baseline present", () => {
		const results = runRatchetComparison(
			makeCtx({
				diffAwareEnabled: false,
				baseline: zeroBaseline(),
				postContent: "const x = y as any;",
			}),
		);
		expect(names(results)).toContain("as_any_ratchet");
	});
});

// ===========================================
// Suppression / as-any / non-null core ratchets
// ===========================================

describe("runRatchetComparison — suppression_ratchet", () => {
	it("fires when suppression directives increase, with before→after counts", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ suppressionCount: 1 }),
				// two suppression directives in post content
				postContent: "// @ts-ignore\nconst a = 1;\n// eslint-disable-next-line foo\nconst b = 2;",
			}),
		);
		const finding = results.find((r) => r.name === "suppression_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
		expect(finding?.file).toBe("/repo/src/touched.ts");
		expect(finding?.message).toContain("1 → 2");
		expect(finding?.message).toMatch(/@ts-ignore|eslint-disable/);
	});

	it("does NOT fire when suppression count is unchanged (equal, not greater)", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ suppressionCount: 1 }),
				postContent: "// @ts-ignore\nconst a = 1;",
			}),
		);
		expect(names(results)).not.toContain("suppression_ratchet");
	});

	it("does NOT fire when suppression count decreases", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ suppressionCount: 5 }),
				postContent: "// @ts-ignore\nconst a = 1;",
			}),
		);
		expect(names(results)).not.toContain("suppression_ratchet");
	});
});

describe("runRatchetComparison — as_any_ratchet", () => {
	it("fires when `as any` casts increase", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ asAnyCastCount: 0 }),
				postContent: "const a = x as any;\nconst b = y as any;",
			}),
		);
		const finding = results.find((r) => r.name === "as_any_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("0 → 2");
		expect(finding?.file).toBe("/repo/src/touched.ts");
	});

	it("does NOT fire when `as any` count holds steady", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ asAnyCastCount: 1 }),
				postContent: "const a = x as any;",
			}),
		);
		expect(names(results)).not.toContain("as_any_ratchet");
	});
});

describe("runRatchetComparison — non_null_assertion_ratchet", () => {
	it("fires when non-null assertions increase", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ nonNullAssertionCount: 0 }),
				postContent: "const a = foo!.bar;\nconst b = baz!.qux;",
			}),
		);
		const finding = results.find((r) => r.name === "non_null_assertion_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("0 → 2");
		expect(finding?.message).toContain("foo?.bar");
	});

	it("does NOT fire when non-null assertions are unchanged", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ nonNullAssertionCount: 1 }),
				postContent: "const a = foo!.bar;",
			}),
		);
		expect(names(results)).not.toContain("non_null_assertion_ratchet");
	});
});

describe("runRatchetComparison — unjustified_cast_ratchet", () => {
	it("fires when unjustified `as` casts increase, with before→after counts", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ unjustifiedCastCount: 0 }),
				// two `as` casts with no `// SAFETY:` justification
				postContent: "const a = x as Foo;\nconst b = y as Bar;",
			}),
		);
		const finding = results.find((r) => r.name === "unjustified_cast_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
		expect(finding?.file).toBe("/repo/src/touched.ts");
		expect(finding?.message).toContain("0 -> 2");
		expect(finding?.message).toContain("SAFETY:");
	});

	it("does NOT fire when the unjustified-cast count is unchanged", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ unjustifiedCastCount: 1 }),
				postContent: "const a = x as Foo;",
			}),
		);
		expect(names(results)).not.toContain("unjustified_cast_ratchet");
	});

	it("does NOT fire when unjustifiedCastCount is absent on the baseline (optional guard)", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: requiredOnlyBaseline(),
				postContent: "const a = x as Foo;\nconst b = y as Bar;",
			}),
		);
		expect(names(results)).not.toContain("unjustified_cast_ratchet");
	});
});

describe("runRatchetComparison — multiple core dimensions at once", () => {
	it("emits findings in declaration order: suppression, as-any, non-null", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline(),
				postContent: "// @ts-ignore\nconst a = x as any;\nconst b = foo!.bar;",
			}),
		);
		expect(names(results)).toEqual([
			"suppression_ratchet",
			"as_any_ratchet",
			"non_null_assertion_ratchet",
		]);
	});

	it("emits nothing when an empty file regresses nothing against a zero baseline", () => {
		const results = runRatchetComparison(makeCtx({ baseline: zeroBaseline(), postContent: "" }));
		expect(results).toEqual([]);
	});
});

// ===========================================
// Batch 7 ratchets: todo / console / public-API surface
// ===========================================

describe("runRatchetComparison — todo_marker_ratchet", () => {
	it("fires when TODO/FIXME markers increase", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ todoMarkerCount: 0 }),
				postContent: "// TODO: wire this up\nconst a = 1; // FIXME later",
			}),
		);
		const finding = results.find((r) => r.name === "todo_marker_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("0 → 2");
		expect(finding?.message).toMatch(/TODO\(TICKET-123\)/);
	});

	it("does NOT fire when todoMarkerCount is absent (optional guard skips it)", () => {
		const results = runRatchetComparison(
			makeCtx({
				// requiredOnly omits todoMarkerCount entirely
				baseline: requiredOnlyBaseline(),
				postContent: "// TODO: many markers\n// FIXME\n// HACK\n// XXX",
			}),
		);
		expect(names(results)).not.toContain("todo_marker_ratchet");
	});

	it("does NOT fire when marker count is unchanged", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ todoMarkerCount: 2 }),
				postContent: "// TODO one\n// FIXME two",
			}),
		);
		expect(names(results)).not.toContain("todo_marker_ratchet");
	});
});

describe("runRatchetComparison — console_statement_ratchet", () => {
	it("fires when console.* statements increase", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ consoleStatementCount: 0 }),
				postContent: "console.log('a');\nconsole.error('b');",
			}),
		);
		const finding = results.find((r) => r.name === "console_statement_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("0 → 2");
		expect(finding?.message).toMatch(/structured logger/);
	});

	it("does NOT fire when consoleStatementCount is absent on the baseline", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: requiredOnlyBaseline(),
				postContent: "console.log('a'); console.warn('b');",
			}),
		);
		expect(names(results)).not.toContain("console_statement_ratchet");
	});

	it("does NOT fire when console count holds", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ consoleStatementCount: 1 }),
				postContent: "console.log('only one');",
			}),
		);
		expect(names(results)).not.toContain("console_statement_ratchet");
	});
});

describe("runRatchetComparison — public_api_surface_ratchet", () => {
	it("fires when exported-symbol count grows", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ publicApiSurfaceCount: 1 }),
				postContent: "export const a = 1;\nexport const b = 2;\nexport function c() {}",
			}),
		);
		const finding = results.find((r) => r.name === "public_api_surface_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("1 → 3");
		expect(finding?.message).toMatch(/exported symbols/);
	});

	it("does NOT fire when publicApiSurfaceCount is absent on the baseline", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: requiredOnlyBaseline(),
				postContent: "export const a = 1;\nexport const b = 2;",
			}),
		);
		expect(names(results)).not.toContain("public_api_surface_ratchet");
	});

	it("does NOT fire when the export count shrinks", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ publicApiSurfaceCount: 5 }),
				postContent: "export const a = 1;",
			}),
		);
		expect(names(results)).not.toContain("public_api_surface_ratchet");
	});
});

// ===========================================
// Composite type-density ratchet
// ===========================================

describe("runRatchetComparison — type_density_ratchet", () => {
	it("fires once with a single dimension listed when `: any` annotations grow", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({
					typeDensity: {
						anyAnnotations: 0,
						unknownAnnotations: 0,
						functionType: 0,
						emptyObjectType: 0,
						untypedExportedParams: 0,
						missingExportedReturnType: 0,
					},
				}),
				postContent: "let a: any;\nlet b: any;",
			}),
		);
		const finding = results.find((r) => r.name === "type_density_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
		// Single regressed dimension → message names `: any` and its delta.
		expect(finding?.message).toContain("`: any` (0→2)");
		// Only the regressions LIST (before the first period / static advice)
		// reflects which dimensions fired; the trailing advice line mentions
		// every shape regardless. Assert on the list segment, not the whole
		// message.
		const regressionList = (finding?.message ?? "").split(". ")[0];
		expect(regressionList).toContain("`: any`");
		expect(regressionList).not.toContain("unknown");
		expect(regressionList).not.toContain("Function");
		expect(regressionList).not.toContain("untyped exported params");
	});

	it("lists EVERY regressed dimension in one finding, joined by commas", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({
					typeDensity: {
						anyAnnotations: 0,
						unknownAnnotations: 0,
						functionType: 0,
						emptyObjectType: 0,
						untypedExportedParams: 0,
						missingExportedReturnType: 0,
					},
				}),
				postContent: [
					"let a: any;",
					"let u: unknown;",
					"let f: Function;",
					"let o: {};",
					// untyped exported param + missing exported return type
					"export function noTypes(arg) { return arg; }",
				].join("\n"),
			}),
		);
		const finding = results.find((r) => r.name === "type_density_ratchet");
		expect(finding).toBeDefined();
		const msg = finding?.message ?? "";
		expect(msg).toContain("`: any` (0→1)");
		expect(msg).toContain("`: unknown` (0→1)");
		expect(msg).toContain("`: Function` (0→1)");
		expect(msg).toContain("`: {}` (0→1)");
		expect(msg).toContain("untyped exported params (0→1)");
		expect(msg).toContain("missing exported return type (0→1)");
		// All six dimensions are comma-joined into one line.
		expect(msg.split(",").length).toBeGreaterThanOrEqual(6);
	});

	it("does NOT fire when no type-density dimension regresses (all equal)", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({
					typeDensity: {
						anyAnnotations: 1,
						unknownAnnotations: 0,
						functionType: 0,
						emptyObjectType: 0,
						untypedExportedParams: 0,
						missingExportedReturnType: 0,
					},
				}),
				// exactly one `: any` — matches the baseline, no regression
				postContent: "let a: any;",
			}),
		);
		expect(names(results)).not.toContain("type_density_ratchet");
	});

	it("does NOT fire when a dimension DECREASES (regressions array stays empty)", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({
					typeDensity: {
						anyAnnotations: 5,
						unknownAnnotations: 0,
						functionType: 0,
						emptyObjectType: 0,
						untypedExportedParams: 0,
						missingExportedReturnType: 0,
					},
				}),
				postContent: "let a: any;",
			}),
		);
		expect(names(results)).not.toContain("type_density_ratchet");
	});

	it("does NOT fire when typeDensity is absent on the baseline (optional guard)", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: requiredOnlyBaseline(),
				postContent: "let a: any;\nlet b: unknown;",
			}),
		);
		expect(names(results)).not.toContain("type_density_ratchet");
	});
});

// ===========================================
// Discovered-primitive ratchet — needs a seeded repo so refreshIfStale
// resolves a primitive without rescanning. Mirrors the seeding pattern in
// discovered-primitives.test.ts (wrapper declared + called above threshold).
// ===========================================

describe("runRatchetComparison — discovered_primitive_ratchet", () => {
	let tmp: string;

	function write(rel: string, content: string): void {
		const full = join(tmp, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}

	function seedSafeParseIntPrimitive(): void {
		write(
			"src/lib/safe.ts",
			`export function safeParseInt(s: string): number {\n\treturn parseInt(s, 10);\n}\n`,
		);
		const calls = Array.from(
			{ length: PRIMITIVE_CALL_SITE_THRESHOLD + 1 },
			(_, i) => `safeParseInt("${i}");`,
		).join("\n");
		write("src/uses.ts", calls);
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-ratchet-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("fires when bare unsafe-builtin calls increase past the baseline", () => {
		seedSafeParseIntPrimitive();
		const results = runRatchetComparison(
			makeCtx({
				cwd: tmp,
				baseline: zeroBaseline({ discoveredPrimitiveViolations: { safeParseInt: 0 } }),
				// two bare parseInt calls → 2 > 0
				postContent: 'const a = parseInt("1", 10);\nconst b = parseInt("2", 10);',
			}),
		);
		const finding = results.find((r) => r.name === "discovered_primitive_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
		expect(finding?.message).toContain("safeParseInt");
		expect(finding?.message).toContain("0 → 2");
		expect(finding?.file).toBe("/repo/src/touched.ts");
	});

	it("uses 0 as the implied baseline when a wrapper is missing from the pre-map (?? 0 path)", () => {
		seedSafeParseIntPrimitive();
		const results = runRatchetComparison(
			makeCtx({
				cwd: tmp,
				// baseline declares the feature on (non-empty record) but omits
				// safeParseInt → preCount resolves via `?? 0`.
				baseline: zeroBaseline({ discoveredPrimitiveViolations: { someOtherWrapper: 9 } }),
				postContent: 'const a = parseInt("1", 10);',
			}),
		);
		const finding = results.find((r) => r.name === "discovered_primitive_ratchet");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("0 → 1");
	});

	it("does NOT fire when bare-call count holds steady against the baseline", () => {
		seedSafeParseIntPrimitive();
		const results = runRatchetComparison(
			makeCtx({
				cwd: tmp,
				baseline: zeroBaseline({ discoveredPrimitiveViolations: { safeParseInt: 1 } }),
				postContent: 'const a = parseInt("1", 10);',
			}),
		);
		expect(names(results)).not.toContain("discovered_primitive_ratchet");
	});

	it("skips the primitive ratchet entirely when no primitives are discovered (postViolations null)", () => {
		// No seeding → capturePrimitiveViolations returns undefined → the
		// `if (postViolations)` guard is false and nothing is pushed.
		const results = runRatchetComparison(
			makeCtx({
				cwd: tmp,
				baseline: zeroBaseline({ discoveredPrimitiveViolations: { safeParseInt: 0 } }),
				postContent: 'const a = parseInt("1", 10);',
			}),
		);
		expect(names(results)).not.toContain("discovered_primitive_ratchet");
	});

	it("skips the primitive ratchet when the baseline has no discoveredPrimitiveViolations key", () => {
		seedSafeParseIntPrimitive();
		const results = runRatchetComparison(
			makeCtx({
				cwd: tmp,
				baseline: zeroBaseline(), // discoveredPrimitiveViolations omitted
				postContent: 'const a = parseInt("1", 10);',
			}),
		);
		expect(names(results)).not.toContain("discovered_primitive_ratchet");
	});
});

// ===========================================
// Defensive catch — non-fatal swallow path
// ===========================================

describe("runRatchetComparison — defensive error swallow", () => {
	it("returns [] (does not throw) when a baseline counter access throws", () => {
		// A baseline whose `suppressionCount` getter throws simulates the
		// "file mutated between edits" failure the catch block guards against.
		// The function must swallow it and return whatever was collected so far
		// (nothing, since the throw happens on the first comparison).
		const throwingBaseline = new Proxy(zeroBaseline(), {
			get(target, prop, receiver) {
				if (prop === "suppressionCount") {
					throw new Error("simulated mid-edit file mutation");
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		let results: ReturnType<typeof runRatchetComparison> | undefined;
		expect(() => {
			results = runRatchetComparison(
				makeCtx({ baseline: throwingBaseline, postContent: "// @ts-ignore" }),
			);
		}).not.toThrow();
		expect(results).toEqual([]);
	});

	it("returns findings gathered before a later-stage throw", () => {
		// suppressionCount reads fine and regresses (one finding pushed), then
		// asAnyCastCount throws → catch fires → already-collected findings
		// survive in the returned array.
		let suppressionReads = 0;
		const partialThrowBaseline = new Proxy(zeroBaseline({ suppressionCount: 0 }), {
			get(target, prop, receiver) {
				if (prop === "asAnyCastCount") {
					throw new Error("simulated mutation after first comparison");
				}
				if (prop === "suppressionCount") suppressionReads++;
				return Reflect.get(target, prop, receiver);
			},
		});

		const results = runRatchetComparison(
			makeCtx({
				baseline: partialThrowBaseline,
				// one suppression directive → regresses 0 → 1 BEFORE the as-any read
				postContent: "// @ts-ignore\nconst a = x as any;",
			}),
		);
		expect(suppressionReads).toBeGreaterThan(0);
		expect(names(results)).toEqual(["suppression_ratchet"]);
	});
});

describe("runRatchetComparison — seam_ratchet (plan 25 lane 2)", () => {
	// test-contract: behavior — adding an ambient clock read must warn with the
	// grown dimension and the injection fix
	it("P1: fires when the edit adds a clock read", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ ambientSeams: { clock: 0, random: 0, env: 0 } }),
				postContent: "const t = Date.now();\n",
			}),
		);
		expect(names(results)).toEqual(["seam_ratchet"]);
		expect(results[0]?.message).toContain("clock 0→1");
		expect(results[0]?.message).toContain("Inject the dependency");
	});

	it("N1: holding or removing seams stays silent", () => {
		const results = runRatchetComparison(
			makeCtx({
				baseline: zeroBaseline({ ambientSeams: { clock: 2, random: 1, env: 0 } }),
				postContent: "const t = Date.now();\n",
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary — a baseline captured before the field existed
	// must fail open, never fire
	it("N2: fails open when the baseline lacks ambientSeams", () => {
		const results = runRatchetComparison(
			makeCtx({ postContent: "const t = Date.now();\nconst r = Math.random();\n" }),
		);
		expect(names(results)).toEqual([]);
	});
});

describe("runRatchetComparison — assertion_strength_ratchet (introduced assertions)", () => {
	// test-contract: behavior — pure weakening (weak added, no offsetting exact
	// in the same added lines) fires
	it("P1: fires when the edit adds a weak matcher with no offsetting exact matcher", () => {
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 0 },
					assertionStrengthPreContent: "",
				}),
				postContent: "expect(x).toContain(1);\n",
			}),
		);
		expect(names(results)).toEqual(["assertion_strength_ratchet"]);
		expect(results[0]?.message).toContain("0 → 1");
		expect(results[0]?.message).toContain("exact-value");
		expect(results[0]?.severity).toBe("warning");
		expect(results[0]?.message).toContain("[heuristic]");
	});

	it.each([
		{
			name: "a multiline matcher replacement",
			pre: "expect(\n result\n).toEqual(\n [1]\n);",
			post: "expect(\n result\n).toContain(\n 1\n);",
			before: { weak: 0, exact: 1 },
			expected: ["assertion_strength_ratchet"],
		},
		{
			name: "an unchanged exact call on the edited line",
			pre: "expect(x).toBe(1);",
			post: "expect(x).toBe(1); expect(y).toBeTruthy();",
			before: { weak: 0, exact: 1 },
			expected: ["assertion_strength_ratchet"],
		},
		{
			name: "new text inside an existing block comment",
			pre: "/*\nexample\n*/",
			post: "/*\nexample\nexpect(x).toBeTruthy();\n*/",
			before: { weak: 0, exact: 0 },
			expected: [],
		},
		{
			name: "legitimate exact absence and call-count checks",
			pre: "",
			post: "expect(result).toBeUndefined(); expect(fn).toHaveBeenCalledTimes(2); expect(other).not.toHaveBeenCalled();",
			before: { weak: 0, exact: 0 },
			expected: [],
		},
		{
			name: "a negated equality that does not offset a broad assertion",
			pre: "",
			post: "expect(x).toBeTruthy(); expect(y).not.toBe(1);",
			before: { weak: 0, exact: 0 },
			expected: ["assertion_strength_ratchet"],
		},
	])("handles $name", ({ pre, post, before, expected }) => {
		const results = runRatchetComparison(makeCtx({
			absPath: "/repo/src/touched.test.ts",
			baseline: zeroBaseline({ assertionStrength: before, assertionStrengthPreContent: pre }),
			postContent: post,
		}));
		expect(names(results)).toEqual(expected);
	});

	it("uses JSX syntax for a JavaScript test path", () => {
		const results = runRatchetComparison(makeCtx({
			absPath: "/repo/src/touched.test.jsx",
			baseline: zeroBaseline({ assertionStrength: { weak: 0, exact: 0 }, assertionStrengthPreContent: "" }),
			postContent: "const view = <Panel />; expect(view).toBeTruthy();",
		}));
		expect(names(results)).toEqual(["assertion_strength_ratchet"]);
	});

	// test-contract: boundary — the path predicate also matches __tests__/ and .spec.tsx
	it("P2: fires under a __tests__/ directory and a .spec.tsx filename", () => {
		const dirResults = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/__tests__/touched.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 0 },
					assertionStrengthPreContent: "",
				}),
				postContent: "expect(x).toMatch(/a/);\n",
			}),
		);
		expect(names(dirResults)).toEqual(["assertion_strength_ratchet"]);

		const specResults = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.spec.tsx",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 0 },
					assertionStrengthPreContent: "",
				}),
				postContent: "expect(x).toBeTruthy();\n",
			}),
		);
		expect(names(specResults)).toEqual(["assertion_strength_ratchet"]);
	});

	// test-contract: behavior (harness-debt row 25 fix) — a PRE-EXISTING exact
	// matcher elsewhere in the file, unchanged by this edit, must not offset
	// a newly-added weak matcher
	it("P3: fires even though the file already has an unrelated pre-existing exact matcher", () => {
		const pre = "expect(a).toBe(1);\n";
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 1 },
					assertionStrengthPreContent: pre,
				}),
				postContent: `${pre}expect(x).toContain(1);\n`,
			}),
		);
		expect(names(results)).toEqual(["assertion_strength_ratchet"]);
		expect(results[0]?.message).toContain("exact 1 → 1");
	});

	// test-contract: behavior — a newly-recognized weak form (harness-debt row
	// 25) flows end-to-end through the added-lines scoped ratchet
	it("P4: fires for a newly-added toBeFalsy() with no offsetting exact matcher", () => {
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 0 },
					assertionStrengthPreContent: "",
				}),
				postContent: "expect(x).toBeFalsy();\n",
			}),
		);
		expect(names(results)).toEqual(["assertion_strength_ratchet"]);
	});

	// test-contract: boundary — an offsetting exact matcher in the SAME added
	// lines means it's not PURE weakening
	it("N1: adding an exact matcher alongside the weak one in the same edit stays silent", () => {
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 0 },
					assertionStrengthPreContent: "",
				}),
				postContent: "expect(x).toContain(1);\nexpect(y).toBe(2);\n",
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary — a deleted weak matcher (present in pre, absent
	// from post, nothing new added) stays silent
	it("N2: holding or removing weak matchers stays silent", () => {
		const pre = "expect(x).toContain(1);\nexpect(y).toContain(2);\n";
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 2, exact: 0 },
					assertionStrengthPreContent: pre,
				}),
				postContent: "expect(x).toContain(1);\n",
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary — non-test files are out of scope regardless of content
	it("N3: a non-test file stays silent even though weak grew", () => {
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 0, exact: 0 },
					assertionStrengthPreContent: "",
				}),
				postContent: "expect(x).toContain(1);\n",
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary — a baseline captured before the counters
	// existed must fail open, never fire
	it("N4: fails open when the baseline lacks assertionStrength", () => {
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				postContent: "expect(x).toContain(1);\n",
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary (harness-debt row 25) — a baseline that HAS
	// assertionStrength counts but predates the raw-content field must also
	// fail open, since the added-lines scope has nothing to diff against
	it("N5: fails open when the baseline lacks assertionStrengthPreContent", () => {
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({ assertionStrength: { weak: 0, exact: 0 } }),
				postContent: "expect(x).toContain(1);\n",
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary (harness-debt row 25 fix) — a pure move (the
	// same lines reordered, nothing textually new) must not fire
	it("N6: a pure move of existing lines stays silent", () => {
		const pre = "expect(a).toBe(1);\nexpect(x).toContain(1);\n";
		const post = "expect(x).toContain(1);\nexpect(a).toBe(1);\n";
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 1, exact: 1 },
					assertionStrengthPreContent: pre,
				}),
				postContent: post,
			}),
		);
		expect(names(results)).toEqual([]);
	});

	// test-contract: boundary — an unchanged file (identical pre/post) stays silent
	it("N7: an unchanged file stays silent", () => {
		const content = "expect(x).toContain(1);\n";
		const results = runRatchetComparison(
			makeCtx({
				absPath: "/repo/src/touched.test.ts",
				baseline: zeroBaseline({
					assertionStrength: { weak: 1, exact: 0 },
					assertionStrengthPreContent: content,
				}),
				postContent: content,
			}),
		);
		expect(names(results)).toEqual([]);
	});
});
