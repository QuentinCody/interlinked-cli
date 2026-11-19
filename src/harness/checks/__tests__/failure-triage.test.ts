// Phase 1 Channel 2 — failure-triage tests.
// Pin classify outcomes for ≥3 positive cases per major category, plus
// negative cases that must NOT match a more-specific rule. The TRIAGE_RULES
// table is most-specific-first; this test set guards against accidental
// reordering that would silently regress the classifier.

import { describe, expect, it } from "vitest";
import type { ToolFailureEvent } from "../../types.js";
import { classifyFailure, listTriageRules } from "../failure-triage.js";

function makeEvent(overrides: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	return {
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Edit",
		timestamp: "2026-05-09T00:00:00Z",
		...overrides,
	};
}

describe("classifyFailure — agent-error / TS errors", () => {
	it("classifies TS2307 missing-module as missing-import", () => {
		const r = classifyFailure(makeEvent({
			error_message: "src/foo.ts(3,10): error TS2307: Cannot find module './missing'.",
		}));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("missing-import");
	});
	it("classifies TS2304 missing-name as missing-symbol", () => {
		const r = classifyFailure(makeEvent({
			error_message: "error TS2304: Cannot find name 'foo'.",
		}));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("missing-symbol");
	});
	it("classifies TS2345 as type-mismatch", () => {
		const r = classifyFailure(makeEvent({
			error_message: "error TS2345: Argument of type 'string' is not assignable",
		}));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("type-mismatch");
	});
	it("classifies unknown TS error as type-error", () => {
		const r = classifyFailure(makeEvent({
			error_message: "error TS9999: some weird new error",
		}));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("type-error");
	});
});

// A command that reached its own deadline printed "interrupted"; the classifier
// then told the agent that the USER interrupted it and to wait for instructions.
describe("classifyFailure — own deadline versus user interrupt", () => {
	const ownDeadline = [
		"[resources] Verification interrupted; no verification verdict.\n[resources] CLI interrupted; no verification verdict.",
		'unavailable "<project>" — Verification cancelled by SIGTERM',
		"[resources] CLI interrupted; no verification verdict.",
	];
	it.each(ownDeadline)("classifies a command's own deadline as own-timeout: %s", (stderr) => {
		const r = classifyFailure(makeEvent({ tool_name: "Bash", stderr }));
		expect([r.label, r.category]).toEqual(["transient", "own-timeout"]);
	});

	const namesTheUser = ["[Request interrupted by user]", "Operation was user cancelled", "user aborted the request"];
	it.each(namesTheUser)("keeps user-interrupt for text that names the user: %s", (stderr) => {
		const r = classifyFailure(makeEvent({ tool_name: "Bash", stderr }));
		expect([r.label, r.category]).toEqual(["transient", "user-interrupt"]);
	});

	const programText = [
		"error: Your local changes would be overwritten by merge. Aborting",
		"interrupt handler installed; build failed with 2 errors",
		"Transaction aborted: constraint violation",
	];
	it.each(programText)("does not read program output as a user interrupt: %s", (stderr) => {
		const r = classifyFailure(makeEvent({ tool_name: "Bash", stderr }));
		expect(r.category).not.toBe("user-interrupt");
	});
});

describe("classifyFailure — environmental / filesystem", () => {
	it("classifies ENOENT as filesystem-missing", () => {
		const r = classifyFailure(makeEvent({
			error_message: "ENOENT: no such file or directory, open '/tmp/x'",
		}));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});
	it("classifies EACCES as filesystem-permission", () => {
		const r = classifyFailure(makeEvent({
			error_message: "EACCES: permission denied",
		}));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-permission");
	});
	it("classifies bare 'permission denied' as filesystem-permission", () => {
		const r = classifyFailure(makeEvent({
			tool_name: "Bash",
			error_message: "permission denied",
		}));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-permission");
	});
});

describe("classifyFailure — transient / network + rate-limit", () => {
	it("classifies ECONNREFUSED as network-refused", () => {
		const r = classifyFailure(makeEvent({
			error_message: "connect ECONNREFUSED 127.0.0.1:8080",
		}));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("network-refused");
	});
	it("classifies ETIMEDOUT as network-timeout", () => {
		const r = classifyFailure(makeEvent({
			error_message: "ETIMEDOUT",
		}));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("network-timeout");
	});
	it("classifies HTTP 429 as rate-limit", () => {
		const r = classifyFailure(makeEvent({
			error_message: "Rate limit hit: HTTP 429 Too Many Requests",
		}));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});
});

describe("classifyFailure — unrecoverable", () => {
	it("classifies SIGSEGV as process-crash", () => {
		const r = classifyFailure(makeEvent({
			error_message: "Segmentation fault (core dumped)",
		}));
		expect(r.label).toBe("unrecoverable");
		expect(r.category).toBe("process-crash");
	});
	it("classifies heap OOM as out-of-memory", () => {
		const r = classifyFailure(makeEvent({
			error_message: "FATAL ERROR: heap out of memory",
		}));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("out-of-memory");
	});
});

describe("classifyFailure — negative cases (must NOT misclassify)", () => {
	it("does NOT classify 'TS' in path text as TS error", () => {
		const r = classifyFailure(makeEvent({
			error_message: "wrote /tmp/TS-output.log successfully",
		}));
		expect(r.label).not.toBe("agent-error");
	});
	it("does NOT classify generic 'error' as TS error", () => {
		const r = classifyFailure(makeEvent({
			error_message: "operation completed with error",
		}));
		expect(r.category).not.toBe("type-error");
	});
	it("returns no-diagnostic for empty error", () => {
		const r = classifyFailure(makeEvent({}));
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("no-diagnostic");
	});
	it("returns uncategorized for unmatched non-empty error", () => {
		const r = classifyFailure(makeEvent({
			error_message: "some entirely novel diagnostic that no rule handles",
		}));
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("uncategorized");
	});
});

describe("classifyFailure — haystack composition", () => {
	it("falls back to stderr when error_message is empty", () => {
		const r = classifyFailure(makeEvent({
			tool_name: "Bash",
			stderr: "ENOENT: no such file or directory",
		}));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});
	it("includes tool_input.command for Bash diagnostic-by-command", () => {
		const r = classifyFailure(makeEvent({
			tool_name: "Bash",
			tool_input: { command: "npm install" },
			stderr: "npm ERR! code E429",
		}));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});
});

describe("listTriageRules — registry stability", () => {
	it("exposes a non-empty registry of rules", () => {
		const rules = listTriageRules();
		expect(rules.length).toBeGreaterThan(20);
	});
	it("orders most-specific TS rules before the generic TS catch-all", () => {
		const rules = listTriageRules();
		const ts2307Idx = rules.findIndex((r) => r.match.source.includes("TS2307"));
		const tsCatchAllIdx = rules.findIndex((r) => r.match.source === "\\bTS\\d{4}\\b");
		expect(ts2307Idx).toBeGreaterThanOrEqual(0);
		expect(tsCatchAllIdx).toBeGreaterThan(ts2307Idx);
	});
});
