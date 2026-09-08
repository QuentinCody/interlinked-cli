// Tests for the `publint` dynamic-import path inside
// `checkPackageJsonPublishInvariantsWithPublint` / `runPublint`. Isolated into
// its own file (rather than `package-json.test.ts`) because `vi.mock` is
// hoisted file-wide — mocking the `publint` module here would otherwise
// change the "publint unavailable" degrade-gracefully assertions in the
// companion file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkPackageJsonPublishInvariantsWithPublint } from "./package-json.js";

const FULL_PKG = {
	name: "my-pkg",
	version: "1.0.0",
	license: "MIT",
};

let tmp = "";
let pkgPath = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pjpi-publint-mock-"));
	writeFileSync(join(tmp, "package-lock.json"), "{}");
	pkgPath = join(tmp, "package.json");
	writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	vi.doUnmock("publint");
	vi.resetModules();
});

describe("checkPackageJsonPublishInvariantsWithPublint — publint installed", () => {
	it("retains real publint errors beside malformed optional-dependency output", async () => {
		vi.doMock("publint", () => ({
			publint: vi.fn(async () => ({ messages: [null, { type: "error", code: 42 }, { type: "error", code: "VALID_ERROR" }] })),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.text).toContain("VALID_ERROR");
	});

	it("appends one finding per publint error message", async () => {
		vi.doMock("publint", () => ({
			publint: vi.fn(async () => ({
				messages: [
					{ code: "IMPLICIT_INDEX_JS", type: "error", args: ["./index.js"] },
					{ code: "USE_EXPORTS", type: "warning", args: [] },
				],
			})),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("IMPLICIT_INDEX_JS");
	});

	it("returns base findings only when publint reports zero errors", async () => {
		vi.doMock("publint", () => ({
			publint: vi.fn(async () => ({ messages: [] })),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toEqual([]);
	});

	it("returns base findings when the dynamic import itself rejects", async () => {
		vi.doMock("publint", () => {
			throw new Error("simulated import failure");
		});
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(findings).toEqual([]);
	});
});

// NOTE: the "mod is not an object" and "candidate is not a function" guards
// inside `runPublint` are covered in their own dedicated single-mock files
// (`package-json-publint-not-object.test.ts`, `package-json-publint-no-fn.test.ts`)
// — a per-test `vi.doMock` against the same bare "publint" specifier inside
// one file was empirically unreliable for a plain dynamic `import(variable)`
// (branch hits didn't match the per-test mock shape), while one hoisted
// `vi.mock` per file resolved deterministically.

describe("checkPackageJsonPublishInvariantsWithPublint", () => {
	it("does not fall into the publint branch at all when the base finding is a parse error", async () => {
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			'{ "name": "x", ',
			pkgPath,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("not valid JSON");
	});

	it("skips publint when the post-edit content itself is private", async () => {
		// Pre-edit is NOT private (so we get past the pre-check), but post-edit
		// flips to private — the check must still short-circuit before publint.
		const postEdit = { ...FULL_PKG, private: true };
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(postEdit),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});
});

// Mutation-kill supplement: argument-precision and short-circuit-precision
// cases the tests above don't isolate. Same per-test `vi.doMock` pattern as
// above (see the top-of-file NOTE for why one hoisted `vi.mock` per file
// doesn't work here).
describe("checkPackageJsonPublishInvariantsWithPublint — mutation-kill", () => {
	// test-contract: public-api — runPublint must call publint with the real
	// pkgDir (L147: `{ pkgDir }` -> `{}`). A blind mock that ignores its
	// arguments can't tell `{pkgDir}` from `{}`; this one captures them.
	it("invokes publint with the correct pkgDir argument", async () => {
		let capturedArgs: unknown;
		vi.doMock("publint", () => ({
			publint: vi.fn(async (opts: unknown) => {
				capturedArgs = opts;
				return { messages: [] };
			}),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		await fn(JSON.stringify(FULL_PKG), pkgPath);
		expect(capturedArgs).toEqual({ pkgDir: dirname(pkgPath) });
	});

	// test-contract: public-api — a publint message with no `args` must
	// format as `[]`, not the literal word "undefined" (L151: `m.args ?? []`
	// -> `m.args && []`; `??` and `&&` only disagree when the left side is
	// falsy, which `undefined` is).
	it("formats a publint message with no `args` as an empty array, not the word 'undefined'", async () => {
		vi.doMock("publint", () => ({
			publint: vi.fn(async () => ({
				messages: [{ code: "NO_ARGS_CODE", type: "error" }],
			})),
		}));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify(FULL_PKG), pkgPath);
		const publintFinding = nonNull(findings.find((f) => f.text.includes("NO_ARGS_CODE")));
		expect(publintFinding.text).toContain("NO_ARGS_CODE] []");
	});

	// test-contract: invariant — the parse-error short-circuit (L262) must
	// actually skip publint, not just happen to produce the same finding
	// count. Kills the whole-condition -> `false` mutant.
	it("never invokes publint when the base result is already the single parse-error finding", async () => {
		const publintFn = vi.fn(async () => ({
			messages: [{ code: "SHOULD_NOT_RUN", type: "error", args: [] }],
		}));
		vi.doMock("publint", () => ({ publint: publintFn }));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn('{ "name": "my-pkg", ', pkgPath);
		expect(findings).toHaveLength(1);
		expect(publintFn).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the parse-error short-circuit (L262) must
	// require the actual "not valid JSON" text, not just any single base
	// finding. Kills the StringLiteral "not valid JSON" -> "" mutant (an
	// empty needle makes `.includes("")` trivially true for any finding).
	it("does not short-circuit on a single non-parse-error base finding", async () => {
		const minimalPre = { name: "my-pkg", version: "1.0.0", license: "MIT" };
		writeFileSync(pkgPath, JSON.stringify(minimalPre));
		const publintFn = vi.fn(async () => ({
			messages: [{ code: "EXTRA_CHECK", type: "error", args: [] }],
		}));
		vi.doMock("publint", () => ({ publint: publintFn }));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const postEdit = { name: "my-pkg", version: "1.0.0" }; // license removed — 1 finding, not a parse error
		const findings = await fn(JSON.stringify(postEdit), pkgPath);
		expect(findings).toHaveLength(2);
		expect(findings.some((f) => f.text.includes("`license`"))).toBe(true);
		expect(findings.some((f) => f.text.includes("EXTRA_CHECK"))).toBe(true);
	});

	// test-contract: invariant — the PRE-edit-private short-circuit (L266)
	// must fire on its own, even when post-edit un-privates the package.
	// Kills the ConditionalExpression->`false` and BooleanLiteral true->false
	// mutants (both make the guard fail to fire here).
	it("skips publint when PRE-edit was private, even if post-edit un-privates it", async () => {
		const privatePre = { name: "my-pkg", version: "1.0.0", private: true };
		writeFileSync(pkgPath, JSON.stringify(privatePre));
		const publintFn = vi.fn(async () => ({
			messages: [{ code: "SHOULD_NOT_RUN", type: "error", args: [] }],
		}));
		vi.doMock("publint", () => ({ publint: publintFn }));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const postEdit = { name: "my-pkg", version: "1.0.0" };
		const findings = await fn(JSON.stringify(postEdit), pkgPath);
		expect(findings).toEqual([]);
		expect(publintFn).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the pristine code must not throw on a
	// genuinely null `pre` (first-time package.json creation). Kills removing
	// the `?.` on `pre?.private` (L266): `null.private` is a TypeError, unlike
	// `post`, which is always parseable by the time this line runs (base
	// already proved that).
	it("does not throw when pre-edit package.json doesn't exist yet", async () => {
		const freshDir = join(tmp, "fresh");
		mkdirSync(freshDir);
		writeFileSync(join(freshDir, "package-lock.json"), "{}");
		const freshPkgPath = join(freshDir, "package.json"); // never written
		vi.doMock("publint", () => ({ publint: vi.fn(async () => ({ messages: [] })) }));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const findings = await fn(JSON.stringify({ name: "brand-new", version: "0.0.0" }), freshPkgPath);
		expect(findings).toEqual([]);
	});

	// test-contract: invariant — the POST-edit-private short-circuit (L268)
	// must fire on its own, even though pre-edit wasn't private. Kills the
	// ConditionalExpression->`false` and BooleanLiteral true->false mutants.
	it("skips publint when POST-edit sets private:true, even though pre-edit wasn't private", async () => {
		const nonPrivatePre = { name: "my-pkg", version: "1.0.0" };
		writeFileSync(pkgPath, JSON.stringify(nonPrivatePre));
		const publintFn = vi.fn(async () => ({
			messages: [{ code: "SHOULD_NOT_RUN", type: "error", args: [] }],
		}));
		vi.doMock("publint", () => ({ publint: publintFn }));
		const { checkPackageJsonPublishInvariantsWithPublint: fn } = await import("./package-json.js");
		const postEdit = { name: "my-pkg", version: "1.0.0", private: true };
		const findings = await fn(JSON.stringify(postEdit), pkgPath);
		expect(findings).toEqual([]);
		expect(publintFn).not.toHaveBeenCalled();
	});
});
