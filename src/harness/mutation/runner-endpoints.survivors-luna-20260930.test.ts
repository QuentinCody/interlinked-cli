import { describe, expect, it } from "vitest";
import { configuredMaxTestScope, configuredRunnerEndpoints } from "./runner-endpoints.js";

describe("configuredRunnerEndpoints — malformed sibling fields", () => {
	// test-contract: boundary — empty endpoint strings are omitted while a valid sibling endpoint remains usable.
	it("drops empty endpoint values without losing the configured runner", () => {
		const files = new Map([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({
					per_edit_mutation: { runner_url: "", runner_urls: ["http://runner.test", ""] },
				}),
			],
		]);
		expect(configuredRunnerEndpoints("/repo", (path) => files.get(path) ?? null)).toEqual({
			endpoints: ["http://runner.test"],
		});
	});

	// test-contract: invariant — a malformed token field is ignored independently of a valid runner endpoint.
	it("keeps the runner endpoint and omits a non-string token", () => {
		const files = new Map([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({ per_edit_mutation: { runner_url: "http://runner.test", token: 17 } }),
			],
		]);
		expect(configuredRunnerEndpoints("/repo", (path) => files.get(path) ?? null)).toEqual({
			endpoints: ["http://runner.test"],
		});
	});
});

describe("configuredMaxTestScope — local to team fallback", () => {
	// test-contract: public-api — malformed local JSON falls through to a valid shared rules value.
	it("uses the shared scope when the local rules file is malformed", () => {
		const files = new Map<string, string>([
			["/repo/.interlinked/guard-rules.local.json", "{not json"],
			[
				"/repo/.interlinked/guard-rules.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: 40 } }),
			],
		]);
		expect(configuredMaxTestScope("/repo", (path) => files.get(path) ?? null)).toBe(40);
	});

	// test-contract: boundary — a wrong-typed local scope is skipped so a valid team scope can supply the value.
	it("uses the shared scope when the local value is not numeric", () => {
		const files = new Map<string, string>([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: "many" } }),
			],
			[
				"/repo/.interlinked/guard-rules.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: 40 } }),
			],
		]);
		expect(configuredMaxTestScope("/repo", (path) => files.get(path) ?? null)).toBe(40);
	});

	// test-contract: boundary — finite-number validation rejects an overflowing JSON exponent and falls through to team config.
	it("uses the shared scope when the local number overflows to infinity", () => {
		const files = new Map<string, string>([
			["/repo/.interlinked/guard-rules.local.json", '{"per_edit_mutation":{"max_test_scope":1e999}}'],
			[
				"/repo/.interlinked/guard-rules.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: 40 } }),
			],
		]);
		expect(configuredMaxTestScope("/repo", (path) => files.get(path) ?? null)).toBe(40);
	});
});
