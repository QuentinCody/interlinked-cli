import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStructureConfig } from "./structure-loader.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo(): string { const dir = mkdtempSync(join(tmpdir(), "struct-load-kill-")); roots.push(dir); return dir; }

// Census fault: the malformed-JSON branch reported `implicit: true` and survived the
// companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("loadStructureConfig — a present but unreadable structure.json is not implicit minimal mode", () => {
	// test-contract: bug — `implicit` means "no structure.json exists"; a file that fails to parse must be reported as an explicit configuration error, or the caller silently drops every structure check
	it("reports implicit=false with a parse error when structure.json is malformed JSON", () => {
		const root = repo();
		mkdirSync(join(root, "interlinked"));
		writeFileSync(join(root, "interlinked", "structure.json"), "{not json");
		const result = loadStructureConfig(root);
		expect(result.implicit).toBe(false);
		expect(result.config).toBeNull();
		expect(result.errors[0]).toMatch(/^Invalid JSON in structure\.json: /);
	});
});
