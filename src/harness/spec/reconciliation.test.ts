import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendReconciliationTxn,
	loadReconciliation,
	reconciliationPath,
	reconciliationStateOf,
} from "./reconciliation.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "spec-recon-"));
	roots.push(root);
	return root;
}

const T = "2026-07-16T00:00:00.000Z";

describe("reconciliation sidecar", () => {
	it("keeps the sidecar under .interlinked/findings/", () => {
		expect(reconciliationPath("/repo")).toBe(
			"/repo/.interlinked/findings/reconciliation.jsonl",
		);
	});

	it("folds append-only txns: open → touched → acked", () => {
		const cwd = tmpRepo();
		expect(reconciliationStateOf(loadReconciliation(cwd), "f1")).toBe("open");
		appendReconciliationTxn(cwd, {
			finding_id: "f1",
			action: "touched",
			by: "session-a",
			file: "README.md",
			ts: T,
		});
		expect(reconciliationStateOf(loadReconciliation(cwd), "f1")).toBe("touched");
		appendReconciliationTxn(cwd, {
			finding_id: "f1",
			action: "acked",
			by: "qcody",
			reason: "deliberate: deferred to W9",
			ts: T,
		});
		const map = loadReconciliation(cwd);
		expect(reconciliationStateOf(map, "f1")).toBe("acked");
		expect(map.get("f1")?.last_txn?.reason).toContain("deferred");
	});

	it("a touch never downgrades an ack; reopen does", () => {
		const cwd = tmpRepo();
		appendReconciliationTxn(cwd, { finding_id: "f2", action: "acked", by: "q", ts: T });
		appendReconciliationTxn(cwd, {
			finding_id: "f2",
			action: "touched",
			by: "session-b",
			ts: T,
		});
		expect(reconciliationStateOf(loadReconciliation(cwd), "f2")).toBe("acked");
		appendReconciliationTxn(cwd, { finding_id: "f2", action: "reopened", by: "q", ts: T });
		expect(reconciliationStateOf(loadReconciliation(cwd), "f2")).toBe("open");
	});

	it("rejects semantically invalid txns instead of folding to touched (round-2 #9)", () => {
		const cwd = tmpRepo();
		// Seed the sidecar via the public API so its parent dir exists.
		appendReconciliationTxn(cwd, { finding_id: "seed", action: "touched", by: "x", ts: T });
		writeFileSync(
			reconciliationPath(cwd),
			`${JSON.stringify({ finding_id: "F1", action: "garbage", by: "x", ts: T })}\n`,
			{ flag: "w" },
		);
		// An unknown action must NOT close the finding — it stays open.
		expect(reconciliationStateOf(loadReconciliation(cwd), "F1")).toBe("open");
	});

	it("an append after a torn tail does not corrupt the new txn (round-2 #10)", () => {
		const cwd = tmpRepo();
		appendReconciliationTxn(cwd, { finding_id: "seed", action: "touched", by: "x", ts: T });
		// A prior write lost its trailing newline (torn tail).
		writeFileSync(reconciliationPath(cwd), '{"trunc', { flag: "w" });
		appendReconciliationTxn(cwd, { finding_id: "F5", action: "acked", by: "q", ts: T });
		// The new txn is on its own line and replays cleanly.
		expect(reconciliationStateOf(loadReconciliation(cwd), "F5")).toBe("acked");
	});

	it("tolerates torn tails and malformed lines (append-only contract)", () => {
		const cwd = tmpRepo();
		appendReconciliationTxn(cwd, { finding_id: "f3", action: "touched", by: "s", ts: T });
		writeFileSync(
			reconciliationPath(cwd),
			`${JSON.stringify({ finding_id: "f3", action: "touched", by: "s", ts: T })}\nnot json\n{"finding_id":"f4","action":"acked","by":"q","ts":"${T}"}\n{"trunc`,
			{ flag: "w" },
		);
		const map = loadReconciliation(cwd);
		expect(reconciliationStateOf(map, "f3")).toBe("touched");
		expect(reconciliationStateOf(map, "f4")).toBe("acked");
	});

	it("appends without a torn-tail prefix when the sidecar cannot be read back (unreadable-file catch)", () => {
		if (process.getuid?.() === 0) return; // root bypasses chmod, can't simulate EACCES
		const cwd = tmpRepo();
		// Seed the sidecar via the public API so its parent dir exists.
		appendReconciliationTxn(cwd, { finding_id: "seed", action: "touched", by: "x", ts: T });
		const path = reconciliationPath(cwd);
		try {
			// Write-only: appendFileSync (open with O_WRONLY|O_APPEND) still
			// succeeds, but the read tornTailPrefix uses to inspect the last
			// byte fails — its catch must fall back to "" rather than throwing
			// and losing the append.
			chmodSync(path, 0o200);
			appendReconciliationTxn(cwd, { finding_id: "f6", action: "acked", by: "q", ts: T });
		} finally {
			chmodSync(path, 0o644);
		}
		// The append landed (proves the catch returned, instead of the
		// unreadable-file error propagating out of appendReconciliationTxn
		// and skipping the appendFileSync call entirely).
		expect(reconciliationStateOf(loadReconciliation(cwd), "f6")).toBe("acked");
	});

	it("folds to everything-open when the sidecar path cannot be read as a file (unreadable-sidecar catch)", () => {
		const cwd = tmpRepo();
		const path = reconciliationPath(cwd);
		// A directory at the sidecar's exact path: existsSync sees it, but
		// readFileSync on a directory throws (EISDIR) regardless of
		// permissions or uid — loadReconciliation's catch must fold that to
		// "everything open" instead of the error propagating to the caller.
		mkdirSync(path, { recursive: true });
		const map = loadReconciliation(cwd);
		expect(map.size).toBe(0);
		expect(reconciliationStateOf(map, "anything")).toBe("open");
	});
});
