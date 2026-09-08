// Phase 1 Channel 6 — failure-cause explanation tests.
// Behavioral coverage of explainFailure + listExplanationKeys (and the
// internal buildContext, exercised through explainFailure): every template
// branch, every fallback-by-label branch, the catch-and-fall-through path,
// and every context-extraction branch (module / symbol / file / error
// source / empty-error short-circuit).

import { describe, expect, it } from "vitest";
import type { ToolFailureEvent, TriageResult } from "../types.js";
import {
	explainFailure,
	listExplanationKeys,
} from "./failure-explanation.js";

function makeEvent(overrides: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	return {
		session_id: "s",
		agent_source: "claude",
		tool_name: "Edit",
		timestamp: "2026-05-09T00:00:00Z",
		...overrides,
	};
}

const triage = (
	label: TriageResult["label"],
	category: string,
): TriageResult => ({
	label,
	category,
	confidence: 0.85,
	source: "local-heuristic",
});

describe("listExplanationKeys", () => {
	it("returns exactly the 13 registered template keys", () => {
		const keys = listExplanationKeys();
		expect(keys).toEqual([
			"agent-error/missing-import",
			"agent-error/missing-symbol",
			"agent-error/type-mismatch",
			"agent-error/missing-property",
			"agent-error/unused-declaration",
			"agent-error/git-conflict",
			"agent-error/test-failure",
			"agent-error/auth",
			"environmental/filesystem-missing",
			"environmental/filesystem-permission",
			"transient/network-refused",
			"transient/rate-limit",
			"unrecoverable/process-crash",
		]);
	});

	it("every listed key resolves to a non-empty explanation", () => {
		for (const key of listExplanationKeys()) {
			const slash = key.indexOf("/");
			const label = (["agent-error", "environmental", "transient", "unrecoverable", "unknown"] as const).find((candidate) => candidate === key.slice(0, slash));
			if (!label) throw new Error(`Unexpected explanation label: ${key}`);
			const category = key.slice(slash + 1);
			const out = explainFailure(makeEvent(), triage(label, category));
			expect(out, key).toBeTruthy();
			expect(typeof out, key).toBe("string");
		}
	});
});

describe("explainFailure — context-substituting templates", () => {
	it("missing-import: substitutes the extracted module name", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find module './widget'" }),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`./widget`");
		expect(out).toContain("couldn't be resolved");
	});

	it("missing-import: falls back to <module> placeholder when unextractable", () => {
		const out = explainFailure(
			makeEvent({ error_message: "some unrelated compiler error" }),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`<module>`");
	});

	it("missing-symbol: substitutes the extracted symbol name", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find name 'fooBar'" }),
			triage("agent-error", "missing-symbol"),
		);
		expect(out).toContain("`fooBar`");
		expect(out).toContain("isn't a known name in this scope");
	});

	it("missing-symbol: falls back to <symbol> placeholder when unextractable", () => {
		const out = explainFailure(
			makeEvent({ error_message: "unrelated" }),
			triage("agent-error", "missing-symbol"),
		);
		expect(out).toContain("`<symbol>`");
	});
});

describe("explainFailure — static templates", () => {
	const cases: Array<[string, RegExp]> = [
		["type-mismatch", /declared type doesn't match/],
		["missing-property", /doesn't exist on the type's known shape/],
		["unused-declaration", /declared identifier was never referenced/],
		["git-conflict", /Two histories disagreed/],
		["test-failure", /assertion the test expressed/],
		["auth", /provider rejected the credential/],
	];
	for (const [category, re] of cases) {
		it(`agent-error/${category} emits its template`, () => {
			const out = explainFailure(
				makeEvent(),
				triage("agent-error", category),
			);
			expect(out).toMatch(re);
		});
	}

	it("environmental/filesystem-missing emits its template", () => {
		expect(
			explainFailure(makeEvent(), triage("environmental", "filesystem-missing")),
		).toMatch(/No file\/directory exists at the path/);
	});

	it("environmental/filesystem-permission emits its template", () => {
		expect(
			explainFailure(
				makeEvent(),
				triage("environmental", "filesystem-permission"),
			),
		).toMatch(/The OS denied write access/);
	});

	it("transient/network-refused emits its template", () => {
		expect(
			explainFailure(makeEvent(), triage("transient", "network-refused")),
		).toMatch(/refused the connection/);
	});

	it("transient/rate-limit emits its template", () => {
		expect(
			explainFailure(makeEvent(), triage("transient", "rate-limit")),
		).toMatch(/rate-limit signal/);
	});

	it("unrecoverable/process-crash emits its template", () => {
		expect(
			explainFailure(makeEvent(), triage("unrecoverable", "process-crash")),
		).toMatch(/subprocess crashed with a non-graceful signal/);
	});
});

describe("explainFailure — fallback-by-label (no matching template)", () => {
	it("agent-error label with unknown category returns the agent-error fallback", () => {
		const out = explainFailure(
			makeEvent(),
			triage("agent-error", "no-such-category"),
		);
		expect(out).toContain("mistake on the agent side");
	});

	it("environmental label with unknown category returns the environmental fallback", () => {
		const out = explainFailure(
			makeEvent(),
			triage("environmental", "no-such-category"),
		);
		expect(out).toContain("environment issue rather than a code defect");
	});

	it("transient label with unknown category returns the transient fallback", () => {
		const out = explainFailure(
			makeEvent(),
			triage("transient", "no-such-category"),
		);
		expect(out).toContain("transient infrastructure flakes");
	});

	it("unrecoverable label with unknown category returns the unrecoverable fallback", () => {
		const out = explainFailure(
			makeEvent(),
			triage("unrecoverable", "no-such-category"),
		);
		expect(out).toContain("hard stop");
	});

	it("unknown label returns null (empty-string fallback short-circuits via `|| null`)", () => {
		expect(
			explainFailure(makeEvent(), triage("unknown", "anything")),
		).toBeNull();
	});

	it("label absent from FALLBACK_BY_LABEL returns null (undefined fallback)", () => {
		// SAFETY: the invalid label deliberately exercises missing-fallback handling outside the declared triage-label union.
		const bogus = { ...triage("agent-error", "x"), label: "totally-made-up" as unknown as TriageResult["label"] };
		expect(explainFailure(makeEvent(), bogus)).toBeNull();
	});
});

describe("explainFailure — catch-and-fall-through (template throws)", () => {
	it("falls back to the label fallback when context-building throws", () => {
		// A throwing getter on tool_input.file_path makes buildContext throw
		// inside the try, so explainFailure swallows it and returns the
		// agent-error label fallback instead of crashing the channel.
		const event = makeEvent({ error_message: "Cannot find module './m'" });
		Object.defineProperty(event, "tool_input", {
			get() {
				throw new Error("boom");
			},
			enumerable: true,
			configurable: true,
		});
		const out = explainFailure(event, triage("agent-error", "missing-import"));
		expect(out).toContain("mistake on the agent side");
	});
});

describe("buildContext (via explainFailure) — error-source + extraction branches", () => {
	it("uses stderr when error_message is absent", () => {
		const out = explainFailure(
			makeEvent({ stderr: "Cannot find module 'from-stderr'" }),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`from-stderr`");
	});

	it("prefers error_message over stderr when both are present", () => {
		const out = explainFailure(
			makeEvent({
				error_message: "Cannot find module 'from-message'",
				stderr: "Cannot find module 'from-stderr'",
			}),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`from-message`");
		expect(out).not.toContain("from-stderr");
	});

	it("empty error text short-circuits extraction → placeholder module", () => {
		// Neither error_message nor stderr → ctx.error = "" → `if (errorText)`
		// is false, regexes never run, template gets <module>.
		const out = explainFailure(
			makeEvent(),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`<module>`");
	});

	it("error text present but no module match → placeholder module", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find name 'X'" }),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`<module>`");
	});

	it("error text present but no symbol match → placeholder symbol", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find module './only-module'" }),
			triage("agent-error", "missing-symbol"),
		);
		expect(out).toContain("`<symbol>`");
	});

	it("symbol extraction handles the unquoted variant", () => {
		// /Cannot find name ['\"]?([^'\"\\s]+)['\"]?/ — no quotes around name.
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find name bareName here" }),
			triage("agent-error", "missing-symbol"),
		);
		expect(out).toContain("`bareName`");
	});

	// The file-path extraction branch in buildContext has no observable effect
	// on any template's output (no template reads ctx.file), so it's exercised
	// for branch execution only — assert it doesn't change the resolved text and
	// doesn't throw across all three tool_input shapes.
	it("tool_input with a string file_path is handled (file branch taken)", () => {
		const out = explainFailure(
			makeEvent({
				error_message: "Cannot find module './m'",
				tool_input: { file_path: "/abs/path.ts" },
			}),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`./m`");
	});

	it("tool_input with a non-string file_path is handled (file branch skipped)", () => {
		const out = explainFailure(
			makeEvent({
				error_message: "Cannot find module './m'",
				tool_input: { file_path: 123 },
			}),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`./m`");
	});

	it("tool_input absent is handled (file branch skipped)", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find module './m'" }),
			triage("agent-error", "missing-import"),
		);
		expect(out).toContain("`./m`");
	});
});
