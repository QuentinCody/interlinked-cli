// Tests for the `interlinked viz` command actions. The server-start and the
// stop-signal are injected so runVizServe is fully exercised without binding a
// real port or trapping a process-global SIGINT.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatBanner, runVizServe, runVizSnapshot, waitForSignal } from "./viz.js";

describe("formatBanner", () => {
	it("renders the startup banner with the url and root", () => {
		const banner = formatBanner("http://127.0.0.1:6403", "/proj/here");
		expect(banner).toContain("http://127.0.0.1:6403");
		expect(banner).toContain("LIVE DASHBOARD");
		expect(banner).toContain("/proj/here");
	});
});

describe("waitForSignal", () => {
	it("resolves when the source emits SIGINT", async () => {
		const source = new EventEmitter();
		const stopped = waitForSignal(source);
		let resolved = false;
		stopped.then(() => {
			resolved = true;
		});
		// Give any premature (stub) resolution a chance to land before we emit.
		await new Promise((r) => setImmediate(r));
		expect(resolved).toBe(false);
		source.emit("SIGINT");
		await expect(stopped).resolves.toBeUndefined();
		expect(resolved).toBe(true);
	});
});

describe("runVizServe", () => {
	function stubHandle() {
		const close = vi.fn(async () => undefined);
		return { handle: { url: "http://127.0.0.1:6403", port: 6403, close }, close };
	}

	it("starts the server, prints a banner, and closes on stop", async () => {
		const { handle, close } = stubHandle();
		const startServer = vi.fn(async () => handle);
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const code = await runVizServe({}, { startServer, waitForStop: () => Promise.resolve() });
		write.mockRestore();
		expect(code).toBe(0);
		expect(startServer).toHaveBeenCalledTimes(1);
		expect(startServer).toHaveBeenCalledWith({ root: process.cwd() });
		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith();
	});

	it("emits json and forwards an explicit port", async () => {
		const { handle } = stubHandle();
		const startServer = vi.fn(async () => handle);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const code = await runVizServe(
			{ json: true, port: "4321", root: "." },
			{ startServer, waitForStop: () => Promise.resolve() },
		);
		log.mockRestore();
		expect(code).toBe(0);
		expect(startServer).toHaveBeenCalledWith({ root: expect.any(String), port: 4321 });
	});
});

describe("runVizSnapshot", () => {
	let proj: string;
	let empty: string;

	beforeAll(() => {
		proj = mkdtempSync(join(tmpdir(), "viz-cmd-"));
		writeFileSync(join(proj, "a.ts"), "export const X = 1;\n");
		writeFileSync(join(proj, "b.ts"), 'import { X } from "./a.js";\nexport const y = X;\n');
		empty = mkdtempSync(join(tmpdir(), "viz-cmd-empty-"));
	});

	afterAll(() => {
		rmSync(proj, { recursive: true, force: true });
		rmSync(empty, { recursive: true, force: true });
	});

	it("prints the snapshot as json", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const code = await runVizSnapshot({ root: proj, json: true });
		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		log.mockRestore();
		expect(code).toBe(0);
		expect(printed).toContain('"node_count": 2');
	});

	it("prints a normal-mode summary naming the most depended-on file", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await runVizSnapshot({ root: proj });
		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		log.mockRestore();
		expect(printed).toContain("2 files");
		expect(printed).toContain("most depended-on: a.ts");
	});

	it("handles an empty project with no most-depended-on file", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await runVizSnapshot({ root: empty });
		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		log.mockRestore();
		expect(printed).toContain("most depended-on: —");
	});
});
