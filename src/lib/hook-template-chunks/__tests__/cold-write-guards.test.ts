// Corpus + codegen test for the shared cold-fallback WRITE guards
// (`src/lib/hook-template-chunks/cold-write-guards.ts`).
//
// Two consumers run this exact code: `src/hook-entry-cold-gates.ts` imports the
// functions directly, and `guards-inline.ts` embeds `COLD_WRITE_GUARDS_SOURCE`
// into the zero-import generated `.mjs`. So this file pins BOTH the behavior
// and the `Function.prototype.toString()` round-trip invariant — the same
// pattern `__tests__/destructive-command-guard.test.ts` uses.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkGraphShardWrite,
	checkMergeConflictWrite,
	COLD_WRITE_GUARDS_SOURCE,
	type ColdWriteDeps,
	type ColdWriteVerdict,
} from "../cold-write-guards.js";

const DEPS: ColdWriteDeps = { existsSync, statSync, join };

type MergeFn = (toolName: string, toolInput: Record<string, unknown>) => ColdWriteVerdict | null;
type ShardFn = (
	toolName: string,
	toolInput: Record<string, unknown>,
	cwd: string,
	deps: ColdWriteDeps,
) => ColdWriteVerdict | null;

/** Rebuild the guards from their serialized source exactly the way
 *  `guards-inline.ts` splices them into the .mjs: a bare run of function
 *  declarations, then the entry point returned by name. */
function rebuild(name: "checkGraphShardWrite"): ShardFn;
function rebuild(name: "checkMergeConflictWrite"): MergeFn;
function rebuild(name: "checkGraphShardWrite" | "checkMergeConflictWrite"): ShardFn | MergeFn {
	// SAFETY: the two overloads name the exact imported guard declarations serialized into COLD_WRITE_GUARDS_SOURCE; parity tests exercise both signatures below.
	return new Function(`"use strict"; ${COLD_WRITE_GUARDS_SOURCE}; return ${name};`)() as ShardFn | MergeFn;
}

const CONFLICT = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch";

describe("checkMergeConflictWrite — positive (must fire)", () => {
	it("P1: blocks Write content carrying conflict markers", () => {
		const v = checkMergeConflictWrite("Write", { content: CONFLICT, file_path: "/repo/a.ts" });
		expect(v?.decision).toBe("block");
		expect(v?.reason).toContain("[interlinked:merge-conflict]");
		expect(v?.reason).toContain("/repo/a.ts");
	});

	it("P2: blocks Edit new_string carrying conflict markers", () => {
		expect(checkMergeConflictWrite("edit", { new_string: CONFLICT })?.decision).toBe("block");
	});

	it("P3: blocks NotebookEdit new_source carrying conflict markers", () => {
		expect(checkMergeConflictWrite("notebook_edit", { new_source: CONFLICT })?.decision).toBe("block");
	});

	it("P4: blocks MultiEdit when any edits[].new_string carries markers", () => {
		const v = checkMergeConflictWrite("multi_edit", {
			edits: [{ new_string: "clean" }, { new_string: CONFLICT }],
		});
		expect(v?.decision).toBe("block");
	});

	it("P5: falls back to 'the target file' when no path is extractable", () => {
		expect(checkMergeConflictWrite("Write", { content: CONFLICT })?.reason).toContain(
			"the target file",
		);
	});
});

describe("checkMergeConflictWrite — negative (must not fire)", () => {
	it("N1: allows clean content", () => {
		expect(checkMergeConflictWrite("Write", { content: "export const x = 1;\n" })).toBeNull();
	});

	it("N2: allows a non-write tool even when its input carries markers", () => {
		expect(checkMergeConflictWrite("read", { content: CONFLICT })).toBeNull();
	});

	it("N3: allows an empty / missing tool_input", () => {
		expect(checkMergeConflictWrite("Write", {})).toBeNull();
	});

	it("N4: ignores non-string entries inside edits[]", () => {
		expect(
			checkMergeConflictWrite("multi_edit", { edits: [null, 42, { new_string: 7 }] }),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// checkGraphShardWrite
// ---------------------------------------------------------------------------

let dir: string;
let savedOverride: string | undefined;

/** Fixed wall clock: the gate compares shard mtime against source mtime with a
 *  60s grace, so freshness needs stable timestamps, not Date.now(). */
const FIXED_NOW = Date.parse("2026-05-10T12:00:00Z");

function setMtime(p: string, ms: number): void {
	utimesSync(p, ms / 1000, ms / 1000);
}

/** Write a source file plus its colocated shard, both at `shardAgeMs` skew. */
function makeShardedFile(name: string, shardName: string, shardMtime = FIXED_NOW): string {
	mkdirSync(join(dir, "src"), { recursive: true });
	const source = join(dir, "src", name);
	const shard = join(dir, "src", shardName);
	writeFileSync(source, "export {}");
	writeFileSync(shard, "// @generated supermodel-sidecar");
	setMtime(source, FIXED_NOW);
	setMtime(shard, shardMtime);
	return source;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cold-write-guards-"));
	savedOverride = process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
	delete process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedOverride === undefined) delete process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
	else process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = savedOverride;
});

describe("checkGraphShardWrite — positive (must fire)", () => {
	it("P1: blocks Edit on a file with a fresh colocated .graph.<ext> shard", () => {
		const source = makeShardedFile("foo.ts", "foo.graph.ts");
		const v = checkGraphShardWrite("Edit", { file_path: source }, dir, DEPS);
		expect(v?.decision).toBe("block");
		expect(v?.rule_id).toBe("graph-prediction-inline-fail-closed");
		expect(v?.reason).toContain("[interlinked:graph-pred][harness-offline]");
		expect(v?.reason).toContain(source);
	});

	it("P2: blocks the bare `.graph` (extension-less) shard form", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "Makefile");
		writeFileSync(source, "all:");
		writeFileSync(`${source}.graph`, "// @generated");
		setMtime(source, FIXED_NOW);
		setMtime(`${source}.graph`, FIXED_NOW);
		expect(checkGraphShardWrite("Write", { file_path: source }, dir, DEPS)?.decision).toBe("block");
	});

	it("P3: blocks apply_patch whose body targets a shard'd file", () => {
		const source = makeShardedFile("handler.ts", "handler.graph.ts");
		const patch = `*** Begin Patch\n*** Update File: ${source}\n@@\n- a\n+ b\n*** End Patch`;
		const v = checkGraphShardWrite("apply_patch", { command: patch }, dir, DEPS);
		expect(v?.decision).toBe("block");
		expect(v?.reason).toContain(source);
	});

	it("P4: resolves a RELATIVE path against cwd (the require() fail-open the .mjs had)", () => {
		makeShardedFile("rel.ts", "rel.graph.ts");
		const v = checkGraphShardWrite("Edit", { file_path: "src/rel.ts" }, dir, DEPS);
		expect(v?.decision).toBe("block");
	});
});

describe("checkGraphShardWrite — negative (must not fire)", () => {
	it("N1: allows a file with no colocated shard", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "plain.ts");
		writeFileSync(source, "export {}");
		expect(checkGraphShardWrite("Edit", { file_path: source }, dir, DEPS)).toBeNull();
	});

	it("N2: allows a stale shard (older than source - 60s)", () => {
		const source = makeShardedFile("stale.ts", "stale.graph.ts", FIXED_NOW - 120_000);
		expect(checkGraphShardWrite("Edit", { file_path: source }, dir, DEPS)).toBeNull();
	});

	it("N3: allows non-write tools regardless of shard presence", () => {
		const source = makeShardedFile("read.ts", "read.graph.ts");
		expect(checkGraphShardWrite("Read", { file_path: source }, dir, DEPS)).toBeNull();
	});

	it("N4: honors INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1", () => {
		const source = makeShardedFile("off.ts", "off.graph.ts");
		process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = "1";
		expect(checkGraphShardWrite("Edit", { file_path: source }, dir, DEPS)).toBeNull();
	});

	it("N5: allows when the host supplied no filesystem functions", () => {
		const source = makeShardedFile("nodeps.ts", "nodeps.graph.ts");
		const empty: ColdWriteDeps = { existsSync: null, statSync: null, join: null };
		expect(checkGraphShardWrite("Edit", { file_path: source }, dir, empty)).toBeNull();
	});
});

describe("COLD_WRITE_GUARDS_SOURCE — embeddable into the .mjs", () => {
	it("reconstructs checkGraphShardWrite and agrees with the imported function", () => {
		const rebuilt = rebuild("checkGraphShardWrite");
		const blocked = makeShardedFile("agree.ts", "agree.graph.ts");
		const clean = join(dir, "src", "agree-clean.ts");
		writeFileSync(clean, "export {}");
		for (const p of [blocked, clean, "src/agree.ts"]) {
			expect(rebuilt("Edit", { file_path: p }, dir, DEPS), p).toEqual(
				checkGraphShardWrite("Edit", { file_path: p }, dir, DEPS),
			);
		}
	});

	it("reconstructs checkMergeConflictWrite and agrees with the imported function", () => {
		const rebuilt = rebuild("checkMergeConflictWrite");
		const corpus: Array<[string, Record<string, unknown>]> = [
			["Write", { content: CONFLICT, file_path: "/repo/a.ts" }],
			["edit", { new_string: CONFLICT }],
			["multi_edit", { edits: [{ new_string: CONFLICT }] }],
			["Write", { content: "clean" }],
			["read", { content: CONFLICT }],
		];
		for (const [tool, input] of corpus) {
			expect(rebuilt(tool, input), tool).toEqual(checkMergeConflictWrite(tool, input));
		}
	});

	it("contains no backtick or `${` so it splices into any string context", () => {
		expect(COLD_WRITE_GUARDS_SOURCE).not.toContain("`");
		expect(COLD_WRITE_GUARDS_SOURCE).not.toContain("${");
	});

	it("exposes the dependency-injection shape the .mjs call site uses", () => {
		expect(typeof DEPS.existsSync).toBe("function");
		expect(typeof DEPS.statSync).toBe("function");
		expect(typeof DEPS.join).toBe("function");
	});
});
