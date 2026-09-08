// Tests for the (not-yet-wired — see module header) commit-time
// registry-parity backstop. Modeled directly on
// commit-baseline-gate.integration.test.ts's real-ephemeral-git-repo
// fixture, since the gate shells out to `git show`/`git rev-parse`.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REGISTRY_PARITY_CONFIG_PATH } from "../registry-parity.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	checkCommitRegistryParityGate,
	runCommitRegistryParityGate,
} from "./commit-registry-parity-gate.js";

let root: string;

function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function writeFile(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

function writeConfig(config: unknown): void {
	writeFile(REGISTRY_PARITY_CONFIG_PATH, JSON.stringify(config));
}

function pairConfig(extra: Record<string, unknown> = {}) {
	return {
		pairs: [
			{
				name: "test-pair",
				left: { file: "left.ts", key_re: 'check:\\s*"([a-z]+)"' },
				right: { file: "right.ts", key_re: 'check:\\s*"([a-z]+)"' },
				...extra,
			},
		],
	};
}

function commitEvent(command: string, cwd = root): HarnessEvent {
	return ({
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-21T00:00:00.000Z",
		cwd,
	} satisfies HarnessEvent);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "commit-registry-parity-"));
	git("init", "-q");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("checkCommitRegistryParityGate", () => {
	// --- positive (must fire) ---

	it("P1: warns (does not block) on a staged drifted pair, naming both files + the id", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		const d = checkCommitRegistryParityGate(commitEvent('git commit -m "x"'));
		expect(d).not.toBeNull();
		expect(d?.decision).toBe("allow");
		const joined = (d?.warnings ?? []).join("\n");
		expect(joined).toContain("left.ts");
		expect(joined).toContain("right.ts");
		expect(joined).toContain("beta");
	});

	it("P2: compares the STAGED blob, not the working tree — an unstaged fix still warns", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		// Fix the drift in the WORKING TREE only — never re-staged.
		writeFile("right.ts", 'check: "alpha"\ncheck: "beta"');
		const d = checkCommitRegistryParityGate(commitEvent('git commit -m "x"'));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.length).toBeGreaterThan(0);
	});

	it("P3: an id covered by left_only_allowed does not warn", () => {
		writeConfig(pairConfig({ left_only_allowed: ["beta"] }));
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		expect(checkCommitRegistryParityGate(commitEvent('git commit -m "x"'))).toBeNull();
	});

	// --- negative (must not fire) ---

	it("N1: a pair already in sync at the staged ref is a no-op", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"\ncheck: "beta"');
		git("add", "-A");
		expect(checkCommitRegistryParityGate(commitEvent('git commit -m "x"'))).toBeNull();
	});

	it("N2: no .interlinked/registry-parity.json present is a no-op", () => {
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		git("add", "-A");
		expect(checkCommitRegistryParityGate(commitEvent('git commit -m "x"'))).toBeNull();
	});

	it("N3: is a no-op for a non-commit command", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		expect(checkCommitRegistryParityGate(commitEvent("git status"))).toBeNull();
	});

	it("N4: a pair whose file was never staged (not tracked at all) is a no-op", () => {
		writeConfig(pairConfig());
		// Neither left.ts nor right.ts ever created/staged — an unrelated commit.
		writeFile("unrelated.ts", "export const x = 1;");
		git("add", "-A");
		expect(checkCommitRegistryParityGate(commitEvent('git commit -m "x"'))).toBeNull();
	});

	it("N5: fail-opens outside a git repo", () => {
		const bare = mkdtempSync(join(tmpdir(), "commit-registry-parity-nogit-"));
		try {
			expect(checkCommitRegistryParityGate(commitEvent('git commit -m "x"', bare))).toBeNull();
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("N6: never returns a block decision, even with many drifted ids", () => {
		writeConfig(pairConfig());
		const ids = ["a", "b", "c", "d", "e", "f"];
		writeFile("left.ts", ids.map((id) => `check: "${id}"`).join("\n"));
		writeFile("right.ts", "");
		git("add", "-A");
		const d = checkCommitRegistryParityGate(commitEvent('git commit -m "x"'));
		expect(d?.decision).toBe("allow");
	});
});

describe("runCommitRegistryParityGate (pipeline wrapper — mutate in place, never short-circuit)", () => {
	it("merges its warning onto preDecision.warnings and returns void", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		const preDecision: HarnessDecision = { decision: "allow", warnings: ["existing"] };
		const ret = runCommitRegistryParityGate(commitEvent('git commit -m "x"'), preDecision);
		expect(ret).toBeUndefined();
		expect(preDecision.decision).toBe("allow");
		expect(preDecision.warnings?.[0]).toBe("existing");
		expect(preDecision.warnings?.length).toBeGreaterThan(1);
	});

	it("does nothing when the running decision is not allow (a block stays a block, untouched)", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		const preDecision: HarnessDecision = { decision: "block", reason: "other gate" };
		runCommitRegistryParityGate(commitEvent('git commit -m "x"'), preDecision);
		expect(preDecision).toEqual({ decision: "block", reason: "other gate" });
	});

	it("does nothing for a non-Bash tool", () => {
		writeConfig(pairConfig());
		const preDecision: HarnessDecision = { decision: "allow" };
		const ev = ({  ...commitEvent('git commit -m "x"'), tool_name: "Write" } satisfies HarnessEvent);
		runCommitRegistryParityGate(ev, preDecision);
		expect(preDecision.warnings).toBeUndefined();
	});

	it("leaves warnings untouched (does not set an empty array) when nothing drifted", () => {
		writeConfig(pairConfig());
		writeFile("left.ts", 'check: "alpha"');
		writeFile("right.ts", 'check: "alpha"');
		git("add", "-A");
		const preDecision: HarnessDecision = { decision: "allow" };
		runCommitRegistryParityGate(commitEvent('git commit -m "x"'), preDecision);
		expect(preDecision.warnings).toBeUndefined();
	});
});
