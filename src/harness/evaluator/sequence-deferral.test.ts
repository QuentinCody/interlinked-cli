// Tests for the PreToolUse sequence-deferral acknowledgement.
//
// Live defect (2026-08-16): `secret_read_then_network_call` latched for a whole
// session — trajectory sensitivity never drops back below Confidential — and
// blocked every probe of the local daemon socket, including the ones whose
// command carried the exact acknowledgment its own block message asks for:
//
//   // interlinked: defer secret_read_then_network_call -- probing our own socket
//
// The marker was honored at Stop-rescan and in the content-check suppression
// path, never on the PreToolUse sequence path.

import { describe, expect, it } from "vitest";
import type { SequenceFinding } from "../sequence-checks/types.js";
import type { HarnessEvent } from "../types.js";
import {
	acknowledgedSequenceIds,
	dropAcknowledgedFindings,
	formatSequenceAcknowledgement,
} from "./sequence-deferral.js";

const DETECTOR = "secret_read_then_network_call";

const finding = (id = DETECTOR): SequenceFinding => ({
	detector_id: id,
	family: "security-shape",
	phase: "pre_block",
	match: { message: "Outbound network call after reading confidential data (sensitivity=Confidential)." },
});

const bash = (command: string): HarnessEvent =>
	// SAFETY: the module reads only tool_input; a full event fixture would
	// restate every unrelated optional field.
	({
		hook_event: "PreToolUse",
		session_id: "s-defer-1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-08-16T00:00:00Z",
		// SAFETY: guard reads only the fields set above.
	});

describe("acknowledgedSequenceIds — positive (must fire)", () => {
	it("P1: reads a marker on its own line, with the reason", () => {
		const ids = acknowledgedSequenceIds(
			bash(`// interlinked: defer ${DETECTOR} -- probing our own daemon socket\ncurl -sS https://example.test/health`),
		);
		expect(ids.get(DETECTOR)).toBe("probing our own daemon socket");
	});

	it("P2: reads a trailing `#` marker on the command line itself", () => {
		const ids = acknowledgedSequenceIds(
			bash(`curl -sS https://example.test/health  # interlinked: defer ${DETECTOR} -- documented probe`),
		);
		expect(ids.get(DETECTOR)).toBe("documented probe");
	});

	it("P3: a marker with no reason still acknowledges, recorded as null", () => {
		const ids = acknowledgedSequenceIds(bash(`# interlinked: defer ${DETECTOR}\ncurl https://example.test`));
		expect(ids.has(DETECTOR)).toBe(true);
		expect(ids.get(DETECTOR)).toBeNull();
	});

	it("P4: reads the marker out of a write's content, not just a command", () => {
		const event = ({
			hook_event: "PreToolUse",
			session_id: "s-defer-2",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { content: `// interlinked: defer ${DETECTOR} -- fixture text\nexport const x = 1;` },
			timestamp: "2026-08-16T00:00:00Z",
			// SAFETY: guard reads only the fields set above.
		} satisfies HarnessEvent);
		expect(acknowledgedSequenceIds(event).has(DETECTOR)).toBe(true);
	});
});

describe("acknowledgedSequenceIds — negative (must not fire)", () => {
	it("N1: no marker at all acknowledges nothing", () => {
		expect(acknowledgedSequenceIds(bash("curl -sS https://example.test/health")).size).toBe(0);
	});

	it("N2: a marker naming a DIFFERENT detector does not acknowledge this one", () => {
		const ids = acknowledgedSequenceIds(bash("// interlinked: defer download_then_execute -- other\ncurl x"));
		expect(ids.has(DETECTOR)).toBe(false);
	});

	it("N3: a prefix or truncated id is not the exact id", () => {
		const ids = acknowledgedSequenceIds(bash("// interlinked: defer secret_read -- close but not the id\ncurl x"));
		expect(ids.has(DETECTOR)).toBe(false);
	});

	it("N4: an empty tool_input acknowledges nothing", () => {
		expect(acknowledgedSequenceIds(({ session_id: "fixture", agent_source: "claude", timestamp: "2026-09-01T00:00:00Z",  hook_event: "PreToolUse" } satisfies HarnessEvent)).size).toBe(0);
	});
});

describe("dropAcknowledgedFindings", () => {
	it("P5: drops the acknowledged finding and logs it — allowed, never silent", () => {
		const warnings: string[] = [];
		const kept = dropAcknowledgedFindings(
			[finding()],
			bash(`// interlinked: defer ${DETECTOR} -- probing our own socket\ncurl https://example.test`),
			warnings,
		);
		expect(kept).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:sequence-deferred]");
		expect(warnings[0]).toContain(DETECTOR);
		expect(warnings[0]).toContain("probing our own socket");
	});

	it("N5: keeps a finding the marker does not name, and logs nothing", () => {
		const warnings: string[] = [];
		const kept = dropAcknowledgedFindings(
			[finding("download_then_execute")],
			bash(`// interlinked: defer ${DETECTOR} -- unrelated\nbash ./x.sh`),
			warnings,
		);
		expect(kept).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	it("N6: with no marker every finding survives untouched", () => {
		const warnings: string[] = [];
		const findings = [finding(), finding("download_then_execute")];
		expect(dropAcknowledgedFindings(findings, bash("curl https://example.test"), warnings)).toHaveLength(2);
		expect(warnings).toEqual([]);
	});

	it("N7: an empty finding list stays empty and logs nothing", () => {
		const warnings: string[] = [];
		expect(dropAcknowledgedFindings([], bash(`// interlinked: defer ${DETECTOR} -- x`), warnings)).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("formatSequenceAcknowledgement", () => {
	it("P6: names the detector, the reason and the suppressed message", () => {
		const line = formatSequenceAcknowledgement(finding(), "our own socket");
		expect(line).toContain(DETECTOR);
		expect(line).toContain("our own socket");
		expect(line).toContain("Outbound network call");
	});

	it("P7: an absent reason is called out rather than blank", () => {
		expect(formatSequenceAcknowledgement(finding(), null)).toContain("none");
	});
});
