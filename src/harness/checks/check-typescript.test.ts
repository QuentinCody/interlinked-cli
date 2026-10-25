// Tests for check-typescript.ts — the `typescript` loader that registry
// detectors share: harness installation first, the check root's copy second,
// successes cached, failures never cached, NOT MEASURED when neither resolves.

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Loader = typeof import("./check-typescript.js");
type Root = typeof import("./check-root.js");

const FAKE_PROJECT_TS = { marker: "project-typescript" };

/**
 * Fresh copies of the loader and check-root under a `createRequire` whose
 * `typescript` answer comes from `answer(base)`: a value to return, or
 * undefined to throw "Cannot find module".
 */
async function loadWith(answer: (base: string) => unknown): Promise<{
	loader: Loader;
	root: Root;
	bases: string[];
}> {
	const bases: string[] = [];
	vi.resetModules();
	vi.doMock("node:module", async (importOriginal) => {
		const actual = await importOriginal<typeof import("node:module")>();
		const createRequire = (base: string | URL) => {
			const real = actual.createRequire(base);
			return Object.assign((id: string): unknown => {
				if (id !== "typescript") return real(id);
				const text = String(base);
				bases.push(text);
				const value = answer(text);
				if (value === undefined) throw new Error("Cannot find module 'typescript' (simulated)");
				return value;
			}, real);
		};
		return { ...actual, createRequire, default: { ...actual, createRequire } };
	});
	const loader = await import("./check-typescript.js");
	const root = await import("./check-root.js");
	return { loader, root, bases };
}

const isHarnessBase = (base: string): boolean => base.startsWith("file:");

afterEach(() => {
	vi.doUnmock("node:module");
	vi.resetModules();
});

describe("loadCheckTypescript — positive (must resolve)", () => {
	it("P1: resolves the harness's own installation first and caches it", async () => {
		const harness = { marker: "harness-typescript" };
		const { loader, bases } = await loadWith((base) => (isHarnessBase(base) ? harness : FAKE_PROJECT_TS));
		expect(loader.loadCheckTypescript("probe_check", "a probe finding")).toBe(harness);
		expect(loader.loadCheckTypescript("probe_check", "a probe finding")).toBe(harness);
		expect(bases).toEqual([expect.stringMatching(/^file:.*\/check-typescript\.ts$/)]);
	});

	it("P2: falls back to the check root's copy when the harness has none", async () => {
		const { loader, root, bases } = await loadWith((base) => (isHarnessBase(base) ? undefined : FAKE_PROJECT_TS));
		const run = root.withCheckRoot("/scan/root-a", () => loader.loadCheckTypescript("probe_check", "x"));
		expect(run.result).toBe(FAKE_PROJECT_TS);
		expect(run.notMeasured).toEqual([]);
		expect(bases).toEqual([expect.stringMatching(/^file:/), join("/scan/root-a", "_")]);
	});

	it("P3: re-attempts after a failure, so a later install is found without a reset", async () => {
		let installed = false;
		const { loader, root, bases } = await loadWith((base) =>
			installed && !isHarnessBase(base) ? FAKE_PROJECT_TS : undefined,
		);
		const first = root.withCheckRoot("/scan/root-a", () => loader.loadCheckTypescript("probe_check", "x"));
		expect(first.result).toBeNull();
		installed = true;
		const second = root.withCheckRoot("/scan/root-a", () => loader.loadCheckTypescript("probe_check", "x"));
		expect(second.result).toBe(FAKE_PROJECT_TS);
		expect(second.notMeasured).toEqual([]);
		expect(bases).toHaveLength(4);
	});

	it("P4: resetCheckTypescriptCache makes the next call resolve again", async () => {
		const { loader, bases } = await loadWith(() => FAKE_PROJECT_TS);
		loader.loadCheckTypescript("probe_check", "x");
		loader.resetCheckTypescriptCache();
		loader.loadCheckTypescript("probe_check", "x");
		expect(bases).toHaveLength(2);
	});
});

describe("loadCheckTypescript — negative (must not resolve)", () => {
	it("N1: with no copy anywhere, returns null and reports NOT MEASURED naming the check and root", async () => {
		const { loader, root } = await loadWith(() => undefined);
		const run = root.withCheckRoot("/scan/root-a", () => loader.loadCheckTypescript("probe_check", "a probe finding"));
		expect(run.result).toBeNull();
		expect(run.notMeasured).toEqual([
			"[interlinked:probe_check] NOT MEASURED: `typescript` is not resolvable from the harness installation " +
				"or from /scan/root-a, so the AST pass ran no scan; a probe finding was neither found nor cleared. " +
				"Reinstall without `--omit=optional` to restore it.",
		]);
	});

	it("N2: a copy cached under one root is not reused for another root", async () => {
		const { loader, root } = await loadWith((base) => (base === join("/scan/root-a", "_") ? FAKE_PROJECT_TS : undefined));
		const a = root.withCheckRoot("/scan/root-a", () => loader.loadCheckTypescript("probe_check", "x"));
		const b = root.withCheckRoot("/scan/root-b", () => loader.loadCheckTypescript("probe_check", "x"));
		expect(a.result).toBe(FAKE_PROJECT_TS);
		expect(b.result).toBeNull();
		expect(b.notMeasured).toHaveLength(1);
		expect(b.notMeasured[0]).toContain("/scan/root-b");
	});
});
