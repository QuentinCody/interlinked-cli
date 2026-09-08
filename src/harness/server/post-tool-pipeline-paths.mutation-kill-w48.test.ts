import { makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
import type { JsonObject } from "../../lib/json-types.js";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { isGeneratedArtifactPath, resolveEditedPaths } from "./post-tool-pipeline-paths.js";

function ev(tool_name: string | undefined, tool_input?: JsonObject): HarnessEvent {
	return { ...makeEventFixture({ tool_name: undefined, tool_input: undefined }), tool_name, tool_input };
}

function evWithFiles(
	tool_name: string | undefined,
	files: { path: string }[],
): HarnessEvent {
	// SAFETY: only tool_name/tool_input/change_set are read by resolveEditedPaths.
	return { ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
		tool_name,
		tool_input: {},
		change_set: {
			source: "filesystem-observation",
			complete: true,
			before_captured_at: "2026-08-13T00:00:00.000Z",
			after_captured_at: "2026-08-13T00:00:01.000Z",
			files: files.map((f) => ({ ...f, kind: "modified", before_sha256: "a", after_sha256: "b" })),
		},
	};
}

// mutantId c3c106171b498058: "/" -> "" in norm.split("/")
describe("isGeneratedArtifactPath — path-separator split", () => {
	// test-contract: public-api — isGeneratedArtifactPath's exported segment-match
	// contract depends on splitting on "/"; any other split breaks segment matching.
	it("kills c3c106171b498058: a nested generated dir segment is recognized via '/' split", () => {
		expect(isGeneratedArtifactPath("src/dist/foo.ts")).toBe(true);
	});
});

// mutantId f993502f735a305f: /\.min\.[cm]?js$/ -> /\.min\.[cm]?js/ (drops end anchor)
describe("isGeneratedArtifactPath — minified suffix requires end anchor", () => {
	// test-contract: public-api — the doc comment on isGeneratedArtifactPath
	// specifies matching the .min.js SUFFIX, requiring an end anchor.
	it("kills f993502f735a305f: a path with extra trailing chars after .min.js is NOT minified", () => {
		expect(isGeneratedArtifactPath("foo.min.jsx")).toBe(false);
	});
});

// mutantId 1e9cb5262a547c2c: [cm]? -> [^cm]? (inverts the optional-char class)
describe("isGeneratedArtifactPath — optional c/m char class", () => {
	// test-contract: public-api — the regex intentionally allows an optional
	// "c" or "m" before "js" so both .min.cjs and .min.mjs count as minified.
	it("kills 1e9cb5262a547c2c: .min.cjs IS recognized as minified", () => {
		expect(isGeneratedArtifactPath("foo.min.cjs")).toBe(true);
	});
	// test-contract: public-api — same [cm]? contract, the .mjs variant.
	it("kills 1e9cb5262a547c2c (mjs variant too)", () => {
		expect(isGeneratedArtifactPath("foo.min.mjs")).toBe(true);
	});
});

// mutantId 000f026b6cfc79b8: `!event.tool_name || !SHELL_TOOLS.includes(event.tool_name)` -> `false`
// mutantId 6e5a5a81a7c96bd2: same expr, `||` -> `&&`
describe("resolveEditedPaths — bash scanning only applies to shell tools", () => {
	// test-contract: public-api — resolveDeclaredPaths's bash-scan branch is
	// gated on SHELL_TOOLS membership; a non-shell tool must never be scanned.
	it("kills 000f026b6cfc79b8 and 6e5a5a81a7c96bd2: a non-shell tool's command text is never scanned", () => {
		const r = resolveEditedPaths(ev("SomeOtherTool", { command: "touch src/foo.ts" }));
		expect(r.editedFilePaths).toEqual([]);
		expect(r.editedFilePath).toBe("");
	});
});

// mutantId a26068a50fe42cb6: `typeof event.tool_input?.command === "string"` -> `true`
describe("resolveEditedPaths — non-string command is treated as empty, not passed through", () => {
	// test-contract: boundary — the typeof guard exists specifically so a
	// non-string tool_input.command can never reach cmd.matchAll and throw.
	it("kills a26068a50fe42cb6: Bash tool_input with no command does not throw and resolves nothing", () => {
		expect(() => resolveEditedPaths(ev("Bash", {}))).not.toThrow();
		const r = resolveEditedPaths(ev("Bash", {}));
		expect(r.editedFilePaths).toEqual([]);
	});
});

// mutantId 620c80e6e2f4a5fd: `event.tool_input?.command` -> `event.tool_input.command` (drops optional chaining)
describe("resolveEditedPaths — missing tool_input must not throw", () => {
	// test-contract: boundary — optional chaining on event.tool_input?.command
	// exists specifically so an absent tool_input never throws a TypeError.
	it("kills 620c80e6e2f4a5fd: Bash tool with no tool_input at all does not throw", () => {
		expect(() => resolveEditedPaths(ev("Bash", undefined))).not.toThrow();
		const r = resolveEditedPaths(ev("Bash", undefined));
		expect(r.editedFilePaths).toEqual([]);
	});
});

// mutantId 607105643e6202ba: observedPaths drops the isGeneratedArtifactPath filter
describe("resolveEditedPaths — observed change_set paths are filtered for generated output", () => {
	// test-contract: invariant — observedPaths must apply isGeneratedArtifactPath
	// to change_set effects the same way declared paths are filtered.
	it("kills 607105643e6202ba: a dist/ effect is excluded, a real source effect is kept", () => {
		const r = resolveEditedPaths(
			evWithFiles(undefined, [{ path: "dist/bundle.js" }, { path: "src/foo.ts" }]),
		);
		expect(r.editedFilePaths).toEqual(["src/foo.ts"]);
	});
});

// mutantId a699daf74f1d5e98: `isDirectFileEdit || editedFilePaths.length > 0` -> `true`
// mutantId 6510736972ddb6fb: `editedFilePaths.length > 0` -> `>= 0`
describe("resolveEditedPaths — shouldRunChecks is false when nothing was found", () => {
	// test-contract: public-api — shouldRunChecks on the exported
	// EditedPathResolution is documented as gating whether checks run at all.
	it("kills a699daf74f1d5e98 and 6510736972ddb6fb: no direct edit, no shell match, no effects => shouldRunChecks false", () => {
		const r = resolveEditedPaths(ev("SomeOtherTool", {}));
		expect(r.isDirectFileEdit).toBe(false);
		expect(r.editedFilePaths).toEqual([]);
		expect(r.shouldRunChecks).toBe(false);
	});
});

// mutantId 653b68d76d92047f: `isDirectFileEdit || editedFilePaths.length > 0` -> `false`
describe("resolveEditedPaths — shouldRunChecks is true for a resolved direct edit", () => {
	// test-contract: public-api — a direct-edit tool with a resolvable path
	// must always run checks per the exported EditedPathResolution contract.
	it("kills 653b68d76d92047f: a direct Write with a resolvable path runs checks", () => {
		const r = resolveEditedPaths(ev("Write", { file_path: "src/foo.ts" }));
		expect(r.isDirectFileEdit).toBe(true);
		expect(r.shouldRunChecks).toBe(true);
	});
});

// mutantId 4303a0fc9ef5f8da: `isDirectFileEdit || editedFilePaths.length > 0` -> `&&`
describe("resolveEditedPaths — direct edit alone is enough even with no resolvable path", () => {
	// test-contract: invariant — isDirectFileEdit OR editedFilePaths.length is a
	// disjunction: either condition alone must be sufficient for shouldRunChecks.
	it("kills 4303a0fc9ef5f8da: a direct-edit tool with an unresolvable path still runs checks", () => {
		const r = resolveEditedPaths(ev("Write", {}));
		expect(r.isDirectFileEdit).toBe(true);
		expect(r.editedFilePaths).toEqual([]);
		expect(r.shouldRunChecks).toBe(true);
	});
});

// mutantId cf5e399f4c7f5b0d: `editedFilePaths.length > 0` -> `false`
// mutantId bab647820ceb3e32: `editedFilePaths.length > 0` -> `<= 0`
describe("resolveEditedPaths — observed effects alone are enough to run checks", () => {
	// test-contract: invariant — editedFilePaths.length > 0 must itself be a
	// true positive condition, independent of the isDirectFileEdit disjunct.
	it("kills cf5e399f4c7f5b0d and bab647820ceb3e32: non-direct tool with a real observed effect runs checks", () => {
		const r = resolveEditedPaths(evWithFiles(undefined, [{ path: "src/foo.ts" }]));
		expect(r.isDirectFileEdit).toBe(false);
		expect(r.editedFilePaths).toEqual(["src/foo.ts"]);
		expect(r.shouldRunChecks).toBe(true);
	});
});
