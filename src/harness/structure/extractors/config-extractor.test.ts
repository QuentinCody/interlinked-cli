import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFile, extract, metadata } from "./config-extractor.js";

describe("config-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("metadata declares config-access patterns", () => {
		expect(metadata.name).toBe("config-extractor");
		expect(metadata.output_kinds).toEqual(["config_key"]);
	});

	it('discovers config.get("key")', () => {
		writeFileSync(join(tmp, "a.ts"), 'config.get("server.url")');
		const { nodes } = extract(tmp);
		expect(nodes.map((n) => n.label)).toContain("server.url");
	});

	it('discovers config["key"]', () => {
		writeFileSync(join(tmp, "b.ts"), `config["max_retries"]`);
		const { nodes } = extract(tmp);
		expect(nodes.map((n) => n.label)).toContain("max_retries");
	});

	it("discovers config.key.subkey (dotted)", () => {
		writeFileSync(join(tmp, "c.ts"), "config.db.host");
		const { nodes } = extract(tmp);
		expect(nodes.map((n) => n.label)).toContain("db.host");
	});

	it("returns empty when no matches", () => {
		writeFileSync(join(tmp, "a.ts"), "const x = 1;");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	it("deduplicates repeated keys across files", () => {
		writeFileSync(join(tmp, "a.ts"), 'config.get("dup.key")');
		writeFileSync(join(tmp, "b.ts"), 'config.get("dup.key")');
		const { nodes } = extract(tmp);
		expect(nodes.filter((n) => n.label === "dup.key")).toHaveLength(1);
	});

	it("classifyFile extracts keys from one file and skips unreadable/non-source", () => {
		writeFileSync(join(tmp, "z.ts"), 'config.get("scoped.key")');
		expect(classifyFile(tmp, "z.ts").nodes.map((n) => n.label)).toEqual(["scoped.key"]);
		expect(classifyFile(tmp, "missing.ts")).toEqual({ nodes: [], edges: [] });
		expect(classifyFile(tmp, "notes.md")).toEqual({ nodes: [], edges: [] });
	});

	it("skips a file it cannot read (permission denied) but still finds keys in siblings", () => {
		const locked = join(tmp, "locked.ts");
		writeFileSync(locked, 'config.get("locked.key")');
		chmodSync(locked, 0o000);
		writeFileSync(join(tmp, "open.ts"), 'config.get("open.key")');
		// Removing the file below only needs write permission on `tmp` (the
		// parent), not read permission on `locked` itself, so afterEach's
		// recursive rmSync still cleans it up with no restore needed here.
		const labels = extract(tmp).nodes.map((n) => n.label);
		expect(labels).not.toContain("locked.key");
		expect(labels).toContain("open.key");
	});

	it("skips a subdirectory it cannot list (permission denied) but still walks siblings", () => {
		const locked = join(tmp, "locked-dir");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		writeFileSync(join(tmp, "open2.ts"), 'config.get("open2.key")');
		try {
			const labels = extract(tmp).nodes.map((n) => n.label);
			expect(labels).toEqual(["open2.key"]);
		} finally {
			// Recursive cleanup in afterEach needs to list `locked-dir` (even
			// though it's empty) to confirm it holds nothing to remove, which
			// itself requires read+execute permission — restore it first.
			chmodSync(locked, 0o755);
		}
	});
});
