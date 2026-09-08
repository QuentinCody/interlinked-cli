import { describe, expect, it } from "vitest";
import {
	evaluateForbidsAfter,
	evaluateRequiresPrior,
} from "./temporal-matching.js";
import type { SessionTrajectory } from "../types.js";

function session(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "mutation-kill-fixture",
		agent_name: "test-agent",
		started_at: "2026-01-01T00:00:00.000Z",
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		verification_observed: new Set(),
		...overrides,
	};
}

describe("tail() window slicing — mutation kill", () => {
	// test-contract: boundary — a negative within_last_n must still take the
	// full-array early return (mutants 32969a5a/6fe666b0/10fa20ec)
	it("treats a negative window as the full trajectory, not a reversed slice", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: ["Read:x", "Edit:y"] }),
			{ tool: "Read", within_last_n: -1 },
		);
		expect(result.satisfied).toBe(true);
	});

	// test-contract: invariant — `tail()` slices from the END of the array
	// (mutant f7f3a4ba flips the unary sign to slice from the start instead)
	it("slices the tail of the array, not the head", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: ["Edit:a", "Read:b", "Edit:c"] }),
			{ tool: "Read", within_last_n: 1 },
		);
		expect(result.satisfied).toBe(false);
	});
});

describe("toolSequenceMatches() colon split — mutation kill", () => {
	// test-contract: boundary — a colonless tool_sequence entry uses the WHOLE
	// entry as the tool part (mutant 15a0f650 truncates its last character)
	it("uses the full entry as the tool name when there is no colon", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: ["Read"] }), {
			tool: "Rea",
		});
		expect(result.satisfied).toBe(false);
	});

	// test-contract: boundary — a colon at index 0 splits into an EMPTY tool
	// part (mutant 4d6c6b33 treats index-0 as "no colon found")
	it("splits a leading colon into an empty tool part", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [":target"] }), {
			tool: "",
		});
		expect(result.satisfied).toBe(true);
	});
});

describe("bashFieldSatisfied() empty window — mutation kill", () => {
	// test-contract: invariant — an empty command window short-circuits BEFORE
	// the regex is compiled, so an invalid pattern never throws (mutant 93e4c1ba)
	it("never compiles the regex when the command window is empty", () => {
		expect(() =>
			evaluateRequiresPrior(session(), { bash_match: "[" }),
		).not.toThrow();
		const result = evaluateRequiresPrior(session(), { bash_match: "[" });
		expect(result.satisfied).toBe(false);
	});
});

describe("fileReadFieldSatisfied() — mutation kill", () => {
	// test-contract: public-api — a defined, unmatched file_read field is NOT
	// vacuously satisfied (mutant 7f847ff2 always returns satisfied)
	it("reports unsatisfied when the wanted file was never read", () => {
		const result = evaluateRequiresPrior(session(), { file_read: "foo.ts" });
		expect(result.satisfied).toBe(false);
	});

	// test-contract: public-api — the exact-match branch returns the real
	// set-membership result (mutant afa9649c empties the return body)
	it("matches an exact file path via set membership", () => {
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["a.ts"]) }),
			{ file_read: "a.ts" },
		);
		expect(result.satisfied).toBe(true);
	});

	// test-contract: public-api — the glob regex is anchored/derived from the
	// actual pattern, not a catch-all (mutants 62124bfa/8ccc7e2c match everything)
	it("does not match an unrelated file against a glob pattern", () => {
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["other/file.js"]) }),
			{ file_read: "src/*.ts" },
		);
		expect(result.satisfied).toBe(false);
	});
});

describe("globToRegex() star vocabulary — mutation kill", () => {
	// test-contract: boundary — a single `*` stays within one path segment,
	// unlike `**` (mutant 6f493a6f treats every star as cross-segment)
	it("does not let a single-star glob cross a directory separator", () => {
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["src/a/b/config.ts"]) }),
			{ file_read: "src/*/config.ts" },
		);
		expect(result.satisfied).toBe(false);
	});
});

describe("verificationFieldSatisfied() undefined set — mutation kill", () => {
	// test-contract: invariant — an undefined `verification_observed` short-
	// circuits before `.size` is read (mutants e5b5023a/52eff1a1 read it and throw)
	it("never touches .size on an undefined verification set", () => {
		const withoutVerification = session();
		delete withoutVerification.verification_observed;
		expect(() =>
			evaluateRequiresPrior(withoutVerification, { verification_kind: "test" }),
		).not.toThrow();
		const result = evaluateRequiresPrior(withoutVerification, {
			verification_kind: "test",
		});
		expect(result.satisfied).toBe(false);
	});
});

describe("predicateSatisfied() AND-combination — mutation kill", () => {
	// test-contract: invariant — an unsatisfied file_read field fails the
	// overall AND-combination (mutant a58ab767 makes it unconditionally pass)
	it("fails the predicate when only the file_read field is unmet", () => {
		const result = evaluateRequiresPrior(session(), {
			file_read: "nonexistent.ts",
		});
		expect(result.satisfied).toBe(false);
	});
});

describe("describeUnsatisfied() reason assembly — mutation kill", () => {
	// test-contract: public-api — the reason string contains only real gaps,
	// with no seeded prefix (mutant e37e2883 pre-seeds the accumulator)
	it("builds the reason from only the real gaps, with no seeded prefix", () => {
		const result = evaluateRequiresPrior(session(), { bash_match: ".*" });
		expect(result).toEqual({
			satisfied: false,
			reason: "no prior command matching /.*/",
		});
	});

	// test-contract: public-api — a satisfied tool field contributes no "no
	// prior tool call" message (mutants eb2da069/62dced46 push it unconditionally)
	it("omits the tool message once the tool field is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: ["Read:x"], commands_run: [] }),
			{ tool: "Read", bash_match: ".*" },
		);
		expect(result.reason).toBe("no prior command matching /.*/");
	});

	// test-contract: public-api — an unset bash_match/file_read/verification_kind
	// field contributes no message (mutants c6ab0905/920f3c67/fae7155c push
	// unconditionally regardless of whether the field is even set)
	it("reports only the tool gap when the other fields are unset", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [] }), {
			tool: "Read",
		});
		expect(result.reason).toBe("no prior `Read` tool call");
	});

	// test-contract: public-api — a satisfied bash_match field contributes no
	// "no prior command" message (mutant 37601238 pushes it unconditionally)
	it("omits the bash message once the bash field is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({ commands_run: ["run foo now"], files_read: new Set() }),
			{ bash_match: "foo", file_read: "nope.ts" },
		);
		expect(result.reason).toBe("no prior file read matching nope.ts");
	});

	// test-contract: public-api — a defined, unsatisfied file_read field
	// contributes its own message rather than the generic fallback string
	// (mutants a7bdbdf0/b089b032 suppress the push entirely)
	it("reports the specific file_read gap, not the generic fallback", () => {
		const result = evaluateRequiresPrior(session(), { file_read: "nope.ts" });
		expect(result.reason).toBe("no prior file read matching nope.ts");
	});

	// test-contract: public-api — a satisfied file_read field contributes no
	// message (mutant 14979dbf pushes it unconditionally)
	it("omits the file_read message once the file_read field is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: [], files_read: new Set(["a.ts"]) }),
			{ tool: "Read", file_read: "a.ts" },
		);
		expect(result.reason).toBe("no prior `Read` tool call");
	});

	// test-contract: public-api — an unsatisfied verification_kind field pushes
	// its real message text, not the fallback or an empty string (mutants
	// 1b14b614/b9d5d60a/44e84c27/06459507 each break that push differently)
	it("reports the specific verification gap, not the generic fallback", () => {
		const result = evaluateRequiresPrior(session(), {
			verification_kind: "test",
		});
		expect(result.reason).toBe("no prior test verification");
	});

	// test-contract: public-api — a satisfied verification_kind field
	// contributes no message (mutants 04df9ea0/fc2c1ed6 push it unconditionally)
	it("omits the verification message once the verification field is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({
				tool_sequence: [],
				verification_observed: new Set(["test"]),
			}),
			{ tool: "Read", verification_kind: "test" },
		);
		expect(result.reason).toBe("no prior `Read` tool call");
	});

	// test-contract: boundary — a non-positive within_last_n must NOT append
	// the "(within last N actions)" suffix (mutants c159ab5d/61717120/d9629a31
	// force the suffix on unconditionally)
	it("omits the window suffix for a non-positive within_last_n", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [] }), {
			tool: "Read",
			within_last_n: -1,
		});
		expect(result.reason).toBe("no prior `Read` tool call");
	});

	// test-contract: public-api — the join inside the window-suffixed branch
	// uses "; " as the separator (mutant 417ff3c1 drops the separator)
	it("separates multiple gaps with '; ' inside the windowed suffix branch", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: [], commands_run: [] }),
			{ tool: "Read", bash_match: "foo", within_last_n: 5 },
		);
		expect(result.reason).toBe(
			"no prior `Read` tool call; no prior command matching /foo/ (within last 5 actions)",
		);
	});

	// test-contract: public-api — the final unwindowed fallback join uses "; "
	// as the separator (mutant eb54e1a3 drops the separator)
	it("separates multiple gaps with '; ' in the unwindowed fallback", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: [], commands_run: [] }),
			{ tool: "Read", bash_match: "foo" },
		);
		expect(result.reason).toBe(
			"no prior `Read` tool call; no prior command matching /foo/",
		);
	});
});

describe("evaluateForbidsAfter() — sanity", () => {
	// test-contract: public-api — a satisfied predicate must yield satisfied:true
	it("triggers when the forbidden predicate is present", () => {
		const result = evaluateForbidsAfter(
			session({ tool_sequence: ["Bash:ls"] }),
			{ tool: "Bash" },
		);
		expect(result).toEqual({ satisfied: true });
	});
});
