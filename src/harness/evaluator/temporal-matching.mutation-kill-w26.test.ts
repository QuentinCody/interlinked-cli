import { describe, expect, it } from "vitest";
import {
	evaluateForbidsAfter,
	evaluateRequiresPrior,
} from "./temporal-matching.js";
import type { SessionTrajectory } from "../types.js";

function session(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "mutation-kill-w26-fixture",
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

describe("tail() early-return disjunction — kills 32969a5a/6fe666b0/10fa20ec", () => {
	// test-contract: boundary — a negative within_last_n must take the full-array
	// early return BEFORE the length guard runs, not fall through to a slice
	// (mutants 32969a5ab5e45d64/6fe666b0cf5c2a4d/10fa20ec6ca4fdd6 each remove
	// or invert that early return, causing a real slice(-(-1)) instead)
	it("uses the full trajectory for a negative window, not a one-element tail slice", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: ["Read:x", "Edit:y"] }),
			{ tool: "Read", within_last_n: -1 },
		);
		expect(result.satisfied).toBe(true);
	});
});

describe("tail() slice sign — kills f7f3a4ba", () => {
	// test-contract: invariant — the window slices from the END of the array
	// (mutant f7f3a4ba8150e372 flips the unary minus, slicing from the start)
	it("slices the tail of the array rather than the head", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: ["Edit:a", "Read:b", "Edit:c"] }),
			{ tool: "Read", within_last_n: 1 },
		);
		expect(result.satisfied).toBe(false);
	});
});

describe("toolSequenceMatches() colon split — kills 15a0f650/4d6c6b33", () => {
	// test-contract: boundary — a colonless entry uses the WHOLE entry as the
	// tool part (mutant 15a0f650df852c46 forces the slice(0,colon) branch even
	// when colon is -1, truncating the last character)
	it("uses the full entry as the tool name when there is no colon", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: ["Read"] }), {
			tool: "Rea",
		});
		expect(result.satisfied).toBe(false);
	});

	// test-contract: boundary — a colon at index 0 produces an EMPTY tool part
	// (mutant 4d6c6b331974b5f2 changes `>= 0` to `> 0`, treating index 0 as
	// "no colon found" and keeping the whole ":target" string instead)
	it("splits a leading colon into an empty tool part", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [":target"] }), {
			tool: "",
		});
		expect(result.satisfied).toBe(true);
	});
});

describe("bashFieldSatisfied() empty-window short circuit — kills 93e4c1ba", () => {
	// test-contract: invariant — an empty command window returns false BEFORE
	// the regex is compiled, so an invalid pattern never throws (mutant
	// 93e4c1baa5c41bbb removes the short circuit, forcing regex compilation)
	it("never compiles the regex when the command window is empty", () => {
		expect(() =>
			evaluateRequiresPrior(session(), { bash_match: "[" }),
		).not.toThrow();
		const result = evaluateRequiresPrior(session(), { bash_match: "[" });
		expect(result.satisfied).toBe(false);
	});
});

describe("fileReadFieldSatisfied() undefined-field guard — kills 7f847ff2", () => {
	// test-contract: public-api — a defined, unmatched file_read is NOT
	// vacuously satisfied (mutant 7f847ff2fbd1badd forces the early "undefined"
	// return to always fire, reporting satisfied regardless of the field value)
	it("reports unsatisfied when the wanted file was never read", () => {
		const result = evaluateRequiresPrior(session(), { file_read: "foo.ts" });
		expect(result.satisfied).toBe(false);
	});
});

describe("fileReadFieldSatisfied() glob loop/pattern — kills 62124bfa/8ccc7e2c", () => {
	// test-contract: public-api — an unrelated file must NOT match a glob
	// pattern (mutant 62124bfad562ce41 makes the loop's re.test() always true;
	// mutant 8ccc7e2c4f8cb46b empties the compiled pattern so it matches
	// anything — both would flip this case from unsatisfied to satisfied)
	it("does not match an unrelated file against a glob pattern", () => {
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["other/file.js"]) }),
			{ file_read: "src/*.ts" },
		);
		expect(result.satisfied).toBe(false);
	});
});

describe("globToRegex() star vocabulary — kills 6f493a6f", () => {
	// test-contract: boundary — a single `*` stays within one path segment,
	// unlike `**` (mutant 6f493a6f526d2d6e treats every star as cross-segment)
	it("does not let a single-star glob cross a directory separator", () => {
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["src/a/b/config.ts"]) }),
			{ file_read: "src/*/config.ts" },
		);
		expect(result.satisfied).toBe(false);
	});
});

describe("verificationFieldSatisfied() undefined-observed guard — kills e5b5023a/52eff1a1", () => {
	// test-contract: invariant — an undefined verification_observed short
	// circuits before `.size`/`.has` is read, so it never throws (mutant
	// e5b5023a68560dc5 forces the guard to false; mutant 52eff1a1541253c2
	// flips || to && — both let `.has` run on an undefined set)
	it("never touches an undefined verification set", () => {
		const withoutVerification = session();
		delete (withoutVerification as { verification_observed?: Set<string> })
			.verification_observed;
		expect(() =>
			evaluateRequiresPrior(withoutVerification, { verification_kind: "test" }),
		).not.toThrow();
		const result = evaluateRequiresPrior(withoutVerification, {
			verification_kind: "test",
		});
		expect(result.satisfied).toBe(false);
	});
});

describe("predicateSatisfied() AND-combination — kills a58ab767", () => {
	// test-contract: invariant — an unsatisfied file_read field fails the
	// overall AND-combination (mutant a58ab7679ec1320a suppresses the early
	// return, letting the function fall through to its default `true`)
	it("fails the predicate when only the file_read field is unmet", () => {
		const result = evaluateRequiresPrior(session(), {
			file_read: "nonexistent.ts",
		});
		expect(result.satisfied).toBe(false);
	});
});

describe("describeUnsatisfied() seeded accumulator — kills e37e2883", () => {
	// test-contract: public-api — the missing-reasons array starts empty, with
	// no seeded entry (mutant e37e288363bbee11 seeds it with "Stryker was here")
	it("builds the reason from only the real gaps", () => {
		const result = evaluateRequiresPrior(session(), { bash_match: ".*" });
		expect(result).toEqual({
			satisfied: false,
			reason: "no prior command matching /.*/",
		});
	});
});

describe("describeUnsatisfied() tool-field clause — kills eb2da069/3760123810b29e6f", () => {
	// test-contract: public-api — unset tool and satisfied bash contribute no
	// message, leaving only the real file_read gap (mutants eb2da0693d2f0ac7
	// and 3760123810b29e6f each force their clause to push unconditionally)
	it("reports only the real file_read gap when tool is unset and bash is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({ commands_run: ["run foo now"], files_read: new Set() }),
			{ bash_match: "foo", file_read: "nope.ts" },
		);
		expect(result.reason).toBe("no prior file read matching nope.ts");
	});
});

describe("describeUnsatisfied() tool-field OR mutation — kills 62dced46", () => {
	// test-contract: public-api — a satisfied tool field contributes no message
	// (mutant 62dced4688224cd8 flips && to ||, which short-circuits true purely
	// because pred.tool is defined, regardless of whether it's satisfied)
	it("omits the tool message once the tool field is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: ["Read:x"], commands_run: [] }),
			{ tool: "Read", bash_match: ".*" },
		);
		expect(result.reason).toBe("no prior command matching /.*/");
	});
});

describe("describeUnsatisfied() bash-field clause and file_read suppression — kills c6ab0905/a7bdbdf0/b089b032", () => {
	// test-contract: public-api — an unset bash_match field contributes no
	// message (mutant c6ab0905e409b50e forces the clause to always push,
	// even when pred.bash_match is undefined)
	// The same case also kills a7bdbdf0419f4731 and b089b032bd604041:
	// suppressing the defined, unsatisfied file_read clause loses its message.
	it("reports only the file_read gap when bash_match is unset", () => {
		const result = evaluateRequiresPrior(session(), { file_read: "nope.ts" });
		expect(result.reason).toBe("no prior file read matching nope.ts");
	});
});

describe("describeUnsatisfied() file_read-field clause — kills 920f3c67/fae7155c", () => {
	// test-contract: public-api — unset file_read and verification_kind fields
	// contribute no message (mutant 920f3c6786419ce4 forces the file_read
	// clause to always push; mutant fae7155c064665c8 forces the verification
	// clause to always push — both would add a bogus "undefined" gap)
	it("reports only the tool gap when file_read and verification are unset", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [] }), {
			tool: "Read",
		});
		expect(result.reason).toBe("no prior `Read` tool call");
	});
});

describe("describeUnsatisfied() file_read-field OR mutation — kills 14979dbf", () => {
	// test-contract: public-api — a satisfied file_read field contributes no
	// message (mutant 14979dbf9c7f2002 flips && to ||, pushing purely because
	// pred.file_read is defined)
	it("omits the file_read message once the file_read field is satisfied", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: [], files_read: new Set(["a.ts"]) }),
			{ tool: "Read", file_read: "a.ts" },
		);
		expect(result.reason).toBe("no prior `Read` tool call");
	});
});

describe("describeUnsatisfied() verification-field suppression — kills 1b14b614/b9d5d60a/44e84c27/064e5950", () => {
	// test-contract: public-api — a defined, unsatisfied verification_kind
	// pushes its exact message text (mutants 1b14b61412859d2b/b9d5d60a5813a5bf
	// suppress the push; 44e84c274f47c59f/064e595075968ec4 empty the body or
	// its template, leaving the fallback or an empty string instead)
	it("reports the specific verification gap, not the generic fallback", () => {
		const result = evaluateRequiresPrior(session(), {
			verification_kind: "test",
		});
		expect(result.reason).toBe("no prior test verification");
	});
});

describe("describeUnsatisfied() verification-field OR/negation mutations — kills 04df9ea0/fc2c1ed6", () => {
	// test-contract: public-api — a satisfied verification_kind field
	// contributes no message (mutant 04df9ea0bf59a82c flips && to ||, pushing
	// purely because pred.verification_kind is defined; mutant fc2c1ed601c62fe2
	// drops the `!`, pushing exactly when the field IS satisfied — backwards)
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
});

describe("describeUnsatisfied() within_last_n suffix clause — kills c159ab5d/61717120/d9629a31", () => {
	// test-contract: boundary — a non-positive within_last_n must NOT append
	// the "(within last N actions)" suffix (mutants c159ab5dbd51d23d,
	// 61717120bcc3f36b, d9629a31ea5ff214 each force the suffix clause true)
	it("omits the window suffix for a non-positive within_last_n", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [] }), {
			tool: "Read",
			within_last_n: -1,
		});
		expect(result.reason).toBe("no prior `Read` tool call");
	});
});

describe("describeUnsatisfied() windowed-branch separator — kills 417ff3c1", () => {
	// test-contract: public-api — the windowed-suffix branch joins multiple
	// gaps with "; " (mutant 417ff3c18e9b5ca7 empties that separator literal)
	it("separates multiple gaps with '; ' inside the windowed suffix branch", () => {
		const result = evaluateRequiresPrior(
			session({ tool_sequence: [], commands_run: [] }),
			{ tool: "Read", bash_match: "foo", within_last_n: 5 },
		);
		expect(result.reason).toBe(
			"no prior `Read` tool call; no prior command matching /foo/ (within last 5 actions)",
		);
	});
});

describe("describeUnsatisfied() unwindowed-fallback separator — kills eb54e1a3", () => {
	// test-contract: public-api — the unwindowed fallback join also uses "; "
	// as the separator (mutant eb54e1a30b1d9b7e empties that separate literal,
	// a distinct site from the windowed-branch one above)
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
	// test-contract: public-api — a satisfied predicate must yield
	// satisfied:true with no reason field on the forbids_after axis
	it("triggers when the forbidden predicate is present", () => {
		const result = evaluateForbidsAfter(
			session({ tool_sequence: ["Bash:ls"] }),
			{ tool: "Bash" },
		);
		expect(result).toEqual({ satisfied: true });
	});
});
