import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { minimalPolicy, type RawPolicy } from "./__tests__/policy-fixture.js";
import { scenarioKey } from "./ledger.js";
import { E2E_POLICY_PATH } from "./policy.js";
import { reconcileChanges } from "./reconcile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-reconcile-kill-"))); roots.push(root);
	mkdirSync(join(root, "src/orders"), { recursive: true });
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	writeFileSync(join(root, "src/orders/create.js"), "1\n");
	writeFileSync(join(root, "docs.md"), "docs\n");
	const raw = minimalPolicy();
	((raw.projects as RawPolicy[])[0]!.scenarios as RawPolicy[])[0]!.affects = ["src/orders/**"];
	writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(raw));
	writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [{ id: "orders.create", description: "d", source: { kind: "example", path: "docs.md", sha256: "a".repeat(64), quote: "docs" }, inputs: [], runner: { kind: "process", argv: ["node", "-e", "1"] }, expect: { exitCode: 0 } }] }));
	return root;
}

describe("reconcileChanges — mutation-directed", () => {
	// test-contract: invariant — an obligation already pending at the current generation stays in affected without being re-opened (review C6)
	it("keeps an already-pending obligation in affected but not in pending", () => {
		const root = setup();
		const first = reconcileChanges({ root, changedPaths: ["src/orders/create.js"], atMs: 10 });
		expect(first.affected.map(row => row.key)).toEqual([scenarioKey("orders", "order-persists")]);
		const again = reconcileChanges({ root, changedPaths: ["src/orders/create.js"], atMs: 11 });
		expect(again.pending).toEqual([]);
		expect(again.affected.map(row => row.key)).toEqual([scenarioKey("orders", "order-persists")]);
	});
});
