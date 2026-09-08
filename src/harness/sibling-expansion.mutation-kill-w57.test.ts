import { nonNull } from "../lib/non-null.js";
import { describe, expect, it } from "vitest";
import { decomposePattern } from "./regex-trigrams.js";
import {
	DEFAULT_TRIGGERS,
	expandEndpointDetectorSiblings,
	expandSiblings,
	resetSiblingDedupForTests,
	type FileReader,
	type TrigramIndexLike,
} from "./sibling-expansion.js";
import type { DetectorFinding } from "./checks/endpoint-security.js";

function makeIndex(paths: string[]): TrigramIndexLike {
	return {
		queryCandidatePaths: () => paths,
	};
}

function makeReader(map: Record<string, string | undefined>): FileReader {
	return {
		read: (p: string) => map[p],
	};
}

describe("DEFAULT_TRIGGERS message templates — positive (must fire)", () => {
	it("as_any_ratchet messageTemplate interpolates file/line/snippet", () => {
		const trig = DEFAULT_TRIGGERS.find((t) => t.triggerName === "as_any_ratchet");
		expect(trig).toBeDefined();
		const msg = trig?.messageTemplate("foo.ts", 3, "snip");
		expect(msg).toContain("foo.ts:3");
		expect(msg).toContain("snip");
	});

	it("unvalidated_json_boundary messageTemplate returns the full templated string (kills empty-string + stub-arrow mutants)", () => {
		const trig = DEFAULT_TRIGGERS.find((t) => t.triggerName === "unvalidated_json_boundary");
		expect(trig).toBeDefined();
		const msg = trig?.messageTemplate("bar.ts", 7, "snip2");
		expect(msg).toBeTruthy();
		expect(msg).toContain("Sibling JSON.parse at bar.ts:7");
		expect(msg).toContain("schema validator");
		expect(msg).toContain("snip2");
	});

	it("unvalidated_json_boundary siblingRuleId is the exact non-empty id", () => {
		const trig = DEFAULT_TRIGGERS.find((t) => t.triggerName === "unvalidated_json_boundary");
		expect(trig?.siblingRuleId).toBe("unvalidated_json_sibling");
	});

	it("as_any pattern requires one-or-more whitespace (kills \\s+ -> \\s mutant)", () => {
		const trig = DEFAULT_TRIGGERS.find((t) => t.triggerName === "as_any_ratchet");
		const pattern = nonNull(trig?.pattern);
		pattern.lastIndex = 0;
		expect(pattern.test("let z = x as  any;")).toBe(true);
	});

	it("JSON.parse pattern requires whitespace-only gap before paren (kills \\s* -> \\S* mutant)", () => {
		const trig = DEFAULT_TRIGGERS.find((t) => t.triggerName === "unvalidated_json_boundary");
		const pattern = nonNull(trig?.pattern);
		pattern.lastIndex = 0;
		expect(pattern.test("JSON.parse (x)")).toBe(true);
		pattern.lastIndex = 0;
		expect(pattern.test("JSON.parseXYZ(x)")).toBe(false);
	});
});

describe("expandSiblings — exempt script paths (positive/negative)", () => {
	it("excludes a candidate under scripts/ with no leading slash (kills ^ removal + SCRIPT_PATH_RE.test->false)", () => {
		resetSiblingDedupForTests();
		const index = makeIndex(["scripts/probe.ts"]);
		const reader = makeReader({ "scripts/probe.ts": "let z = x as any;" });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out).toEqual([]);
	});

	it("emits for a non-exempt sibling path so the exclusion above is meaningful", () => {
		resetSiblingDedupForTests();
		const index = makeIndex(["src/other.ts"]);
		const reader = makeReader({ "src/other.ts": "let z = x as any;" });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out.length).toBe(1);
		expect(out[0]?.file).toBe("src/other.ts");
	});

	it("normalizes backslashes before matching SCRIPT_PATH_RE (kills the backslash-replacement string mutant)", () => {
		resetSiblingDedupForTests();
		const index = makeIndex(["scripts\\probe.ts"]);
		const reader = makeReader({ "scripts\\probe.ts": "let z = x as any;" });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out).toEqual([]);
	});
});

describe("resetSiblingDedupForTests — positive", () => {
	it("clears the module-level dedup memory so an unchanged sibling re-emits", () => {
		resetSiblingDedupForTests();
		const index = makeIndex(["src/dup.ts"]);
		const reader = makeReader({ "src/dup.ts": "let z = x as any;" });
		const args = {
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader,
			cwd: "/repo",
		};
		const first = expandSiblings(args);
		expect(first.length).toBe(1);
		const second = expandSiblings(args);
		expect(second.length).toBe(0);
		resetSiblingDedupForTests();
		const third = expandSiblings(args);
		expect(third.length).toBe(1);
	});
});

describe("expandSiblings — maxCandidates default cap", () => {
	it("caps candidate inspection at the default of 30 when maxCandidates is not passed (kills ?? -> && and slice-removal mutants)", () => {
		resetSiblingDedupForTests();
		const paths: string[] = [];
		const contentMap: Record<string, string> = {};
		for (let i = 0; i < 34; i++) {
			const p = `src/noise${i}.ts`;
			paths.push(p);
			contentMap[p] = "no match here";
		}
		// The only matching candidate sits at index 34 — past the default cap of 30.
		const matchPath = "src/noise34.ts";
		paths.push(matchPath);
		contentMap[matchPath] = "let z = x as any;";

		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index: makeIndex(paths),
			reader: makeReader(contentMap),
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out).toEqual([]);
	});
});

describe("expandSiblings — origin-file truthiness and toRelative (positive/negative)", () => {
	it("does not add an empty trigger.file to originFiles (kills t.file -> true mutant)", () => {
		resetSiblingDedupForTests();
		const index = makeIndex([""]);
		const reader = makeReader({ "": "let z = x as any;" });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out.length).toBe(1);
		expect(out[0]?.file).toBe("");
	});

	it("toRelative leaves a path unchanged when it does not start with cwd/ (kills startsWith->true and template-literal mutants)", () => {
		resetSiblingDedupForTests();
		const originPath = "/other/absolute/path.ts";
		const index = makeIndex([originPath]);
		const reader = makeReader({ [originPath]: "let z = x as any;" });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: originPath }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		// The origin file must be excluded from its own sibling list — this
		// only happens if toRelative left the path unmangled so the exclusion
		// set matches the candidate path exactly.
		expect(out).toEqual([]);
	});

	it("toRelative strips the cwd/ prefix when it IS present", () => {
		resetSiblingDedupForTests();
		const index = makeIndex(["/repo/src/other.ts"]);
		const reader = makeReader({ "/repo/src/other.ts": "let z = x as any;" });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "/repo/src/origin.ts" }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out.length).toBe(1);
	});
});

describe("expandSiblings — decomposePattern isRegex flag + empty-trigram continue", () => {
	it("passes isRegex=false for the anchor literal (kills BooleanLiteral false->true mutant)", () => {
		resetSiblingDedupForTests();
		const expected = decomposePattern("as any", false).requiredTrigrams;
		let captured: number[] | undefined;
		const index: TrigramIndexLike = {
			queryCandidatePaths: (trigrams) => {
				captured = trigrams;
				return [];
			},
		};
		expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader: makeReader({}),
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(captured).toEqual(expected);
	});

	it("skips a trigger whose anchor decomposes to zero required trigrams (kills length===0 -> false mutant)", () => {
		resetSiblingDedupForTests();
		let called = false;
		const index: TrigramIndexLike = {
			queryCandidatePaths: () => {
				called = true;
				return [];
			},
		};
		const out = expandSiblings({
			triggers: [{ name: "tiny_anchor", file: "" }],
			triggerSpecs: [
				{
					triggerName: "tiny_anchor",
					anchor: "a", // < 3 chars => decomposePattern returns requiredTrigrams: []
					pattern: /a/g,
					siblingRuleId: "tiny_sibling",
					messageTemplate: (f, l) => `tiny ${f}:${l}`,
				},
			],
			index,
			reader: makeReader({}),
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(called).toBe(false);
		expect(out).toEqual([]);
	});
});

describe("expandSiblings — tryBuildSibling content-undefined guard", () => {
	it("skips (does not throw) when reader.read returns undefined for a candidate (kills content===undefined -> false mutant)", () => {
		resetSiblingDedupForTests();
		const index = makeIndex(["src/missing.ts"]);
		const reader = makeReader({ "src/missing.ts": undefined });
		let out: unknown[] = [];
		expect(() => {
			out = expandSiblings({
				triggers: [{ name: "as_any_ratchet", file: "" }],
				index,
				reader,
				cwd: "/repo",
				emittedKeys: new Set(),
			});
		}).not.toThrow();
		expect(out).toEqual([]);
	});
});

describe("findFirstMatch — trim + line number + snippet truncation (via expandSiblings)", () => {
	function firstSibling(content: string) {
		resetSiblingDedupForTests();
		const index = makeIndex(["src/one.ts"]);
		const reader = makeReader({ "src/one.ts": content });
		const out = expandSiblings({
			triggers: [{ name: "as_any_ratchet", file: "" }],
			index,
			reader,
			cwd: "/repo",
			emittedKeys: new Set(),
		});
		expect(out.length).toBe(1);
		return out[0];
	}

	it("trims the matched line before embedding it in the snippet (kills .trim() removal mutant)", () => {
		const sib = firstSibling("   let z = x as any; // trailing");
		expect(sib?.message).toContain("let z = x as any; // trailing");
		expect(sib?.message).not.toContain("   let z");
	});

	it("reports a 1-indexed line number (kills i+1 -> i-1 mutant)", () => {
		const sib = firstSibling("no match here\nlet z = x as any;");
		expect(sib?.line).toBe(2);
	});

	it("does not truncate a snippet exactly at the 120-char boundary (kills > -> >= mutant)", () => {
		const trimmed = `let z = x as any; ${"x".repeat(120 - "let z = x as any; ".length)}`;
		expect(trimmed.length).toBe(120);
		const sib = firstSibling(trimmed);
		expect(sib?.message).toContain(trimmed);
		expect(sib?.message).not.toContain("…");
	});

	it("truncates a snippet longer than 120 chars, appending an ellipsis (kills > -> false and > -> <= mutants)", () => {
		const long = `let z = x as any; ${"y".repeat(150 - "let z = x as any; ".length)}`;
		expect(long.length).toBe(150);
		const sib = firstSibling(long);
		expect(sib?.message).toContain(`${long.slice(0, 120)}…`);
		expect(sib?.message).not.toContain(long);
	});

	it("does not truncate a short snippet under 120 chars (kills > -> true mutant)", () => {
		const short = "let z = x as any;";
		expect(short.length).toBeLessThan(120);
		const sib = firstSibling(short);
		expect(sib?.message).toContain(short);
		expect(sib?.message).not.toContain("…");
	});
});

describe("expandEndpointDetectorSiblings — seen-line dedup (positive)", () => {
	function finding(overrides: Partial<DetectorFinding>): DetectorFinding {
		return {
			check_id: "endpoint_x",
			file: "src/routes.ts",
			line: 1,
			message: "lead finding",
			...overrides,
		};
	}

	it("deduplicates repeated sibling lines from the rescan (kills seen.has -> false mutant)", () => {
		const findings: DetectorFinding[] = [finding({ line: 1 })];
		const rescanned: DetectorFinding[] = [
			finding({ line: 5, message: "sib" }),
			finding({ line: 5, message: "sib-dup" }),
		];
		const out = expandEndpointDetectorSiblings(findings, {
			rescan: () => rescanned,
			readFile: () => "irrelevant file content",
		});
		expect(out[0]?.message).toContain("Same shape on 1 sibling endpoint in routes.ts: 5");
		expect(out[0]?.message).not.toContain("2 sibling");
	});
});
