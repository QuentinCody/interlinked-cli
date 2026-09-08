// ===========================================
// Inline-hook graph-prediction fail-closed gate
// ===========================================
// When the harness daemon is unreachable, the inline fallback in the
// generated `.interlinked/hooks/interlinked-activity.mjs` must still
// refuse to let Edit/Write/MultiEdit/NotebookEdit/apply_patch land on
// E-fresh files (source + colocated fresh `.graph.*` shard). Otherwise
// the predict/reveal/reconcile protocol is bypassable just by hiccupping
// the daemon. Tests the EXACT runtime function evaluated from the chunk.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_INLINE_CHUNK } from "../guards-inline.js";

interface GuardDecision {
	decision: string;
	reason?: string;
	rule_id?: string;
	severity?: string;
	category?: string;
}

type InlineFn = (
	hookEvent: string,
	toolName: string,
	toolInput: Record<string, unknown>,
) => GuardDecision | null;

function buildRuntimeInlineGuard(): InlineFn {
	// The chunk uses `existsSync` and `statSync` from the runtime's top-level
	// `import { ... } from "node:fs"`. When we eval the chunk inside a
	// `new Function`, those references are unbound — so we inject them as
	// closures the runtime can resolve via `arguments` or a wrapping IIFE.
	// SAFETY: the two named arguments bind the fs functions used by the trusted chunk, whose returned inlineGuardCheck is exercised on fresh, stale, and absent shards below.
	const factory = new Function(
		"existsSync",
		"statSync",
		`${GUARDS_INLINE_CHUNK}\nreturn inlineGuardCheck;`,
	) as (e: typeof existsSync, s: typeof statSync) => InlineFn;
	return factory(existsSync, statSync);
}

// Frozen wall-clock used by every test in this file so freshness/staleness
// boundaries are exercised deterministically — the runtime check compares
// shard mtime against source mtime with a 60s grace, so we need stable
// timestamps, not whatever `Date.now()` happens to return.
const FIXED_NOW = Date.parse("2026-05-10T12:00:00Z");

let dir: string;
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. All paths passed into the
// inline guard in this file are already absolute (`join(dir, ...)`), so the
// spy just keeps `process.cwd()` from drifting.
let cwdSpy: ReturnType<typeof vi.spyOn>;
let originalEnvOverride: string | undefined;

function setMtime(p: string, ms: number): void {
	utimesSync(p, ms / 1000, ms / 1000);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inline-graph-shard-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
	originalEnvOverride = process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
	delete process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
});

afterEach(() => {
	cwdSpy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
	if (originalEnvOverride === undefined) {
		delete process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
	} else {
		process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = originalEnvOverride;
	}
});

describe("inlineGraphShardCheck — fail-closed for E-fresh shard'd files", () => {
	it("blocks Edit on a file with a fresh colocated `.graph.<ext>` shard", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "foo.ts");
		const shard = join(dir, "src", "foo.graph.ts");
		writeFileSync(source, "export {}");
		writeFileSync(shard, "// @generated supermodel-sidecar");
		const t = Date.parse("2026-05-10T12:00:00Z");
		setMtime(source, t);
		setMtime(shard, t);

		const fn = buildRuntimeInlineGuard();
		const result = fn("PreToolUse", "Edit", { file_path: source, old_string: "x", new_string: "y" });
		expect(result?.decision).toBe("block");
		expect(result?.reason).toMatch(/graph-pred|harness-offline/i);
		expect(result?.reason).toContain(source);
		expect(result?.rule_id).toBe("graph-prediction-inline-fail-closed");
	});

	it("blocks Write on a file with the bare `.graph` (extension-less) shard form", () => {
		const source = join(dir, "Makefile");
		const shard = join(dir, "Makefile.graph");
		writeFileSync(source, "all:\n\techo ok");
		writeFileSync(shard, "// @generated");
		const t = FIXED_NOW;
		setMtime(source, t);
		setMtime(shard, t);

		const fn = buildRuntimeInlineGuard();
		const result = fn("PreToolUse", "Write", { file_path: source, content: "x" });
		expect(result?.decision).toBe("block");
	});

	it("blocks apply_patch when the patch body targets a shard'd file", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "handler.go");
		writeFileSync(source, "package main");
		writeFileSync(join(dir, "src", "handler.graph.go"), "// @generated");
		const t = FIXED_NOW;
		setMtime(source, t);
		setMtime(join(dir, "src", "handler.graph.go"), t);

		const patch = `*** Begin Patch\n*** Update File: ${source}\n@@\n- old\n+ new\n*** End Patch`;
		const fn = buildRuntimeInlineGuard();
		const result = fn("PreToolUse", "apply_patch", { command: patch });
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain(source);
	});
});

describe("inlineGraphShardCheck — does NOT block when there's no risk", () => {
	it("allows Edit on a file with no colocated shard", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "foo.ts");
		writeFileSync(source, "export {}");

		const fn = buildRuntimeInlineGuard();
		const result = fn("PreToolUse", "Edit", { file_path: source, old_string: "x", new_string: "y" });
		expect(result).toBeNull();
	});

	it("allows Edit when the shard is stale (older than source - 60s)", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "stale.ts");
		const shard = join(dir, "src", "stale.graph.ts");
		writeFileSync(source, "export {}");
		writeFileSync(shard, "// @generated");
		const t = FIXED_NOW;
		setMtime(source, t);
		setMtime(shard, t - 120_000); // shard 2 min older than source

		const fn = buildRuntimeInlineGuard();
		const result = fn("PreToolUse", "Edit", { file_path: source, old_string: "x", new_string: "y" });
		expect(result).toBeNull();
	});

	it("allows non-write tools (Read, Bash) regardless of shard presence", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "foo.ts");
		writeFileSync(source, "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated");
		const t = FIXED_NOW;
		setMtime(source, t);
		setMtime(join(dir, "src", "foo.graph.ts"), t);

		const fn = buildRuntimeInlineGuard();
		expect(fn("PreToolUse", "Read", { file_path: source })).toBeNull();
	});

	it("allows file writes when INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1 (override escape)", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "foo.ts");
		writeFileSync(source, "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated");
		const t = FIXED_NOW;
		setMtime(source, t);
		setMtime(join(dir, "src", "foo.graph.ts"), t);

		process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = "1";
		const fn = buildRuntimeInlineGuard();
		const result = fn("PreToolUse", "Edit", { file_path: source, old_string: "x", new_string: "y" });
		expect(result).toBeNull();
	});

	it("returns null on PostToolUse (gate is PreToolUse-only)", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const source = join(dir, "src", "foo.ts");
		writeFileSync(source, "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated");
		const t = FIXED_NOW;
		setMtime(source, t);
		setMtime(join(dir, "src", "foo.graph.ts"), t);

		const fn = buildRuntimeInlineGuard();
		expect(fn("PostToolUse", "Edit", { file_path: source })).toBeNull();
	});
});
