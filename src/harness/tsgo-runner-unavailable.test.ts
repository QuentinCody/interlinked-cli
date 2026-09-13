import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTsgoRunner, type TsgoRunner } from "./tsgo-runner.js";

// Compiler discovery explicitly returns null when the optional binary is absent.
// Keep the runner and its lifecycle real while exercising that supported result.
vi.mock("./tsgo-diagnostics.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tsgo-diagnostics.js")>();
	return { ...actual, locateTsgo: () => null };
});

let runner: TsgoRunner;
beforeEach(() => { runner = createTsgoRunner(); });
afterEach(() => { runner.dispose?.(); });

describe("runner without an installed compiler", () => {
	it("reports unavailable without starting a watcher or populating the cache", () => {
		expect(runner.available()).toBe(false);
		expect(runner.stats()).toEqual({ cache_size: 0, available: false, watch_process: "unavailable" });
	});

	it("returns the unavailable check result without reading or changing the target", async () => {
		expect(await runner.checkFile(import.meta.filename))
			.toEqual({ diagnostics: [], cached: false, elapsed_ms: 0 });
		expect(runner.stats().cache_size).toBe(0);
	});
});
