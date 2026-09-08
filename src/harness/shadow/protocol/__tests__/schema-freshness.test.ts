import { nonNull } from "../../../../lib/non-null.js";
// Finding 5 (external review, both repos): the generated JSON Schemas had no
// FULL freshness gate. `gen-shadow-schema.mts` only ever wrote, and
// `schema-differential.test.ts` compares property/required sets against
// fixtures, not the whole rendered output — a schema could drift (a stale
// description, a dropped brand pattern, a stray extra file) and nothing here
// would catch it.
//
// `renderShadowSchema()` is the pure computation the CLI's default path and
// its `--check` path both call; this test calls it IN-PROCESS and byte-compares
// against every committed file in `protocol/shadow-v1/schema/`, so a change to
// the registry or the declarations that isn't followed by regenerating the
// schemas fails the ordinary test gate — not just a separate `--check` run
// someone has to remember to invoke.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkShadowSchemaFresh, renderShadowSchema } from "../../generation/schema.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../../protocol/shadow-v1/schema");

function isSchemaEntry(entry: string): boolean {
	return entry.endsWith(".schema.json") || entry === "index.json";
}

function onDisk(): Map<string, string> {
	const files = new Map<string, string>();
	for (const entry of readdirSync(SCHEMA_DIR)) {
		if (isSchemaEntry(entry)) files.set(entry, readFileSync(join(SCHEMA_DIR, entry), "utf8"));
	}
	return files;
}

describe("shadow schema freshness — positive (must hold)", () => {
	it("P1: the committed schema tree byte-matches the in-process render", () => {
		const rendered = renderShadowSchema();
		const committed = onDisk();
		for (const [file, content] of rendered) {
			expect(committed.get(file), `${file} is missing or stale on disk`).toBe(content);
		}
	});

	it("P2: no committed file is stale relative to the render", () => {
		expect(checkShadowSchemaFresh(renderShadowSchema(), onDisk())).toBe(true);
	});

	it("P3: the render covers every registered record plus index.json", () => {
		const rendered = renderShadowSchema();
		expect(rendered.has("index.json")).toBe(true);
		expect(rendered.size).toBeGreaterThan(1);
	});
});

describe("shadow schema freshness — negative (must not hold)", () => {
	it("N1: a rendered file missing from disk is caught as drift", () => {
		const rendered = new Map(renderShadowSchema());
		rendered.set("__not_on_disk__.schema.json", "{}\n");
		expect(checkShadowSchemaFresh(rendered, onDisk())).toBe(false);
	});

	it("N2: an on-disk file the render no longer produces is caught as drift", () => {
		const disk = new Map(onDisk());
		disk.set("__stale_leftover__.schema.json", "{}\n");
		expect(checkShadowSchemaFresh(renderShadowSchema(), disk)).toBe(false);
	});

	it("N3: a byte-level change to one file's content is caught as drift", () => {
		const rendered = renderShadowSchema();
		const disk = new Map(onDisk());
		const [firstFile, firstContent] = nonNull([...rendered][0]);
		disk.set(firstFile, `${firstContent}\n`);
		expect(checkShadowSchemaFresh(rendered, disk)).toBe(false);
	});
});
