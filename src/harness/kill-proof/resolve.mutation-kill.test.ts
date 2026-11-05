// Mutation-kill tests for kill-proof/resolve.ts — 2026-11-05 dogfood campaign
// (docs/reviews/kill-proof-dogfood.md): the identical-fault refusal and manifest lookup without --file.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveIdentities } from "../mutation/identity.js";
import { resolveMutant } from "./resolve.js";

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
let root: string;
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-resolve-mk-")));
	write("src/clamp.ts", SOURCE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveMutant — explicit fault refusals", () => {
	// test-contract: public-api - a fault whose replacement equals its anchor changes nothing and is refused before any run
	it("an identical --find/--replace is refused with the reason", () => {
		const result = resolveMutant(root, { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n > max" });
		expect(result).toEqual({ ok: false, reason: "--find and --replace are identical; nothing would change" });
	});
});

describe("resolveMutant — manifest lookup", () => {
	// test-contract: public-api - a manifest mutant id resolves WITHOUT --file: the manifest is searched across every file, and --file only narrows it
	it("a manifest id resolves across files when no --file is given, to the same site as with --file", () => {
		const offset = SOURCE.indexOf(">");
		const identities = deriveIdentities("src/clamp.ts", SOURCE, [{ file: "src/clamp.ts", mutator: "relational_operator", originalLexeme: ">", replacement: "<", startOffset: offset }]);
		expect(identities).not.toBeNull();
		const id = identities?.[0];
		if (!id) return;
		const manifest = {
			version: 1, generation: 7, authoritativeAt: "2026-11-05T00:00:00.000Z", engine: "test", engineVersion: "0", dependencyGraphVersion: "0", environmentHash: "0",
			files: { "src/clamp.ts": { [id.symbolId]: { symbolId: id.symbolId, qualifiedName: id.qualifiedName, symbolHash: "0", instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
				mutants: { [id.mutantId]: { mutantId: id.mutantId, siteId: id.siteId, mutator: id.mutator, originalLexeme: ">", replacement: "<", ordinalWithinSymbol: id.ordinalWithinSymbol, status: "survived", firstSeen: "2026-11-05T00:00:00.000Z" } } } } },
		};
		write(".interlinked/mutation-manifest.json", `${JSON.stringify(manifest)}\n`);
		const bare = resolveMutant(root, { kind: "manifest", mutantId: id.mutantId });
		expect(bare.ok).toBe(true);
		if (!bare.ok) return;
		expect(bare.mutant).toMatchObject({ file: "src/clamp.ts", offset, originalLexeme: ">", replacement: "<", line: 2, source: "manifest", mutantId: id.mutantId, manifestGeneration: 7, manifestStatus: "survived" });
		expect(resolveMutant(root, { kind: "manifest", mutantId: id.mutantId, file: "src/clamp.ts" })).toEqual(bare);
	});
});
