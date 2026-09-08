// ===========================================
// Mutation local-state file helpers — unit tests
// ===========================================
// Covers the defensive error paths in the O_NOFOLLOW-guarded state-file
// helpers: an invalid filename, an existing-but-wrong-kind state path, an
// oversized state file, and a state directory whose realpath diverges from
// its resolved path (a TOCTOU/symlink-substitution guard that can't be
// reached through real filesystem state, so `realpathSync`'s SECOND call —
// against the already-verified-non-symlink `.interlinked` directory only —
// is wrapped as a call-through spy). Plain `vi.spyOn(fs, ...)` throws
// "Module namespace is not configurable in ESM" for node:fs under this
// vitest version — see build-staleness.test.ts for the same pattern.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { realpathControl } = vi.hoisted(() => ({
	// SAFETY: a nullable control flag, not a narrowing of unknown data — vi.hoisted
	// infers `null` without the annotation, which would reject the later string assign.
	realpathControl: { poisonPath: null as string | null },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		realpathSync: new Proxy(actual.realpathSync, {
			apply(target, receiver, args) {
				const real = Reflect.apply(target, receiver, args);
				if (realpathControl.poisonPath !== null && String(args[0]) === realpathControl.poisonPath) {
					return `${real}-tampered`;
				}
				return real;
			},
		}),
	};
});

import {
	readMutationStateFile,
	secureMutationStateFilePath,
	writeMutationStateFileAtomic,
} from "./mutation-local-state.js";

const roots: string[] = [];

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mutation-local-state-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	realpathControl.poisonPath = null;
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("secureMutationStateFilePath", () => {
	it("throws for a filename containing a path separator", () => {
		const root = freshRoot();
		expect(() => secureMutationStateFilePath(root, "sub/evil.json")).toThrow(
			"invalid mutation state filename: sub/evil.json",
		);
	});

	it("throws when the target name resolves to an existing non-file entry", () => {
		const root = freshRoot();
		const stateDir = join(realpathSync(root), ".interlinked");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(join(stateDir, "existing-dir"));
		expect(() => secureMutationStateFilePath(root, "existing-dir")).toThrow(
			`mutation state path must be a regular file or missing: ${join(stateDir, "existing-dir")}`,
		);
	});

	it("throws when the state directory's realpath diverges from its resolved path", () => {
		const root = freshRoot();
		const canonicalRoot = realpathSync(root);
		const stateDir = join(canonicalRoot, ".interlinked");
		realpathControl.poisonPath = stateDir;
		expect(() => secureMutationStateFilePath(root, "x.json")).toThrow(
			`mutation state directory escapes the repository: ${stateDir}`,
		);
	});
});

describe("readMutationStateFile", () => {
	it("throws when the on-disk file exceeds the caller's byte bound", () => {
		const root = freshRoot();
		writeMutationStateFileAtomic(root, "big.json", "x".repeat(100));
		const path = secureMutationStateFilePath(root, "big.json");
		expect(() => readMutationStateFile(root, "big.json", 10)).toThrow(
			`mutation state file is not a bounded regular file: ${path}`,
		);
	});
});
