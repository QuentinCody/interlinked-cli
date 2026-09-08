import { describe, expect, it } from "vitest";
import type {
	RecoveryContext,
	RecoverySuggestion,
	ToolFailureEvent,
	TriageLabel,
	TriageResult,
} from "../types.js";
import { listRecoveryKeys, suggestRecovery } from "./recovery-suggestion.js";

// ---------------------------------------------------------------------------
// Fixtures — built minimally to satisfy exactOptionalPropertyTypes (omit keys
// for absent optional fields rather than setting them to undefined).
// ---------------------------------------------------------------------------

function makeEvent(over: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	const base: ToolFailureEvent = {
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		timestamp: "2026-06-06T00:00:00Z",
	};
	return { ...base, ...over };
}

function makeTriage(label: TriageLabel, category: string): TriageResult {
	return {
		label,
		category,
		confidence: 0.9,
		source: "local-heuristic",
	};
}

describe("listRecoveryKeys", () => {
	it("returns the exact set of `${label}/${category}` template keys", () => {
		const keys = listRecoveryKeys();
		// Spot-check representative keys from each label group.
		expect(keys).toContain("agent-error/missing-import");
		expect(keys).toContain("agent-error/missing-symbol");
		expect(keys).toContain("agent-error/type-mismatch");
		expect(keys).toContain("agent-error/missing-package");
		expect(keys).toContain("environmental/filesystem-missing");
		expect(keys).toContain("transient/network-refused");
		expect(keys).toContain("transient/rate-limit");
		expect(keys).toContain("unrecoverable/process-crash");
		expect(keys).toContain("unrecoverable/process-killed");
	});

	it("returns 26 templates and no duplicates", () => {
		const keys = listRecoveryKeys();
		expect(keys.length).toBe(26);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("every key is of the form label/category", () => {
		for (const k of listRecoveryKeys()) {
			expect(k).toMatch(/^[a-z-]+\/[a-z-]+$/);
		}
	});
});

describe("suggestRecovery — templates with extracted context (missing-import)", () => {
	it("fills symbol + module from a real `Cannot find module` message", () => {
		// extract only captures `module`; `symbol` falls back to placeholder.
		const event = makeEvent({
			error_message: `Cannot find module 'lodash'`,
		});
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).not.toBeNull();
		expect(out).toContain('from "lodash"');
		expect(out).toContain("<symbol>"); // symbol not captured → placeholder branch
		expect(out).toContain("npm ls lodash");
	});

	it("uses double-quoted module form in the source message too", () => {
		const event = makeEvent({ error_message: `Cannot find module "@scope/pkg"` });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain('from "@scope/pkg"');
		expect(out).toContain("npm ls @scope/pkg");
	});

	it("falls back to <module> placeholder when extractor does not match", () => {
		// error text present but no `Cannot find module` → extract returns null →
		// ctx.module stays unset → template uses the `?? \"<module>\"` branch.
		const event = makeEvent({ error_message: "some unrelated error" });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("<module>");
		expect(out).toContain("<symbol>");
		expect(out).toContain("npm ls <module>");
	});
});

describe("suggestRecovery — templates with extracted context (missing-symbol)", () => {
	it("fills symbol from a `Cannot find name` message (unquoted)", () => {
		const event = makeEvent({ error_message: "Cannot find name foo" });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-symbol"));
		expect(out).toContain("`foo`");
		expect(out).toContain("isn't in scope");
	});

	it("fills symbol from a quoted `Cannot find name` message", () => {
		const event = makeEvent({ error_message: `Cannot find name 'MyType'` });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-symbol"));
		expect(out).toContain("`MyType`");
	});

	it("falls back to <symbol> placeholder when no name is present", () => {
		const event = makeEvent({ error_message: "totally different text" });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-symbol"));
		expect(out).toContain("<symbol>");
	});
});

describe("suggestRecovery — templates with extracted context (missing-package)", () => {
	it("fills module from extracted context (uses error stderr path)", () => {
		// missing-package has no `extract`, so ctx.module only comes from a
		// suggestion.extract — there is none → always the placeholder branch.
		const event = makeEvent({ stderr: "404 Not Found" });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-package"));
		expect(out).toContain("<package>");
		expect(out).toContain("npm view <package>");
	});
});

describe("suggestRecovery — static templates (no context interpolation)", () => {
	const cases: ReadonlyArray<[TriageLabel, string, string]> = [
		["agent-error", "type-mismatch", "argument type doesn't match"],
		["agent-error", "missing-property", "property doesn't exist on the type"],
		["agent-error", "unused-declaration", "Declared but never used"],
		["agent-error", "type-error", "TypeScript compiler rejected this"],
		["agent-error", "git-conflict", "Merge conflict in the working tree"],
		["agent-error", "pre-commit", "pre-commit hook failed"],
		["agent-error", "test-failure", "Tests are failing"],
		["agent-error", "assertion", "Assertion failed"],
		["agent-error", "auth", "Authentication failed"],
		["agent-error", "dns-resolution", "DNS lookup failed"],
		["agent-error", "package-script", "package script"],
		["agent-error", "filesystem-shape", "Filesystem state mismatch"],
		["environmental", "filesystem-missing", "File or directory doesn't exist"],
		["environmental", "filesystem-permission", "Permission denied"],
		["environmental", "git-state", "Not a git repository"],
		["environmental", "out-of-memory", "ran out of heap"],
		["transient", "network-refused", "Connection refused"],
		["transient", "network-timeout", "Connection timed out"],
		["transient", "dns", "EAI_AGAIN"],
		["transient", "rate-limit", "Rate-limited"],
		["transient", "user-interrupt", "user interrupted the call"],
		["unrecoverable", "process-crash", "process crashed"],
		["unrecoverable", "process-killed", "Process was killed"],
	];

	for (const [label, category, needle] of cases) {
		it(`${label}/${category} → returns its template text`, () => {
			const out = suggestRecovery(makeEvent(), makeTriage(label, category));
			expect(out).not.toBeNull();
			expect(out).toContain(needle);
		});
	}
});

describe("suggestRecovery — fallback by label (no template match)", () => {
	it("agent-error unknown category → agent-side fallback", () => {
		const out = suggestRecovery(makeEvent(), makeTriage("agent-error", "no-such-cat"));
		expect(out).toContain("agent-side mistake");
	});

	it("environmental unknown category → environment fallback", () => {
		const out = suggestRecovery(makeEvent(), makeTriage("environmental", "no-such-cat"));
		expect(out).toContain("environment problem");
	});

	it("transient unknown category → transient fallback", () => {
		const out = suggestRecovery(makeEvent(), makeTriage("transient", "no-such-cat"));
		expect(out).toContain("This looks transient");
	});

	it("unrecoverable unknown category → unrecoverable fallback", () => {
		const out = suggestRecovery(makeEvent(), makeTriage("unrecoverable", "no-such-cat"));
		expect(out).toContain("unrecoverable from the agent side");
	});

	it("unknown label with empty fallback string → returns null (|| null branch)", () => {
		// FALLBACK_BY_LABEL.unknown === "" → `"" || null` → null.
		const out = suggestRecovery(makeEvent(), makeTriage("unknown", "anything"));
		expect(out).toBeNull();
	});

	it("label with no fallback entry at all → returns null", () => {
		const triage = makeTriage("agent-error", "x");
		// SAFETY: the invalid triage label deliberately exercises the missing-fallback branch outside the declared label union.
		const bogus: TriageResult = { ...triage, label: "not-a-real-label" as TriageLabel };
		const out = suggestRecovery(makeEvent(), bogus);
		expect(out).toBeNull();
	});
});

describe("suggestRecovery — happy path returns template (try succeeds, catch not taken)", () => {
	it("returns the template output when the matched template does not throw", () => {
		const out = suggestRecovery(
			makeEvent({ error_message: "Cannot find module 'x'" }),
			makeTriage("agent-error", "missing-import"),
		);
		expect(out).not.toBeNull();
		expect(out).toContain("Add the missing import");
		expect(out).toContain("from \"x\"");
	});
});

describe("buildContext (exercised via suggestRecovery) — error text source precedence", () => {
	it("prefers error_message over stderr", () => {
		// extract reads from errorText; error_message wins → module captured.
		const event = makeEvent({
			error_message: `Cannot find module 'from-error-message'`,
			stderr: `Cannot find module 'from-stderr'`,
		});
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from-error-message");
		expect(out).not.toContain("from-stderr");
	});

	it("falls back to stderr when error_message is absent", () => {
		const event = makeEvent({ stderr: `Cannot find module 'from-stderr'` });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from-stderr");
	});

	it("uses empty error text when both error_message and stderr are absent", () => {
		// errorText === "" → suggestion.extract is skipped (errorText falsy) →
		// module placeholder branch.
		const event = makeEvent();
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("<module>");
	});
});

describe("buildContext — file_path extraction from tool_input", () => {
	// file is never read by any current template, but buildContext branches on it.
	// We exercise the branches and assert suggestRecovery still produces output,
	// which requires buildContext to have run to completion without throwing.
	it("handles tool_input with a string file_path (if filePath branch)", () => {
		const event = makeEvent({
			tool_input: { file_path: "src/foo.ts" },
			error_message: `Cannot find module 'm'`,
		});
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from \"m\"");
	});

	it("handles tool_input with a non-string file_path (ternary false branch)", () => {
		const event = makeEvent({
			tool_input: { file_path: 123 },
			error_message: `Cannot find module 'm'`,
		});
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from \"m\"");
	});

	it("handles tool_input present without file_path key", () => {
		const event = makeEvent({
			tool_input: { command: "ls" },
			error_message: `Cannot find module 'm'`,
		});
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from \"m\"");
	});

	it("handles absent tool_input (left side of && short-circuits)", () => {
		const event = makeEvent({ error_message: `Cannot find module 'm'` });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from \"m\"");
	});
});

describe("buildContext — extract group filtering", () => {
	it("only copies string-valued named groups into context", () => {
		// The real `missing-symbol` extractor has exactly one named group; this
		// asserts the `typeof value === \"string\"` guard passes it through.
		const event = makeEvent({ error_message: `Cannot find name 'KeptSymbol'` });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-symbol"));
		expect(out).toContain("`KeptSymbol`");
	});

	it("does not throw when extractor matches but with no named groups path", () => {
		// missing-import extractor always names `module`; when it matches we still
		// route through the `match?.groups` truthy branch.
		const event = makeEvent({ error_message: `Cannot find module 'g'` });
		const out = suggestRecovery(event, makeTriage("agent-error", "missing-import"));
		expect(out).toContain("from \"g\"");
	});
});

// ---------------------------------------------------------------------------
// Type-shape compile guards (no runtime assertions needed beyond construction):
// confirm the exported types are usable as documented.
// ---------------------------------------------------------------------------
describe("type surface", () => {
	it("RecoverySuggestion + RecoveryContext are constructible", () => {
		const ctx: RecoveryContext = { tool: "Bash", error: "" };
		const s: RecoverySuggestion = { template: (c) => c.tool };
		expect(s.template(ctx)).toBe("Bash");
	});
});
