import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	initEffectAttributionStore,
	partitionResidueByAttribution,
	RECONCILED_PATH_CEILING,
	recordReconciledEffects,
	resetReconciledEffectRegistry,
} from "./workspace-effect-attribution.js";
import type { WorkspaceFileEffect } from "./workspace-effects.js";

function effect(path: string, sha: string | null, kind: WorkspaceFileEffect["kind"] = "modified"): WorkspaceFileEffect {
	return { path, kind, before_sha256: "before", after_sha256: sha };
}

beforeEach(() => {
	resetReconciledEffectRegistry();
});

describe("partitionResidueByAttribution — positive (must attribute elsewhere)", () => {
	it("keeps malformed persisted entries from claiming another session's writes", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-invalid-records-"));
		try {
			mkdirSync(join(root, ".interlinked"), { recursive: true });
			writeFileSync(join(root, ".interlinked", "effect-attribution.json"), JSON.stringify({
				"src/null.ts": null, "src/bad-session.ts": { sessionId: 42, sha256: "abc" },
				"src/valid.ts": { sessionId: "other", sha256: "abc" },
			}));
			initEffectAttributionStore(root);
			initEffectAttributionStore(root);
			const result = partitionResidueByAttribution("current", [effect("src/null.ts", "abc"), effect("src/bad-session.ts", "abc"), effect("src/valid.ts", "abc")]);
			expect(result.own.map((entry) => entry.path)).toEqual(["src/null.ts", "src/bad-session.ts"]);
			expect(result.attributedElsewhere).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P1: drops a residue effect whose hash matches another session's reconciled write", () => {
		recordReconciledEffects("session-b", [effect("src/foo.ts", "abc")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "abc")]);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P2: attributes a deletion via null-hash equality", () => {
		recordReconciledEffects("session-b", [effect("src/gone.ts", null, "deleted")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/gone.ts", null, "deleted")]);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P3: a later reconciliation for the same path wins over an earlier one", () => {
		recordReconciledEffects("session-a", [effect("src/foo.ts", "old")]);
		recordReconciledEffects("session-b", [effect("src/foo.ts", "new")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "new")]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P4: distinguishes sibling subagents that share one session", () => {
		recordReconciledEffects("shared-session", [effect("src/child.ts", "child-a")], "child-a");
		const result = partitionResidueByAttribution(
			"shared-session",
			[effect("src/child.ts", "child-a")],
			"child-b",
		);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P5: distinguishes a child from the root actor in the same session", () => {
		recordReconciledEffects("shared-session", [effect("src/child.ts", "child")], "child-a");
		const result = partitionResidueByAttribution("shared-session", [
			effect("src/child.ts", "child"),
		]);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("P6: distinguishes a root write from a child actor in the same session", () => {
		recordReconciledEffects("shared-session", [effect("src/root.ts", "root")]);
		const result = partitionResidueByAttribution(
			"shared-session",
			[effect("src/root.ts", "root")],
			"child-a",
		);
		expect(result.own).toEqual([]);
		expect(result.attributedElsewhere).toBe(1);
	});
});

describe("partitionResidueByAttribution — negative (must keep as own residue)", () => {
	it("N1: keeps an effect on a path no session ever reconciled", () => {
		const result = partitionResidueByAttribution("session-a", [effect("src/unknown.ts", "abc")]);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});

	it("P-widened (2026-08-23): attributes a hash-MISMATCHED effect on a path another session owns — the concurrent writer edited its file again after reconciling, which was the residual leak into innocent sessions", () => {
		recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "later-change")]);
		expect(result.own).toHaveLength(0);
		expect(result.attributedElsewhere).toBe(1);
	});

	it("N3: keeps an effect reconciled by the SAME session — own work is never excluded", () => {
		recordReconciledEffects("session-a", [effect("src/foo.ts", "abc")]);
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "abc")]);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});

	it("N4: keeps an effect reconciled by the same child actor", () => {
		recordReconciledEffects("shared-session", [effect("src/child.ts", "abc")], "child-a");
		const result = partitionResidueByAttribution(
			"shared-session",
			[effect("src/child.ts", "abc")],
			"child-a",
		);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});
});

describe("registry bounds", () => {
	it("prunes the stalest attribution once past the ceiling", () => {
		recordReconciledEffects("session-b", [effect("src/first.ts", "first")]);
		for (let i = 0; i < RECONCILED_PATH_CEILING; i++) {
			recordReconciledEffects("session-b", [effect(`src/f${i}.ts`, "x")]);
		}
		// The oldest entry was pruned, so the matching residue is no longer attributed.
		const first = partitionResidueByAttribution("session-a", [effect("src/first.ts", "first")]);
		expect(first.attributedElsewhere).toBe(0);
		// A fresh entry is still present.
		const fresh = partitionResidueByAttribution("session-a", [
			effect(`src/f${RECONCILED_PATH_CEILING - 1}.ts`, "x"),
		]);
		expect(fresh.attributedElsewhere).toBe(1);
	});
});

describe("durable registry — survives a daemon restart", () => {
	it("P-persist: attributes across a registry reset when a store root is set (simulated daemon restart)", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-store-"));
		try {
			initEffectAttributionStore(root);
			recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
			// Simulate the daemon dying: wipe all in-memory state, then re-init
			// against the same root — the JSON store must restore the evidence.
			resetReconciledEffectRegistry();
			initEffectAttributionStore(root);
			const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "theirs")]);
			expect(result.own).toHaveLength(0);
			expect(result.attributedElsewhere).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N-persist: without a store root, a reset loses the evidence (old in-memory semantics)", () => {
		recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
		resetReconciledEffectRegistry();
		const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "theirs")]);
		expect(result.own).toHaveLength(1);
		expect(result.attributedElsewhere).toBe(0);
	});

	it("P-persist-child: preserves same-session child identity across a restart", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-child-store-"));
		try {
			initEffectAttributionStore(root);
			recordReconciledEffects("shared-session", [effect("src/child.ts", "theirs")], "child-a");
			resetReconciledEffectRegistry();
			initEffectAttributionStore(root);
			const result = partitionResidueByAttribution(
				"shared-session",
				[effect("src/child.ts", "theirs")],
				"child-b",
			);
			expect(result.own).toEqual([]);
			expect(result.attributedElsewhere).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P-persist-root: preserves known-root identity across a restart", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-root-store-"));
		try {
			initEffectAttributionStore(root);
			recordReconciledEffects("shared-session", [effect("src/root.ts", "theirs")]);
			resetReconciledEffectRegistry();
			initEffectAttributionStore(root);
			const result = partitionResidueByAttribution(
				"shared-session",
				[effect("src/root.ts", "theirs")],
				"child-a",
			);
			expect(result.own).toEqual([]);
			expect(result.attributedElsewhere).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P-corrupt-store: falls back to in-memory attribution when the store file has invalid JSON, and a second corrupt root still logs only once", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-corrupt-store-"));
		const root2 = mkdtempSync(join(tmpdir(), "effect-attr-corrupt-store-2-"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const storeDir = join(root, ".interlinked");
			mkdirSync(storeDir, { recursive: true });
			writeFileSync(join(storeDir, "effect-attribution.json"), "{not valid json", "utf-8");
			initEffectAttributionStore(root);
			// The load attempt fails (bad JSON) but recording must still work
			// off the in-memory map — the corrupt store only loses old evidence.
			recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]);
			const result = partitionResidueByAttribution("session-a", [effect("src/foo.ts", "theirs")]);
			expect(result.attributedElsewhere).toBe(1);
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[interlinked] effect-attribution store unreadable:"),
			);

			// Re-pointing at a second, also-corrupt root (without a full registry
			// reset) re-arms loadRegistryOnce — initEffectAttributionStore clears
			// the per-root loadedFromDisk flag on a root change — so the load
			// catch runs a second time. The module-wide "already noted" guard in
			// noteAttributionStoreFailure must still suppress this second log.
			const storeDir2 = join(root2, ".interlinked");
			mkdirSync(storeDir2, { recursive: true });
			writeFileSync(join(storeDir2, "effect-attribution.json"), "{also not valid", "utf-8");
			initEffectAttributionStore(root2);
			recordReconciledEffects("session-b", [effect("src/bar.ts", "theirs")]);
			expect(errorSpy).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
			rmSync(root2, { recursive: true, force: true });
		}
	});

	it("P-persist-fail: logs once when persisting the store fails, without throwing out of recordReconciledEffects", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-persist-fail-"));
		// Point the store root at a plain FILE, not a directory: mkdirSync of
		// "<root>/.interlinked" then fails because a path component is a file.
		const fileAsRoot = join(root, "not-a-dir");
		writeFileSync(fileAsRoot, "not a directory", "utf-8");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			initEffectAttributionStore(fileAsRoot);
			expect(() =>
				recordReconciledEffects("session-b", [effect("src/foo.ts", "theirs")]),
			).not.toThrow();
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[interlinked] effect-attribution store write failed:"),
			);
		} finally {
			errorSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N-legacy: a persisted row without actor identity stays session-scoped", () => {
		const root = mkdtempSync(join(tmpdir(), "effect-attr-legacy-store-"));
		try {
			const storeDir = join(root, ".interlinked");
			mkdirSync(storeDir, { recursive: true });
			writeFileSync(
				join(storeDir, "effect-attribution.json"),
				JSON.stringify({
					"src/legacy.ts": { sessionId: "shared-session", sha256: "legacy" },
				}),
				"utf-8",
			);
			initEffectAttributionStore(root);
			const result = partitionResidueByAttribution(
				"shared-session",
				[effect("src/legacy.ts", "legacy")],
				"child-a",
			);
			expect(result.own).toHaveLength(1);
			expect(result.attributedElsewhere).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
