import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { contentIdentity, type DiskVersionState, diskVersion, readOnce } from "./tsc-overlay-identity.js";

function state(): DiskVersionState {
	return { versions: new Map(), identities: new Map(), runReads: new Map() };
}

function fileWith(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "overlay-identity-"));
	const file = join(dir, "a.ts");
	writeFileSync(file, content);
	return file;
}

function readDisk(file: string): string | undefined {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

// Session review r10 (2026-09-06), finding 1: a write through a shared memory
// mapping changes a file's bytes before any timestamp moves, so the version a
// warm service reports for a root file follows its CONTENT, never its stamp.
describe("contentIdentity", () => {
	it("P1: the same content has one identity", () => {
		expect(contentIdentity("export const x = 1;\n")).toBe(contentIdentity("export const x = 1;\n"));
	});

	it('P2: absent content has the literal identity "missing"', () => {
		expect(contentIdentity(undefined)).toBe("missing");
	});

	it("N1: one changed character changes the identity", () => {
		expect(contentIdentity("export const x = 1;\n")).not.toBe(contentIdentity("export const x = 2;\n"));
	});

	it.each([
		["high surrogate and replacement character", "\ud800", "\ufffd"],
		["low surrogate and replacement character", "\udc00", "\ufffd"],
		["different high surrogates", "\ud800", "\ud801"],
		["different low surrogates", "\udc00", "\udc01"],
	])("distinguishes %s in captured compiler text (review r12)", (_name, left, right) => {
		expect(contentIdentity(`export const value = "${left}";\n`))
			.not.toBe(contentIdentity(`export const value = "${right}";\n`));
	});
});

describe("diskVersion", () => {
	it("P3: rewritten bytes with every timestamp restored still bump the version", () => {
		const file = fileWith("export const x = 1;\n");
		const s = state();
		const first = diskVersion(s, file, readDisk);
		const stat = statSync(file);
		writeFileSync(file, "export const x = 2;\n");
		utimesSync(file, stat.atime, stat.mtime);
		s.runReads.clear();
		expect(diskVersion(s, file, readDisk)).not.toBe(first);
	});

	it("P4: a file the service first saw absent bumps the version once it exists", () => {
		const s = state();
		const file = fileWith("export const x = 1;\n");
		s.identities.set(file, "missing");
		s.versions.set(file, 1);
		expect(diskVersion(s, file, readDisk)).toBe("2");
	});

	it("N2: a touch that moves every timestamp but changes no byte keeps the version", () => {
		const file = fileWith("export const x = 1;\n");
		const s = state();
		const first = diskVersion(s, file, readDisk);
		const later = new Date("2030-01-01T00:00:00Z");
		utimesSync(file, later, later);
		s.runReads.clear();
		expect(diskVersion(s, file, readDisk)).toBe(first);
	});

	it("N3: inside one run the file is read once — a rewrite without a new run is not seen", () => {
		const file = fileWith("export const x = 1;\n");
		const s = state();
		const first = diskVersion(s, file, readDisk);
		writeFileSync(file, "export const x = 2;\n");
		expect(diskVersion(s, file, readDisk)).toBe(first);
		expect(s.runReads.size).toBe(1);
	});
});

// Session review r11 (2026-09-07): the version's hash read and the snapshot's
// read were two reads, so a write between them left a snapshot whose content
// did not match the identity the service remembered — and later runs, whose
// hash matched that identity, never refreshed it. One read serves both.
describe("readOnce — the snapshot and its identity come from ONE read", () => {
	it("P5: a reader that changes its answer between calls is asked once per run", () => {
		const s = state();
		const answers = ["export const x: number = 1;\n", "export const x: string = 'b';\n"];
		const reader = vi.fn(() => answers.shift());
		const version = diskVersion(s, "/virtual/dep.ts", reader);
		const snapshot = readOnce(s, "/virtual/dep.ts", reader);
		expect(reader).toHaveBeenCalledTimes(1);
		expect(snapshot.content).toBe("export const x: number = 1;\n");
		expect(snapshot.identity).toBe(contentIdentity(snapshot.content));
		expect(s.identities.get("/virtual/dep.ts")).toBe(snapshot.identity);
		expect(version).toBe("1");
	});

	it("P6: the next run reads again and sees the write the first run missed", () => {
		const s = state();
		const answers = ["export const x: number = 1;\n", "export const x: string = 'b';\n"];
		const reader = vi.fn(() => answers.shift());
		diskVersion(s, "/virtual/dep.ts", reader);
		s.runReads.clear();
		expect(diskVersion(s, "/virtual/dep.ts", reader)).toBe("2");
		expect(readOnce(s, "/virtual/dep.ts", reader).content).toBe("export const x: string = 'b';\n");
		expect(reader).toHaveBeenCalledTimes(2);
	});

	it("N4: a missing file reads as absent content with the missing identity", () => {
		const s = state();
		const read = readOnce(s, join(tmpdir(), "overlay-identity-none", "absent.ts"), readDisk);
		expect(read).toEqual({ identity: "missing", content: undefined });
	});
});
