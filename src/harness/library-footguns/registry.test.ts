// Tests for the library-footguns registry. The framework supports
// per-library opt-out via .interlinked/disabled-libraries.json and
// aggregates all enabled footguns into a single per-edit pass.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	getAllFootguns,
	getEnabledFootguns,
	loadDisabledLibraries,
	runFootgunChecks,
} from "./registry.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-lf-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("getAllFootguns", () => {
	it("returns the bundled footgun checks (at least the node-fetch family)", () => {
		const all = getAllFootguns();
		// At minimum the starter `node-fetch` module ships.
		expect(all.some((f) => f.library === "node-fetch")).toBe(true);
		// Each entry has the contract shape.
		for (const f of all) {
			expect(typeof f.id).toBe("string");
			expect(typeof f.name).toBe("string");
			expect(typeof f.library).toBe("string");
			expect(typeof f.detect).toBe("function");
			expect(typeof f.fixInstruction).toBe("string");
		}
	});
});

describe("loadDisabledLibraries", () => {
	it("returns an empty set when no config file exists", () => {
		expect(loadDisabledLibraries(tmp)).toEqual(new Set());
	});

	it("returns the configured disabled set when the file is well-formed", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "disabled-libraries.json"),
			JSON.stringify({ version: 1, disabled: ["redis", "node-fetch"] }),
		);
		expect(loadDisabledLibraries(tmp)).toEqual(new Set(["redis", "node-fetch"]));
	});

	it("returns an empty set on malformed JSON instead of throwing", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "disabled-libraries.json"),
			"{ this is not json",
		);
		expect(loadDisabledLibraries(tmp)).toEqual(new Set());
	});

	it("returns an empty set on wrong schema version", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "disabled-libraries.json"),
			JSON.stringify({ version: 99, disabled: ["x"] }),
		);
		expect(loadDisabledLibraries(tmp)).toEqual(new Set());
	});
});

describe("getEnabledFootguns", () => {
	it("returns all footguns when no library is disabled", () => {
		const all = getAllFootguns();
		const enabled = getEnabledFootguns(new Set());
		expect(enabled.length).toBe(all.length);
	});

	it("filters out footguns from a disabled library", () => {
		const before = getAllFootguns();
		const enabled = getEnabledFootguns(new Set(["node-fetch"]));
		expect(enabled.every((f) => f.library !== "node-fetch")).toBe(true);
		expect(enabled.length).toBeLessThan(before.length);
	});
});

describe("runFootgunChecks", () => {
	it("returns no findings on clean code", () => {
		const findings = runFootgunChecks("export const x = 1;\n", "src/x.ts", new Set());
		expect(findings).toEqual([]);
	});

	it("returns one entry per footgun match with id, line, and message wired through", () => {
		// Use the node-fetch no-timeout footgun as the integration target.
		const content = `
			async function get(url: string) {
				const r = await fetch(url);
				return await r.json();
			}
		`;
		const findings = runFootgunChecks(content, "src/api.ts", new Set());
		const ftMatches = findings.filter((f) => f.id === "node_fetch_no_timeout");
		expect(ftMatches.length).toBeGreaterThan(0);
		expect(nonNull(ftMatches[0]).match.line).toBeGreaterThan(0);
		expect(nonNull(ftMatches[0]).match.text.length).toBeGreaterThan(0);
	});

	it("skips matches from disabled libraries", () => {
		const content = `
			async function get(url: string) {
				const r = await fetch(url);
				return await r.json();
			}
		`;
		const findings = runFootgunChecks(content, "src/api.ts", new Set(["node-fetch"]));
		expect(findings.filter((f) => f.id === "node_fetch_no_timeout")).toEqual([]);
	});

	it("carries on to the next footgun when one detector throws, instead of aborting the whole pass", async () => {
		// Mock a SIBLING module (never the registry under test) so one bundled
		// detector throws mid-scan. If the loop did not catch-and-continue,
		// this exception would propagate and the real child-process footgun
		// below it in the concatenation order would never run.
		vi.resetModules();
		vi.doMock("./node-fetch.js", () => ({
			NODE_FETCH_FOOTGUNS: [
				{
					id: "poison_footgun",
					name: "poison",
					library: "node-fetch",
					detect: () => {
						throw new Error("simulated detector crash");
					},
					fixInstruction: "n/a",
				},
			],
		}));
		const { runFootgunChecks: runWithPoisonedDetector } = await import("./registry.js");
		const content = "exec('rm -rf ' + userInput);\n";
		const findings = runWithPoisonedDetector(content, "src/tool.ts", new Set());
		// The throwing detector produced no finding of its own …
		expect(findings.some((f) => f.id === "poison_footgun")).toBe(false);
		// … but the pass continued past it to the real child-process footgun.
		expect(findings.some((f) => f.id === "child_process_exec_interpolated")).toBe(true);
		vi.doUnmock("./node-fetch.js");
		vi.resetModules();
	});
});
