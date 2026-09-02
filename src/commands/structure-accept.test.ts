import { describe, expect, it, vi } from "vitest";
import { buildAcceptLines, collectAccepts } from "./structure-accept.js";
import type { AcceptBatch, SkipEntry } from "./structure-helpers.js";

// Colour codes are stripped so assertions read the text, not the escapes.
const ESC = String.fromCharCode(27);
const strip = (s: string): string => s.split(ESC).join("").replace(/\[[0-9;]*m/g, "");
const plain = (lines: string[]): string[] => lines.map(strip);

// SAFETY: collectAccepts reads only `artifacts.public_api` / `artifacts.env`; the
// remaining StructureConfig sections are never touched, so empty stubs are sound.
const emptyConfig = {
	version: 1 as const,
	mode: "standard",
	artifacts: {},
	verify: {},
	posttooluse: {},
	adoption: {},
	builtins: {},
} as unknown as Parameters<typeof collectAccepts>[1];

describe("collectAccepts", () => {
	it("returns empty batches when no category caches exist", () => {
		const read = vi.fn(() => null);
		// SAFETY: the stub honours the ReadCategoryCache contract; `never` only
		// bridges vi.fn's inferred literal return type to that signature.
		const r = collectAccepts("/repo", emptyConfig, read as never);
		expect(r).toEqual({ accepted: [], skipped: [] });
		expect(read).toHaveBeenCalledWith("/repo", "public-symbols");
		expect(read).toHaveBeenCalledWith("/repo", "env-keys");
	});

	it("skips a cache whose item list is empty", () => {
		const read = vi.fn(() => ({ schema_version: 1, items: [] }));
		// SAFETY: the stub honours the ReadCategoryCache contract; `never` only
		// bridges vi.fn's inferred literal return type to that signature.
		const r = collectAccepts("/repo", emptyConfig, read as never);
		expect(r.accepted).toEqual([]);
		expect(r.skipped).toEqual([]);
	});
});

describe("buildAcceptLines", () => {
	it("lists each accepted batch with its count", () => {
		const accepted: AcceptBatch[] = [
			{ category: "public_api", count: 3 },
			{ category: "env", count: 1 },
		];
		const lines = plain(buildAcceptLines(accepted, []));
		expect(lines[0]).toContain("Structure Accept");
		expect(lines.some((l) => l.includes("public_api: 3 items"))).toBe(true);
		expect(lines.some((l) => l.includes("env: 1 items"))).toBe(true);
		expect(lines.some((l) => l.includes("Skipped"))).toBe(false);
	});

	it("renders a skipped section capped at ten rows with an overflow note", () => {
		const skipped: SkipEntry[] = Array.from({ length: 12 }, (_, i) => ({
			category: "env",
			item: `KEY_${String(i)}`,
			reason: "already declared",
		}));
		const lines = plain(buildAcceptLines([], skipped));
		expect(lines.filter((l) => l.includes("skip  env/")).length).toBe(10);
		expect(lines.some((l) => l.includes("... and 2 more"))).toBe(true);
		expect(lines.some((l) => l.includes("KEY_11"))).toBe(false);
	});

	it("omits the overflow note at exactly ten skips", () => {
		const skipped: SkipEntry[] = Array.from({ length: 10 }, (_, i) => ({
			category: "env",
			item: `KEY_${String(i)}`,
			reason: "already declared",
		}));
		const lines = plain(buildAcceptLines([], skipped));
		expect(lines.filter((l) => l.includes("skip  env/")).length).toBe(10);
		expect(lines.some((l) => l.includes("more"))).toBe(false);
	});
});
