// Kill-proof receipts are protected files (kill-proof review M1): the guard must see the
// REAL path of a write (a symlinked receipts folder) and NotebookEdit's `notebook_path`.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../rules/default-config.js";
import { evaluateProtectedFilesGuard } from "./pre-tool-guards.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWithLinkedReceipts(): { root: string; link: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "protected-receipts-")));
	roots.push(root);
	mkdirSync(join(root, ".interlinked/test-runs/kill-proofs"), { recursive: true });
	const link = join(root, "alias");
	symlinkSync(join(root, ".interlinked/test-runs/kill-proofs"), link);
	return { root, link };
}

describe("protected_files — kill-proof receipts — positive (must block)", () => {
	it("P1: a Write through a SYMLINKED receipts directory is blocked by the real path", () => {
		const { root, link } = repoWithLinkedReceipts();
		const decision = evaluateProtectedFilesGuard("Write", { file_path: join(link, "0123456789abcdef.json"), content: "{}" }, DEFAULT_CONFIG, [], root);
		expect(decision?.decision).toBe("block");
	});

	it("P2: a relative path through the link resolves against the tool call's cwd", () => {
		const { root } = repoWithLinkedReceipts();
		const decision = evaluateProtectedFilesGuard("Edit", { file_path: "alias/0123456789abcdef.json", old_string: "a", new_string: "b" }, DEFAULT_CONFIG, [], root);
		expect(decision?.decision).toBe("block");
	});

	it("P3: NotebookEdit carries its target in notebook_path and maps to the Write operation", () => {
		const decision = evaluateProtectedFilesGuard("NotebookEdit", { notebook_path: "/repo/.interlinked/test-runs/kill-proofs/0123456789abcdef.json", new_source: "{}" }, DEFAULT_CONFIG, []);
		expect(decision?.decision).toBe("block");
	});

	it("P4: the index and any nested path under the receipts folder are protected too", () => {
		const decision = evaluateProtectedFilesGuard("Write", { file_path: "/repo/.interlinked/test-runs/kill-proofs/index.json", content: "{}" }, DEFAULT_CONFIG, []);
		expect(decision?.decision).toBe("block");
		const nested = evaluateProtectedFilesGuard("Write", { file_path: "/repo/.interlinked/test-runs/kill-proofs/sub/0123456789abcdef.json", content: "{}" }, DEFAULT_CONFIG, []);
		expect(nested?.decision).toBe("block");
	});
});

describe("protected_files — kill-proof receipts — negative (must not block)", () => {
	it("N1: a sibling test-runs folder is not a receipt", () => {
		const decision = evaluateProtectedFilesGuard("Write", { file_path: "/repo/.interlinked/test-runs/e2e/receipt.json", content: "{}" }, DEFAULT_CONFIG, []);
		expect(decision).toBeNull();
	});

	it("N2: a path with no existing ancestor never throws and is still judged as written", () => {
		expect(evaluateProtectedFilesGuard("Write", { file_path: "/nonexistent-root-xyz/a/b.json", content: "{}" }, DEFAULT_CONFIG, [])).toBeNull();
		expect(evaluateProtectedFilesGuard("Write", { file_path: "/nonexistent-root-xyz/a/secret.pem", content: "{}" }, DEFAULT_CONFIG, [], "/nonexistent-root-xyz")?.decision).toBe("block");
	});
});
