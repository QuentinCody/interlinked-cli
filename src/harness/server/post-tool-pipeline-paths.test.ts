import { makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { resolveEditedPaths } from "./post-tool-pipeline-paths.js";

/**
 * Generated build artifacts must never enter the quality pipeline. The bash
 * path extractor matched ANY source-looking path in a command, so `rg -c ...
 * dist/index.js` fed a 25,000-line bundle to the full inline-check family —
 * clone detection and AST parses over 300KB of generated code. Ledgered
 * 2026-07-28 as +922MB…+1078MB heap spikes in single 30s ticks, ending in
 * row-less daemon deaths (OOM): the direct mechanism behind "the harness keeps
 * going down".
 */
function bash(command: string): HarnessEvent {
	return { ...makeEventFixture({ tool_name: undefined, tool_input: undefined }), tool_name: "Bash", tool_input: { command } };
}

function edit(file_path: string): HarnessEvent {
	return { ...makeEventFixture({ tool_name: undefined, tool_input: undefined }), tool_name: "Edit", tool_input: { file_path } };
}

describe("resolveEditedPaths — positive (must still resolve)", () => {
	it("P1: a source file edited via bash resolves for checking", () => {
		const r = resolveEditedPaths(bash("sed -i '' 's/a/b/' src/lib/config.ts"));
		expect(r.editedFilePath).toBe("src/lib/config.ts");
	});

	it("P2: a direct Edit to a source file resolves", () => {
		const r = resolveEditedPaths(edit("src/harness/server.ts"));
		expect(r.editedFilePaths).toContain("src/harness/server.ts");
	});

	it("P3: observed effects override a shell command's declared or parseable paths", () => {
		const event = bash("node opaque-generator.js src/decoy.ts");
		event.change_set = {
			source: "filesystem-observation",
			complete: true,
			before_captured_at: "2026-08-13T00:00:00.000Z",
			after_captured_at: "2026-08-13T00:00:01.000Z",
			files: [
				{ path: "src/actual.ts", kind: "modified", before_sha256: "a", after_sha256: "b" },
			],
		};
		expect(resolveEditedPaths(event).editedFilePaths).toEqual(["src/actual.ts"]);
	});
});

describe("resolveEditedPaths — negative (generated output must not be analyzed)", () => {
	it("N0: read-only shell inspections never enter the post-edit check pipeline", () => {
		for (const cmd of [
			"sed -n '1,240p' src/harness/mutation/cloud-runner.ts",
			"rg -n 'MutationGateOutcome' src/harness/mutation/gate.ts",
			"rg -i 'a|b' src/app.ts | sed -n '1,200p'",
		]) {
			expect(resolveEditedPaths(bash(cmd))).toMatchObject({
				editedFilePath: "",
				editedFilePaths: [],
				shouldRunChecks: false,
			});
		}
	});

	it("P0: a real in-place shell edit still enters the post-edit check pipeline", () => {
		expect(resolveEditedPaths(bash("sed -i '' 's/a/b/' src/app.ts"))).toMatchObject({
			editedFilePath: "src/app.ts",
			editedFilePaths: ["src/app.ts"],
			shouldRunChecks: true,
		});
	});

	it("N1: a dist bundle mentioned in a bash command is NOT picked up", () => {
		const r = resolveEditedPaths(bash('rg -c "USER_PROMPT" dist/hook-entry.js'));
		expect(r.editedFilePath).toBe("");
	});

	it("N2: nested build output is skipped wherever it sits", () => {
		for (const cmd of [
			"tail -3 cloud/.wrangler/tmp/dev-x/worker.js",
			"wc -l node_modules/@stryker-mutator/core/dist/src/stryker.js",
			"cat coverage/lcov-report/index.js",
		]) {
			expect(resolveEditedPaths(bash(cmd)).editedFilePath).toBe("");
		}
	});

	it("N3: comparing a bundle with source is still read-only", () => {
		const r = resolveEditedPaths(bash("diff dist/index.js src/index.ts"));
		expect(r).toMatchObject({ editedFilePath: "", editedFilePaths: [], shouldRunChecks: false });
	});

	it("P1: a command that reads a bundle and then edits source resolves the real write", () => {
		const r = resolveEditedPaths(
			bash("rg -c USER_PROMPT dist/index.js && sed -i '' 's/a/b/' src/index.ts"),
		);
		expect(r.editedFilePath).toBe("src/index.ts");
	});

	it("N4: a direct edit to generated output resolves no paths to analyze", () => {
		// shouldRunChecks stays true for direct edits (the pipeline's marker
		// bookkeeping is cheap and other tests pin it); what matters for the OOM
		// class is that the PATH LIST is empty — nothing to fan the analyzers over.
		const r = resolveEditedPaths(edit("dist/harness/server.js"));
		expect(r.editedFilePaths).toEqual([]);
		expect(r.editedFilePath).toBe("");
	});

	it("N5: minified artifacts are skipped by suffix even outside known dirs", () => {
		expect(resolveEditedPaths(bash("head vendor/lib.min.js")).editedFilePath).toBe("");
	});
});

/**
 * Attribution: the ChangeSet is a diff of the window the call occupied, not a
 * record of what the call did. A tool with no write capability cannot have
 * produced any path in it — another agent on the same tree, a background test
 * run or a watcher did. Charging those paths to the reader dragged the whole
 * per-file pipeline (including `affected_tests`, which shells out to vitest)
 * onto a call that changed nothing: a read-only `rg` measured at ~21s,
 * reporting a test failure it did not cause.
 */
function readOnly(tool_name: string, paths: string[]): HarnessEvent {
	return { ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
		tool_name,
		tool_input: { pattern: "USER_PROMPT" },
		change_set: {
			source: "filesystem-observation",
			complete: true,
			before_captured_at: "2026-08-27T00:00:00.000Z",
			after_captured_at: "2026-08-27T00:00:01.000Z",
			files: paths.map((path) => ({
				path,
				kind: "modified",
				before_sha256: "a",
				after_sha256: "b",
			})),
		},
	};
}

describe("resolveEditedPaths — read-only calls must not be charged with observed paths", () => {
	it("N1: Grep contributes no observed paths and runs no checks", () => {
		const r = resolveEditedPaths(readOnly("Grep", ["src/somebody-elses-edit.ts"]));
		expect(r.editedFilePaths).toEqual([]);
		expect(r.editedFilePath).toBe("");
		expect(r.shouldRunChecks).toBe(false);
	});

	it("N2: every canonical read-only tool is treated the same way", () => {
		for (const tool of ["Read", "Glob", "WebFetch", "WebSearch", "NotebookRead", "ListFiles"]) {
			const r = resolveEditedPaths(readOnly(tool, ["src/concurrent.ts"]));
			expect(r.editedFilePaths).toEqual([]);
			expect(r.shouldRunChecks).toBe(false);
		}
	});

	it("N3: the normalized lowercase_snake spelling other runners deliver also drops them", () => {
		const r = resolveEditedPaths(readOnly("web_fetch", ["src/concurrent.ts"]));
		expect(r.editedFilePaths).toEqual([]);
	});

	it("N4: a collaboration wait never inherits the agent's concurrent edit", () => {
		const r = resolveEditedPaths(
			readOnly("collaborationwait_agent", ["src/harness/server/agent-owned-edit.ts"]),
		);
		expect(r.editedFilePaths).toEqual([]);
		expect(r.shouldRunChecks).toBe(false);
	});

	it("P1: Bash KEEPS its ChangeSet — it is the bash-edit obligation channel", () => {
		const r = resolveEditedPaths(readOnly("Bash", ["src/really-edited.ts"]));
		expect(r.editedFilePaths).toEqual(["src/really-edited.ts"]);
		expect(r.shouldRunChecks).toBe(true);
	});

	it("P2: an UNKNOWN tool keeps its ChangeSet (a new writer cannot open the bypass)", () => {
		const r = resolveEditedPaths(readOnly("mcp__filesystem__write_file", ["src/mcp-edit.ts"]));
		expect(r.editedFilePaths).toEqual(["src/mcp-edit.ts"]);
		expect(r.shouldRunChecks).toBe(true);
	});

	it("P3: a write tool keeps its ChangeSet", () => {
		const r = resolveEditedPaths(readOnly("Write", ["src/written.ts"]));
		expect(r.editedFilePaths).toEqual(["src/written.ts"]);
		expect(r.shouldRunChecks).toBe(true);
	});
});

/**
 * Every gated write channel Claude Code registers a PostToolUse hook for must
 * also be a DIRECT file edit here.
 *
 * `MultiEdit` was registered by the adapter but absent from the pipeline's
 * direct-edit list, so it fell through twice:
 *   1. with no ChangeSet the call resolved to ZERO paths and
 *      `shouldRunChecks: false` — the whole per-file quality pass was skipped
 *      for a real multi-site edit; and
 *   2. with a ChangeSet the paths came back but `isDirectFileEdit` stayed
 *      false, so `appendBashEditObligationWarnings` charged a pre-write-GATED
 *      edit with a bash-channel obligation — which then blocks writes to other
 *      files until it is discharged.
 * Both lists now derive from `lib/write-tool-registry.ts`, so they cannot drift.
 */
function directEdit(tool_name: string, file_path: string): HarnessEvent {
	return { ...makeEventFixture({ tool_name: undefined, tool_input: undefined }),
		tool_name,
		tool_input: { file_path, edits: [{ old_string: "a", new_string: "b" }] },
	};
}

describe("resolveEditedPaths — direct-edit channel coverage", () => {
	it("P1: MultiEdit is a direct file edit and resolves its declared path", () => {
		const r = resolveEditedPaths(directEdit("MultiEdit", "src/foo.ts"));
		expect(r.isDirectFileEdit).toBe(true);
		expect(r.editedFilePaths).toEqual(["src/foo.ts"]);
		expect(r.editedFilePath).toBe("src/foo.ts");
		expect(r.shouldRunChecks).toBe(true);
	});

	it("P2: MultiEdit with an observed ChangeSet is still a DIRECT edit", () => {
		// The obligation gate keys on `isDirectFileEdit`, not on the path list —
		// paths alone resolved even before the fix, so this is the assertion that
		// separates "checks ran" from "the bash obligation gate stayed out of it".
		const r = resolveEditedPaths(readOnly("MultiEdit", ["src/observed.ts"]));
		expect(r.isDirectFileEdit).toBe(true);
		expect(r.editedFilePaths).toEqual(["src/observed.ts"]);
	});

	it("P3: the other Claude-native direct write tools behave identically", () => {
		for (const tool of ["Write", "Edit", "NotebookEdit"]) {
			const r = resolveEditedPaths(directEdit(tool, "src/foo.ts"));
			expect(r.isDirectFileEdit).toBe(true);
			expect(r.editedFilePaths).toEqual(["src/foo.ts"]);
		}
	});

	it("N1: Bash is NOT a direct edit — it is the shell/obligation channel", () => {
		const r = resolveEditedPaths(bash("sed -i '' 's/a/b/' src/lib/config.ts"));
		expect(r.isDirectFileEdit).toBe(false);
		expect(r.editedFilePaths).toEqual(["src/lib/config.ts"]);
	});

	it("N2: a read-only tool is not promoted to a direct edit", () => {
		for (const tool of ["Read", "Grep", "Glob"]) {
			expect(resolveEditedPaths(directEdit(tool, "src/foo.ts")).isDirectFileEdit).toBe(false);
		}
	});
});
