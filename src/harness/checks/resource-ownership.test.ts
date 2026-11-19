import { describe, expect, it } from "vitest";
import { detectResourceHandleLeak } from "./error-context.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCheckRoot } from "./check-root.js";

const imports = 'import { openSync, closeSync } from "node:fs";\n';
describe("resource_handle_leak cleanup ownership", () => {
	it("N3: resolves a relative release helper inside the actual check root", () => {
		const root = mkdtempSync(join(tmpdir(), "resource-owner-"));
		try {
			writeFileSync(join(root, "release.ts"), 'import { closeSync } from "node:fs"; export function release(fd: number) { closeSync(fd); }');
			const code = 'import { openSync } from "node:fs"; import { release } from "./release.js"; function load() { const fd = openSync(path); try { use(fd); } finally { release(fd); } }';
			expect(withCheckRoot(root, () => detectResourceHandleLeak(code, "load.ts")).result).toEqual([]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("P3: a deferred close inside an uncalled closure does not establish helper cleanup", () => {
		const code = imports + 'function cleanup(fd) { return () => closeSync(fd); } function load() { const fd = openSync(path); try { use(fd); } finally { cleanup(fd); } }';
		expect(detectResourceHandleLeak(code, "src/copy.ts")).toHaveLength(1);
	});
	it("P1: flags a second acquisition before the first handle's cleanup region", () => {
		const code = imports + 'function copy() { const source = openSync(a); const destination = openSync(b); try { use(source, destination); } finally { closeSync(source); closeSync(destination); } }';
		expect(detectResourceHandleLeak(code, "src/copy.ts").some(x => x.text.includes("before its cleanup"))).toBe(true);
	});
	it("P2: a helper without a close call does not discharge ownership", () => {
		const code = imports + 'function cleanup(fd) { log(fd); } function load() { const fd = openSync(path); try { use(fd); } finally { cleanup(fd); } }';
		expect(detectResourceHandleLeak(code, "src/copy.ts")).toHaveLength(1);
	});
	it("N1: recognizes a local cleanup wrapper and immediate cleanup region", () => {
		const code = imports + 'function cleanup(fd) { try { closeSync(fd); } catch {} } function load() { const fd = openSync(path); try { use(fd); } finally { cleanup(fd); } }';
		expect(detectResourceHandleLeak(code, "src/copy.ts")).toEqual([]);
	});
	it("N2: a second acquisition inside cleanup protection is safe", () => {
		const code = imports + 'function copy() { const source = openSync(a); try { const destination = openSync(b); try { use(source, destination); } finally { closeSync(destination); } } finally { closeSync(source); } }';
		expect(detectResourceHandleLeak(code, "src/copy.ts")).toEqual([]);
	});
});
