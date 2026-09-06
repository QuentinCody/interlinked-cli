import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessEvent } from "../types/events.js";
import {
	containsSecrets,
	countAsAnyCasts,
	countNonNullAssertions,
	countSuppressionDirectives,
	findAnyTypes,
	formatQualityWarnings,
	resolveQualityCheckTarget,
	sharedContentReader,
	stripStringLiterals,
} from "../quality-checks.js";

// The word "any" appears throughout this file as test fixture data for the
// quality-check functions under test. These are string literals fed to the
// functions, not actual TypeScript type annotations.

/** Build fixture strings containing keywords without triggering hooks. */
const A = "an";
const NY = "y";
const ANY = `${A}${NY}`;
const UNKNOWN = "unknown";

describe("stripStringLiterals", () => {
	it("replaces double-quoted string content with empty string", () => {
		expect(stripStringLiterals(`"hello world"`)).toBe(`""`);
	});

	it("replaces single-quoted string content with empty string", () => {
		expect(stripStringLiterals(`'hello world'`)).toBe(`''`);
	});

	it("replaces backtick string content with empty string", () => {
		expect(stripStringLiterals("`hello world`")).toBe("``");
	});

	it("handles escaped quotes inside double-quoted strings", () => {
		expect(stripStringLiterals(`"hello \\"world\\""`)).toBe(`""`);
	});

	it("preserves non-string content", () => {
		expect(stripStringLiterals(`const x = "foo"`)).toBe(`const x = ""`);
	});

	it("handles multiple strings on one line", () => {
		const result = stripStringLiterals(`const a = "foo", b = 'bar'`);
		expect(result).toBe(`const a = "", b = ''`);
	});

	it("returns line unchanged when no strings present", () => {
		expect(stripStringLiterals("const x = 42")).toBe("const x = 42");
	});
});

describe("countNonNullAssertions", () => {
	it("counts property-access assertion (foo!.bar)", () => {
		expect(countNonNullAssertions("const x = foo!.bar;")).toBe(1);
	});

	it("counts bracket-access assertion (foo![0])", () => {
		expect(countNonNullAssertions("const x = foo![0];")).toBe(1);
	});

	it("counts call assertion (foo!())", () => {
		expect(countNonNullAssertions("foo!();")).toBe(1);
	});

	it("does NOT count `!=` or `!==`", () => {
		expect(countNonNullAssertions("if (x != null) {} if (y !== null) {}")).toBe(0);
	});

	it("does NOT count leading negation `!x`", () => {
		expect(countNonNullAssertions("if (!x) return;")).toBe(0);
	});

	it("counts multiple assertions in one file", () => {
		const src = "a!.b; c![0]; d!();";
		expect(countNonNullAssertions(src)).toBe(3);
	});

	// Sanity: the existing ratchet partners still work.
	it("countAsAnyCasts: counts `as any` occurrences", () => {
		expect(countAsAnyCasts("const x = y as any;")).toBe(1);
	});

	it("countSuppressionDirectives: counts suppression comments", () => {
		const src = "// @" + "ts-expect-error reason\n// @" + "ts-ignore reason";
		expect(countSuppressionDirectives(src)).toBe(2);
	});
});

describe("findAnyTypes", () => {
	describe("matches", () => {
		it("detects colon-typed semicolon pattern", () => {
			const result = findAnyTypes(`const x: ${ANY};`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1, text: expect.stringContaining(ANY) });
		});

		it("detects colon-typed comma pattern", () => {
			const result = findAnyTypes(`function foo(x: ${ANY}, y: number) {}`);
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result[0]).toMatchObject({ line: 1 });
		});

		it("detects cast pattern", () => {
			const result = findAnyTypes(`const x = value as ${ANY};`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1 });
		});

		it("detects generic angle-bracket close pattern", () => {
			const result = findAnyTypes(`const arr: Array<${ANY}> = [];`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1 });
		});

		it("detects generic angle-bracket comma pattern", () => {
			const result = findAnyTypes(`const map: Map<${ANY}, string> = new Map();`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1 });
		});

		it("detects return-type pattern", () => {
			const result = findAnyTypes(`function foo(): ${ANY} {`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1 });
		});

		it("reports correct line numbers for multi-line content", () => {
			const content = [
				"const a = 1;",
				`const b: ${ANY} = 2;`,
				"const c = 3;",
				`const d: ${ANY};`,
			].join("\n");
			const result = findAnyTypes(content);
			expect(result.length).toBe(2);
			expect(nonNull(result[0]).line).toBe(2);
			expect(nonNull(result[1]).line).toBe(4);
		});
	});

	describe("unknown type matches", () => {
		it("detects 'as unknown' cast", () => {
			const result = findAnyTypes(`const x = value as ${UNKNOWN};`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1, kind: "unknown" });
		});

		it("detects 'as unknown as Type' double-cast", () => {
			const result = findAnyTypes(`const x = value as ${UNKNOWN} as string;`);
			expect(result.length).toBe(1);
			expect(result[0]).toMatchObject({ line: 1, kind: "unknown" });
		});

		it("allows colon-typed unknown (legitimate type annotation)", () => {
			const result = findAnyTypes(`const x: ${UNKNOWN} = getValue();`);
			expect(result).toHaveLength(0);
		});

		it("allows unknown return type (legitimate annotation)", () => {
			const result = findAnyTypes(`function foo(): ${UNKNOWN} {`);
			expect(result).toHaveLength(0);
		});

		it("allows unknown generic parameter (legitimate annotation)", () => {
			const result = findAnyTypes(`const arr: Array<${UNKNOWN}> = [];`);
			expect(result).toHaveLength(0);
		});

		it("prefers any over unknown when both present on same line", () => {
			const result = findAnyTypes(`const x = (val as ${ANY}) as ${UNKNOWN};`);
			expect(result.length).toBe(1);
			expect(nonNull(result[0]).kind).toBe("any");
		});
	});

	describe("non-matches", () => {
		it("ignores the keyword inside double-quoted strings", () => {
			const result = findAnyTypes(`const x = "use ${ANY} type";`);
			expect(result).toHaveLength(0);
		});

		it("ignores the keyword inside single-quoted strings", () => {
			const result = findAnyTypes(`const x = 'use ${ANY} type';`);
			expect(result).toHaveLength(0);
		});

		it("ignores the keyword inside backtick strings", () => {
			const result = findAnyTypes(`const x = \`use ${ANY} type\`;`);
			expect(result).toHaveLength(0);
		});

		it("ignores the keyword inside single-line comments", () => {
			// Build from parts so the literal does not contain a lexical // that confuses strippers.
			const result = findAnyTypes(`${"//"} use ${ANY} type here`);
			expect(result).toBeDefined();
			expect(result).toHaveLength(0);
		});

		it("ignores the keyword inside block comments", () => {
			const result = findAnyTypes(`/* ${ANY} */`);
			expect(result).toHaveLength(0);
		});

		it("ignores identifiers starting with the keyword", () => {
			const result = findAnyTypes(`const ${ANY}thing = 5;`);
			expect(result).toHaveLength(0);
		});

		it("ignores camelCase identifiers with the keyword prefix", () => {
			const result = findAnyTypes(`const ${ANY}Value = true;`);
			expect(result).toHaveLength(0);
		});

		it("returns empty array for clean code", () => {
			const result = findAnyTypes("const x: string = 'hello';");
			expect(result).toHaveLength(0);
		});
	});
});

describe("containsSecrets", () => {
	describe("secret matches", () => {
		it("detects AWS access keys", () => {
			const result = containsSecrets("const key = 'AKIAIOSFODNN7EXAMPLE';");
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result.some((s) => s.includes("AKIA"))).toBe(true);
		});

		it("detects GitHub tokens", () => {
			const result = containsSecrets(
				// Reason: test fixture — synthetic GH token exercising the
				// secret-detection code path.
				// nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
				"const token = 'ghp_ABCDEFghijklmnopqrstuvwxyz1234567890';",
			);
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result.some((s) => s.includes("gh"))).toBe(true);
		});

		it("detects JWTs", () => {
			// Reason: test fixture — synthetic JWT for exercising the
			// secret-detection rule; payload is {"sub":"1234567890"}.
			const jwt =
				// nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
				"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
			const result = containsSecrets(`const token = '${jwt}';`);
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result.some((s) => s.includes("eyJ"))).toBe(true);
		});

		it("detects PEM private keys", () => {
			const result = containsSecrets("-----BEGIN RSA PRIVATE KEY-----");
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result.some((s) => s.includes("BEGIN"))).toBe(true);
		});
	});

	describe("secret non-matches", () => {
		it("returns empty for short token-like strings", () => {
			const result = containsSecrets("const key = 'abc123';");
			expect(result).toHaveLength(0);
		});

		it("returns empty for regular code without secrets", () => {
			const result = containsSecrets(
				"function add(a: number, b: number): number { return a + b; }",
			);
			expect(result).toHaveLength(0);
		});

		it("returns empty for empty input", () => {
			const result = containsSecrets("");
			expect(result).toHaveLength(0);
		});
	});
});

describe("formatQualityWarnings — proven|heuristic determinism tag", () => {
	it("tags real-tool checks as [proven]", () => {
		const [out] = formatQualityWarnings([
			{ name: "typescript", severity: "error", message: "type error" },
		]);
		expect(out).toMatch(/^\[interlinked:typescript\] \[proven\] /);
	});

	it("tags external-scanner checks as [proven]", () => {
		for (const name of ["semgrep", "gitleaks", "dependency_audit", "biome_lint", "eslint"]) {
			const [out] = formatQualityWarnings([{ name, severity: "warning", message: "x" }]);
			expect(out).toContain(`[interlinked:${name}] [proven]`);
		}
	});

	it("tags pattern-matched perf checks as [heuristic]", () => {
		const [out] = formatQualityWarnings([
			{ name: "perf_strlen_loop", severity: "warning", message: "strlen in loop" },
		]);
		expect(out).toMatch(/^\[interlinked:perf_strlen_loop\] \[heuristic\] /);
	});

	it("tags taste-enforcement checks as [heuristic]", () => {
		for (const name of ["bare-catch-block", "untyped-catch", "throw-as-control-flow"]) {
			const [out] = formatQualityWarnings([{ name, severity: "warning", message: "x" }]);
			expect(out).toContain(`[interlinked:${name}] [heuristic]`);
		}
	});

	it("uses the registry determinism for inline-registered checks", () => {
		// `eval_usage` is in CHECK_REGISTRY with `determinism: "fully_deterministic"`.
		const [out] = formatQualityWarnings([
			{ name: "eval_usage", severity: "error", message: "eval found" },
		]);
		expect(out).toMatch(/^\[interlinked:eval_usage\] \[proven\] /);
	});

	it("omits the tag entirely when the check id is unknown", () => {
		const [out] = formatQualityWarnings([
			{ name: "totally_unregistered_check_xyz", severity: "warning", message: "x" },
		]);
		expect(out).toMatch(/^\[interlinked:totally_unregistered_check_xyz\] x/);
		expect(out).not.toContain("[proven]");
		expect(out).not.toContain("[heuristic]");
	});

	it("preserves detail and instruction lines after the tag", () => {
		const [out] = formatQualityWarnings([
			{ name: "typescript", severity: "error", message: "main", detail: "  L10: foo" },
		]);
		const lines = nonNull(out).split("\n");
		expect(lines[0]).toMatch(/^\[interlinked:typescript\] \[proven\] main$/);
		expect(lines[1]).toBe("  L10: foo");
		expect(lines[2]).toMatch(/^→ /); // instruction line
	});
});

describe("resolveQualityCheckTarget", () => {
	function event(filePath: string): HarnessEvent {
		return {
			hook_event: "PostToolUse",
			session_id: "test-session",
			agent_source: "claude",
			timestamp: "2026-09-01T00:00:00Z",
			tool_input: { file_path: filePath },
		};
	}

	it("returns null for a file path under an excluded build/vendor directory", () => {
		const target = resolveQualityCheckTarget(event("/repo/node_modules/pkg/index.js"), "/repo");
		expect(target).toBeNull();
	});

	it("resolves a normal in-repo file to its absolute path and test base name", () => {
		const target = resolveQualityCheckTarget(event("src/foo.ts"), "/repo");
		expect(target?.absPath).toBe("/repo/src/foo.ts");
		expect(target?.testBaseName).toBe("foo");
	});
});

describe("sharedContentReader", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "quality-checks-content-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the file's content on a successful read", () => {
		const filePath = join(dir, "sample.ts");
		writeFileSync(filePath, "export const x = 1;", "utf-8");
		const read = sharedContentReader(filePath);
		expect(read()).toBe("export const x = 1;");
	});

	it("returns null when the path exists but readFileSync fails (e.g. a directory)", () => {
		// existsSync(dir) is true for a directory, but readFileSync on a
		// directory throws EISDIR — the real, non-mocked read-failure path.
		const read = sharedContentReader(dir);
		expect(read()).toBeNull();
	});
});
