import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	evaluateTypeErasureOverlay,
	STRICT_TYPING_RULE_ID,
} from "./type-erasure-overlay.js";

describe("evaluateTypeErasureOverlay", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("exposes a stable rule id for block messages", () => {
		expect(STRICT_TYPING_RULE_ID).toBe("strict-typing-overlay");
	});

	it("returns applicable=false for non-TS extensions", () => {
		const result = evaluateTypeErasureOverlay("/tmp/foo.js", "const x = a as any;");
		expect(result.applicable).toBe(false);
		expect(result.newFindings).toEqual([]);
	});

	it("treats every finding as new on a new-file Write (no preContent)", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/new.ts",
			"const x = foo as any;\nconst y = bar as unknown as Y;\n",
			{ preContent: undefined },
		);
		expect(result.applicable).toBe(true);
		const ids = result.newFindings.map((f) => f.ruleId).sort();
		expect(ids).toContain("as_any");
		expect(ids).toContain("as_unknown_chain");
	});

	it("subtracts pre-existing matches via line-text multiset", () => {
		const pre = "const a = foo as any;\nconst b = 1;\n";
		const post = "const a = foo as any;\nconst b = 1;\nconst c = baz as any;\n";
		const result = evaluateTypeErasureOverlay("/tmp/edit.ts", post, { preContent: pre });
		expect(result.newFindings).toHaveLength(1);
		expect(nonNull(result.newFindings[0]).ruleId).toBe("as_any");
		expect(nonNull(result.newFindings[0]).line).toBe(3);
	});

	it("does not flag matches that exist in both pre and post unchanged", () => {
		const both = "const a = foo as any;\nconst b = bar as unknown as B;\n";
		const result = evaluateTypeErasureOverlay("/tmp/touch.ts", both, { preContent: both });
		expect(result.newFindings).toEqual([]);
	});

	it("flags @ts-ignore without justification", () => {
		const post = "// @ts-ignore\nconst x = unsafe();\n";
		const result = evaluateTypeErasureOverlay("/tmp/ignore.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "unjustified_ts_directive")).toBe(true);
	});

	it("allows @ts-ignore when an inline justification follows", () => {
		const post = "// @ts-ignore: third-party types are wrong here\nconst x = unsafe();\n";
		const result = evaluateTypeErasureOverlay("/tmp/ignore-ok.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "unjustified_ts_directive")).toBe(false);
	});

	it("ignores `: any` annotations in test files", () => {
		const post = "const mock: any = {};\n";
		const result = evaluateTypeErasureOverlay("/tmp/foo.test.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "bare_any_annotation")).toBe(false);
	});

	it("flags `: any` annotations in production files", () => {
		const post = "function handle(x: any) { return x; }\n";
		const result = evaluateTypeErasureOverlay("/tmp/prod.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "bare_any_annotation")).toBe(true);
	});

	it("ignores patterns inside string literals (offset-preserving strip)", () => {
		const post = 'const help = "use `as any` only when forced";\n';
		const result = evaluateTypeErasureOverlay("/tmp/str.ts", post, { preContent: "" });
		expect(result.newFindings).toEqual([]);
	});

	it("treats every finding as new when the on-disk path can't be read (no options passed)", () => {
		// No third argument at all (distinct from the explicit `{ preContent:
		// undefined }` case above): resolvePreContent falls through to the
		// existsSync+readFileSync branch. A directory exists but can't be
		// read as a file, so readFileSync throws and the catch resolves to
		// undefined — same observable as "no preContent" on a new file.
		const dir = mkdtempSync(join(tmpdir(), "type-erasure-"));
		dirs.push(dir);
		const dirLikePath = join(dir, "weird.ts");
		mkdirSync(dirLikePath);
		const result = evaluateTypeErasureOverlay(dirLikePath, "const x = foo as any;\n");
		expect(result.applicable).toBe(true);
		expect(result.newFindings.map((f) => f.ruleId)).toEqual(["as_any"]);
	});
});
