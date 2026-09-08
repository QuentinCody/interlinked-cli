import { makeMinimalEvent as completeEventFixture, makeSession as completeSessionFixture } from "./fixtures/evaluator.js";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkDeadOnArrival,
	detectDeadOnArrival,
	formatDeadOnArrivalWarning,
} from "../dead-on-arrival.js";
import { resetWorkspaceActiveCache } from "../graph-prediction-classifier.js";
import type { ServerRuntime } from "../server/runtime-context.js";

const HEADER = "// @generated supermodel-shard — do not edit";

/** Fresh shard: no dependents, no callers — the dead-on-arrival shape. */
const DEAD_SHARD = [
	HEADER,
	"// [impact]",
	"// risk        LOW",
	"// direct      0",
	"// transitive  0",
].join("\n");

/** Shard with dependent files — alive. */
const HAS_DEPENDENTS_SHARD = [
	HEADER,
	"// [impact]",
	"// risk        MEDIUM",
	"// direct      3",
	"// transitive  8",
	"// affects     a.ts · b.ts · c.ts",
].join("\n");

/** Shard with zero dependents but a caller — still alive. */
const HAS_CALLERS_SHARD = [
	HEADER,
	"// [calls]",
	"// run ← handler    src/h.ts:10",
	"// [impact]",
	"// risk        LOW",
	"// direct      0",
	"// transitive  0",
].join("\n");

const dirs: string[] = [];

beforeEach(() => {
	resetWorkspaceActiveCache();
});
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function freshDir(): string {
	const d = mkdtempSync(join(tmpdir(), "supermodel-doa-"));
	dirs.push(d);
	return d;
}

/** Write a source file plus its colocated `.graph` shard. The shard is
 *  written after the source, so its mtime is fresh (>= source). Returns
 *  the absolute source path. */
function writePair(dir: string, name: string, shardBody: string): string {
	const src = join(dir, `${name}.ts`);
	writeFileSync(src, `export const ${name} = 1;\n`);
	writeFileSync(join(dir, `${name}.graph.ts`), shardBody);
	return src;
}

describe("detectDeadOnArrival", () => {
	it("flags a file whose fresh shard has no dependents and no callers", () => {
		const dir = freshDir();
		const src = writePair(dir, "dead", DEAD_SHARD);
		const hits = detectDeadOnArrival(new Set([src]), dir);
		expect(hits).toHaveLength(1);
		expect(nonNull(hits[0]).sourcePath).toBe(src);
	});

	it("does not flag a file with dependents (direct > 0)", () => {
		const dir = freshDir();
		const src = writePair(dir, "alive", HAS_DEPENDENTS_SHARD);
		expect(detectDeadOnArrival(new Set([src]), dir)).toHaveLength(0);
	});

	it("does not flag a file that has callers even when direct is 0", () => {
		const dir = freshDir();
		const src = writePair(dir, "called", HAS_CALLERS_SHARD);
		expect(detectDeadOnArrival(new Set([src]), dir)).toHaveLength(0);
	});

	it("does not flag a file whose shard is stale (freshness gate)", () => {
		const dir = freshDir();
		const src = writePair(dir, "stale", DEAD_SHARD);
		// Backdate the shard well past the 60s staleness grace.
		const old = new Date("2020-01-01T00:00:00Z");
		utimesSync(join(dir, "stale.graph.ts"), old, old);
		expect(detectDeadOnArrival(new Set([src]), dir)).toHaveLength(0);
	});

	it("does not flag a file that has no shard at all", () => {
		const dir = freshDir();
		// An anchor pair makes the workspace Supermodel-active...
		writePair(dir, "anchor", DEAD_SHARD);
		// ...but the file under test has only a source, no shard.
		const orphan = join(dir, "orphan.ts");
		writeFileSync(orphan, "export const orphan = 1;\n");
		expect(detectDeadOnArrival(new Set([orphan]), dir)).toHaveLength(0);
	});

	it("deduplicates the raw and resolved forms of the same file", () => {
		const dir = freshDir();
		const src = writePair(dir, "dead", DEAD_SHARD);
		// files_written stores both the absolute and cwd-relative form.
		const hits = detectDeadOnArrival(new Set([src, "dead.ts"]), dir);
		expect(hits).toHaveLength(1);
	});

	it("returns no hits for an empty file set", () => {
		const dir = freshDir();
		expect(detectDeadOnArrival(new Set(), dir)).toHaveLength(0);
	});
});

describe("formatDeadOnArrivalWarning", () => {
	it("returns null when there are no hits", () => {
		expect(formatDeadOnArrivalWarning([])).toBeNull();
	});

	it("formats a single hit with the verify-before-stop tag and a relative path", () => {
		const warning = formatDeadOnArrivalWarning(
			[{ sourcePath: "/repo/src/orphan.ts" }],
			"/repo",
		);
		expect(warning).not.toBeNull();
		expect(warning).toContain("[interlinked:verify-before-stop]");
		expect(warning).toContain("1 file(s)");
		expect(warning).toContain("src/orphan.ts");
		expect(warning).toContain("dead on arrival");
	});

	it("caps the enumerated list at 5 and notes the overflow", () => {
		const hits = Array.from({ length: 8 }, (_, i) => ({
			sourcePath: `/repo/src/f${i}.ts`,
		}));
		const warning = formatDeadOnArrivalWarning(hits, "/repo");
		expect(warning).toContain("8 file(s)");
		expect(warning).toContain("...and 3 more");
	});
});

describe("checkDeadOnArrival", () => {
	function fakeCtx(cwd: string, log: (msg: string) => void): ServerRuntime {
		// SAFETY: the check reads only `cwd` and `log` off the runtime.
		return { cwd, log } as unknown as ServerRuntime;
	}

	it("returns null and never logs when nothing written this session is dead-on-arrival", () => {
		const dir = freshDir();
		const src = writePair(dir, "alive", HAS_DEPENDENTS_SHARD);
		const log = vi.fn();
		const result = checkDeadOnArrival(
			fakeCtx(dir, log),
			// SAFETY: the check reads only `cwd` off the event.
			({ ...completeEventFixture(), ...{ cwd: dir } }),
			// SAFETY: the check reads only `files_written` off the trajectory.
			({ ...completeSessionFixture(), ...{ files_written: new Set([src]) } }),
		);
		expect(result).toBeNull();
		expect(log).not.toHaveBeenCalled();
	});

	it("returns the formatted warning and logs the hit count, preferring event.cwd", () => {
		const dir = freshDir();
		const src = writePair(dir, "dead", DEAD_SHARD);
		const log = vi.fn();
		const result = checkDeadOnArrival(
			// ctx.cwd is deliberately wrong so the assertion below only
			// passes if the check actually used event.cwd, not ctx.cwd.
			fakeCtx("/should-not-be-used", log),
			({ ...completeEventFixture(), ...{ cwd: dir } }),
			({ ...completeSessionFixture(), ...{ files_written: new Set([src]) } }),
		);
		expect(result).toContain("[interlinked:verify-before-stop]");
		expect(result).toContain("1 file(s)");
		expect(log).toHaveBeenCalledWith("Verify-before-stop: dead-on-arrival (1)");
	});

	it("falls back to ctx.cwd when the event carries no cwd", () => {
		const dir = freshDir();
		const src = writePair(dir, "dead", DEAD_SHARD);
		const log = vi.fn();
		const result = checkDeadOnArrival(
			fakeCtx(dir, log),
			completeEventFixture(),
			({ ...completeSessionFixture(), ...{ files_written: new Set([src]) } }),
		);
		expect(result).toContain("1 file(s)");
		expect(log).toHaveBeenCalledWith("Verify-before-stop: dead-on-arrival (1)");
	});
});
