import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only `writeFileSync` is overridden (and only when its path matches the
// currently-armed failure target); every other node:fs call — including
// `readFileSync`, used by the manager to reload its own pending-findings
// file — forwards to the real implementation so fixtures on disk still work.
// SAFETY: widening a `null` literal to its nullable-string field type; no
// value is asserted here, only the type of a flag that starts unarmed.
const fsFailure = vi.hoisted(() => ({ writePath: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: (...args: unknown[]) => {
			const [target] = args;
			if (typeof target === "string" && target === fsFailure.writePath) {
				throw new Error("EACCES: permission denied, write");
			}
			// SAFETY: forwards the exact captured arguments to the real
			// overloaded function and preserves its runtime return value.
			return (actual.writeFileSync as (...a: unknown[]) => unknown)(...args);
		},
	};
});

const { writeFileSync } = await import("node:fs");
const { createAsyncAnalysisManager } = await import("./async-analysis.js");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "async-analysis-"));
	fsFailure.writePath = null;
});

afterEach(() => {
	fsFailure.writePath = null;
	rmSync(dir, { recursive: true, force: true });
});

describe("createAsyncAnalysisManager", () => {
	// test-contract: boundary — persisted JSON is untrusted; malformed records cannot escape as typed findings.
	it.each([null, [], true, 42, "map", { "src/a.ts": null }, { "src/a.ts": { file: "src/a.ts", findings: [null], produced_at: "now" } }])
		("ignores valid JSON with an invalid pending-map shape: %j", value => {
			writeFileSync(join(dir, "pending-async-findings.json"), JSON.stringify(value));
			expect(createAsyncAnalysisManager(dir).consume("src/a.ts")).toEqual([]);
		});

	it("retains valid records beside invalid ones and never consumes inherited properties", () => {
		const finding = { source: "quality", name: "typescript", severity: "warning", message: "unused", determinism: "fully_deterministic" };
		writeFileSync(join(dir, "pending-async-findings.json"), JSON.stringify({
			"src/a.ts": { file: "src/a.ts", findings: [finding], produced_at: "2026-11-11T00:00:00Z" },
			"src/b.ts": { file: "different.ts", findings: [finding], produced_at: "now" },
			"src/c.ts": { file: "src/c.ts", findings: [{ ...finding, line: "wrong" }], produced_at: "now" },
		}));
		const manager = createAsyncAnalysisManager(dir);
		expect(manager.consume("src/a.ts")).toEqual([finding]);
		expect(manager.consume("src/b.ts")).toEqual([]);
		expect(manager.consume("src/c.ts")).toEqual([]);
		expect(manager.consume("constructor")).toEqual([]);
		expect(manager.consume("__proto__")).toEqual([]);
	});

	it("consume() returns an empty array when the pending-findings file is corrupt JSON", () => {
		const pendingsPath = join(dir, "pending-async-findings.json");
		writeFileSync(pendingsPath, "{not valid json", "utf-8");
		const manager = createAsyncAnalysisManager(dir);

		expect(manager.consume("src/a.ts")).toEqual([]);
	});

	it("submit() swallows a write failure instead of corrupting manager state", async () => {
		const manager = createAsyncAnalysisManager(dir);
		fsFailure.writePath = join(dir, "pending-async-findings.json");

		manager.submit("src/a.ts", () =>
			Promise.resolve([
				{
					source: "quality",
					name: "typescript",
					severity: "warning",
					message: "unused variable",
					determinism: "fully_deterministic",
				},
			]),
		);
		await manager.drain();

		expect(manager.consume("src/a.ts")).toEqual([]);
	});

	it("drain() resolves without rejecting when the submitted analysis function itself throws", async () => {
		const manager = createAsyncAnalysisManager(dir);
		manager.submit("src/b.ts", () => Promise.reject(new Error("analysis boom")));

		await expect(manager.drain()).resolves.toBeUndefined();
		expect(manager.inProgress).toBe(false);
		expect(manager.consume("src/b.ts")).toEqual([]);
	});

	it("consume() still returns the pending findings when clearing them fails to write", () => {
		const pendingsPath = join(dir, "pending-async-findings.json");
		const finding = {
			source: "quality",
			name: "typescript",
			severity: "warning",
			message: "unused variable",
			determinism: "fully_deterministic",
		};
		writeFileSync(
			pendingsPath,
			JSON.stringify({
				"src/a.ts": { file: "src/a.ts", findings: [finding], produced_at: "2026-09-05T00:00:00.000Z" },
			}),
			"utf-8",
		);
		const manager = createAsyncAnalysisManager(dir);
		fsFailure.writePath = pendingsPath;

		expect(manager.consume("src/a.ts")).toEqual([finding]);
	});
});
