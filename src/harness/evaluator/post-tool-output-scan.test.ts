// The PostToolUse output-scan section, extracted from post-tool.ts when the
// per-actor taint threading pushed that file over the line cap. Behavior is
// pinned here at the module boundary; the end-to-end paths stay in
// post-tool.test.ts. Labeled P/N.

import { describe, expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { getDefaultConfig } from "../rules-loader.js";
import { registerActor } from "../taint-lineage.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { collectOutputScanWarnings } from "./post-tool-output-scan.js";

// Built at run time so this source carries no literal key shape.
const AWS = ["AKIA", "IOSFODNN7EXAMPLQ"].join("");

function scan(event: Partial<HarnessEvent>, session: SessionTrajectory, actor?: string): string[] {
	const full: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: "2026-10-05T00:00:00.000Z",
		...event,
	};
	return collectOutputScanWarnings(full, getDefaultConfig(), session, actor);
}

describe("collectOutputScanWarnings — positive (must fire)", () => {
	it("P1: a secret-shaped Bash output ratchets the ACTING actor and its root", () => {
		const session = makeSession();
		registerActor(session, "child-a");
		registerActor(session, "child-b");
		const warnings = scan(
			{ tool_name: "Bash", tool_input: { command: "cat ~/.creds" }, tool_response: `${AWS}[0-9]{16} and padding\n` },
			session,
			"child-a",
		);
		expect(warnings.some((w) => w.includes("[interlinked:output-scan]"))).toBe(true);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("P2: a Read of a labelled path ratchets without emitting a warning line", () => {
		const session = makeSession();
		expect(scan({ tool_name: "Read", tool_input: { file_path: "/srv/app/.env" }, tool_response: "TOKEN=x" }, session)).toEqual([]);
		expect(session.sensitivity_level).toBe("Confidential");
	});
});

describe("collectOutputScanWarnings — negative (must not fire)", () => {
	it("N1: an event with no tool_response scans nothing", () => {
		const session = makeSession();
		expect(scan({ tool_name: "Bash", tool_input: { command: "ls" } }, session)).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("N2: ordinary Bash output leaves the level alone", () => {
		const session = makeSession();
		expect(scan({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a.ts\nb.ts\n" }, session)).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
	});
});
