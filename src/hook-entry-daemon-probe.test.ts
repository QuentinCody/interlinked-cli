import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	coldDaemonUnreachableBlockReasonFresh,
	daemonRecoveryRootFresh,
} from "./hook-entry-daemon-probe.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import { makeUnifiedEvent } from "./harness/__tests__/fixtures/unified-event.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "il-cold-probe-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	// A configured repo with a DEAD pid: the sync gate blocks on this.
	writeFileSync(join(root, ".interlinked", "config.json"), "{}");
	writeFileSync(join(root, ".interlinked", "harness.pid"), "999999997");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const EVENT: UnifiedHookEvent = makeUnifiedEvent({
	session_id: "s",
	action: { kind: "file_operation", operation: "write", path: "/x.ts", content: "", tool_class: "modify" },
	context: { cwd: "" },
});

describe("coldDaemonUnreachableBlockReasonFresh — negative (must not block)", () => {
	it("N1: a socket that ANSWERS on the fresh probe cancels the block", async () => {
		const reason = await coldDaemonUnreachableBlockReasonFresh(EVENT, root, {}, {
			listSockets: () => ["/a.sock"],
			probe: () => Promise.resolve(true),
		});
		expect(reason).toBeNull();
	});

	it("N2: the probe is skipped entirely when the sync gate already allows", async () => {
		let probed = 0;
		const clean = mkdtempSync(join(tmpdir(), "il-cold-clean-"));
		mkdirSync(join(clean, ".interlinked"), { recursive: true });
		const reason = await coldDaemonUnreachableBlockReasonFresh(EVENT, clean, {}, {
			listSockets: () => ["/a.sock"],
			probe: () => {
				probed++;
				return Promise.resolve(false);
			},
		});
		rmSync(clean, { recursive: true, force: true });
		expect(reason).toBeNull();
		expect(probed).toBe(0);
	});
});

describe("coldDaemonUnreachableBlockReasonFresh — positive (must block)", () => {
	it("P1: blocks only after the fresh probe fails", async () => {
		let probed = 0;
		const reason = await coldDaemonUnreachableBlockReasonFresh(EVENT, root, {}, {
			listSockets: () => ["/a.sock"],
			probe: () => {
				probed++;
				return Promise.resolve(false);
			},
		});
		expect(probed).toBe(1);
		expect(reason).toContain("BLOCKED");
	});

	it("P2: the message never tells the agent to start a daemon by hand", async () => {
		const reason = await coldDaemonUnreachableBlockReasonFresh(EVENT, root, {}, {
			listSockets: () => [],
			probe: () => Promise.resolve(false),
		});
		expect(reason).not.toContain("interlinked harness start");
		expect(reason).toContain("retry your call");
	});
});

describe("daemonRecoveryRootFresh — zombie recovery", () => {
	it("P: a live pid plus socket file still recovers when the socket does not answer", async () => {
		writeFileSync(join(root, ".interlinked", "harness.pid"), String(process.pid));
		writeFileSync(join(root, ".interlinked", "harness.sock"), "stale");
		let probes = 0;
		const recoveryRoot = await daemonRecoveryRootFresh(EVENT, root, {}, {
			listSockets: () => [join(root, ".interlinked", "harness.sock")],
			probe: () => {
				probes++;
				return Promise.resolve(false);
			},
		});
		expect(probes).toBe(1);
		expect(recoveryRoot).toBe(root);
	});

	it("N: an answering socket suppresses recovery despite stale file evidence", async () => {
		writeFileSync(join(root, ".interlinked", "harness.pid"), String(process.pid));
		writeFileSync(join(root, ".interlinked", "harness.sock"), "placeholder");
		const recoveryRoot = await daemonRecoveryRootFresh(EVENT, root, {}, {
			listSockets: () => [join(root, ".interlinked", "harness.sock")],
			probe: () => Promise.resolve(true),
		});
		expect(recoveryRoot).toBeNull();
	});
});
