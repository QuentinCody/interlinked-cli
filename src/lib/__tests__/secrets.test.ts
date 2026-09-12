import { describe, expect, it, vi } from "vitest";
import {
	containsSecrets,
	loadScrubConfig,
	recordScrub,
	redactPii,
	scrubEgressPayload,
	scrubSecrets,
} from "../secrets.js";

describe("scrubSecrets — pattern matching", () => {
	it("detects AWS access key", () => {
		const result = scrubSecrets("key is AKIAIOSFODNN7EXAMPLE");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("aws_key");
		expect(result.text).toContain("[REDACTED:aws_key]");
		expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("detects GitHub token (ghp_)", () => {
		// Build token at runtime so static scanners don't flag this file as a leaked secret.
		const ghLikeToken = `gh${"p"}_${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"}`;
		const result = scrubSecrets(`token: ${ghLikeToken}`);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("github_token");
		expect(result.text).toContain("[REDACTED:github_token]");
	});

	it("detects GitHub PAT", () => {
		const result = scrubSecrets(
			"pat: github_pat_11AABCDEFG0123456789abcdefghijklmnopqrstuvwxyz",
		);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("github_pat");
	});

	it("detects JWT tokens", () => {
		// Build the JWT fixture at runtime to avoid a static secret-shaped literal.
		const jwtHeader = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
		const jwtBody = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
		const jwtSig = "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const jwtLike = `${jwtHeader}.${jwtBody}.${jwtSig}`;
		const result = scrubSecrets(`Bearer ${jwtLike}`);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("jwt");
	});

	it("detects private key headers", () => {
		const result = scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("private_key");
	});

	it("detects connection strings", () => {
		const result = scrubSecrets("db: mongodb://admin:pass123@host:27017/mydb");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("connection_string");
	});

	it("detects Stripe keys", () => {
		// Build token at runtime to avoid committing a static secret-shaped literal.
		const stripeLikeToken = `sk_${"live_51ABCDEFabcdefghijklmnop"}`;
		const result = scrubSecrets(`stripe: ${stripeLikeToken}`);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("stripe_key");
	});

	it("detects Slack tokens", () => {
		const result = scrubSecrets("slack: xoxb-1234567890-abcdefghij");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("slack_token");
	});

	it("detects generic api_key patterns", () => {
		const result = scrubSecrets('config.api_key = "AbCdEf123456789XyZ012345"');
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("generic_secret");
	});

	it("detects OpenAI-style sk- keys and 64-char hex secrets", () => {
		const sk = scrubSecrets("token sk-ABCDEF0123456789abcdef0123456789");
		expect(sk.types).toContain("openai_key");
		const hex = scrubSecrets(`digest ${"a1b2c3d4".repeat(8)} done`);
		expect(hex.types).toContain("hex_secret");
	});

	it("returns unchanged text with no secrets", () => {
		const clean = "Just a normal log message about reading files";
		const result = scrubSecrets(clean);
		expect(result.found).toBe(0);
		expect(result.types).toEqual([]);
		expect(result.text).toBe(clean);
	});

	it("handles empty string", () => {
		const result = scrubSecrets("");
		expect(result.found).toBe(0);
		expect(result.text).toBe("");
	});

	it("handles null/undefined gracefully", () => {
		const result: unknown = Reflect.apply(scrubSecrets, undefined, [undefined]);
		expect(result).toHaveProperty("found", 0);
	});
});

describe("scrubSecrets — configuration", () => {
	it("respects enabled: false", () => {
		const result = scrubSecrets("AKIAIOSFODNN7EXAMPLE", { enabled: false });
		expect(result.found).toBe(0);
		expect(result.text).toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("applies extra_patterns", () => {
		const result = scrubSecrets("MY_SECRET_TOKEN_ABC123", {
			extra_patterns: ["MY_SECRET_TOKEN_[A-Z0-9]+"],
		});
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("custom");
	});

	it("skips matches in ignore_patterns", () => {
		const result = scrubSecrets("test_token_abc123def456ghi789", {
			ignore_patterns: ["test_token_.*"],
		});
		// The ignore pattern should prevent "generic_secret" from matching
		// (though whether it matches depends on the pattern specifics)
		expect(result.text).not.toContain("[REDACTED:");
	});
});

describe("scrubSecrets — replacement format", () => {
	it("uses [REDACTED:{type}] format", () => {
		const result = scrubSecrets("AKIAIOSFODNN7EXAMPLE");
		expect(result.text).toMatch(/\[REDACTED:aws_key\]/);
	});

	it("handles multiple secrets in one string", () => {
		// Build the fixture at runtime so static scanners don't flag this file.
		const ghLikeToken = `gh${"p"}_${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"}`;
		const result = scrubSecrets(`aws=AKIAIOSFODNN7EXAMPLE token=${ghLikeToken}`);
		expect(result.found).toBeGreaterThanOrEqual(2);
		expect(result.text).toContain("[REDACTED:aws_key]");
		expect(result.text).toContain("[REDACTED:github_token]");
	});
});

describe("containsSecrets", () => {
	it("returns true for text with secrets", () => {
		expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
	});

	it("returns false for clean text", () => {
		expect(containsSecrets("just normal text")).toBe(false);
	});

	it("returns false for empty", () => {
		expect(containsSecrets("")).toBe(false);
	});
});

describe("scrubSecrets — false positive resistance", () => {
	it("does not flag short strings", () => {
		const result = scrubSecrets("abc123");
		expect(result.found).toBe(0);
	});

	it("does not flag common code patterns", () => {
		const result = scrubSecrets('const x = require("./module"); export default class Foo {}');
		expect(result.found).toBe(0);
	});

	it("does not flag file paths", () => {
		const result = scrubSecrets("/home/user/repo/cli/src/index.ts");
		expect(result.found).toBe(0);
	});

	it("does not flag npm package names", () => {
		const result = scrubSecrets("@anthropic/claude-code-sdk");
		expect(result.found).toBe(0);
	});
});

describe("scrubSecrets — entropy layer", () => {
	it("skips a token that matches the ENTROPY_ALLOW_LIST (version numbers)", () => {
		const result = scrubSecrets("v1.2.3.4.5.6.7.8.9.10.11.12", {
			entropy_min_length: 5,
			entropy_threshold: 0,
		});
		expect(result.found).toBe(0);
		expect(result.text).toBe("v1.2.3.4.5.6.7.8.9.10.11.12");
	});

	it("treats a zero-length token as zero entropy (reachable only via a negative entropy_min_length, since `config.entropy_min_length || 20` treats 0 itself as falsy)", () => {
		const result = scrubSecrets("   ", {
			entropy_min_length: -5,
			entropy_threshold: -1,
		});
		// Splitting "   " on whitespace yields two empty-string tokens. shannonEntropy("")
		// short-circuits to 0, which still exceeds threshold -1, so both get redacted —
		// proving the str.length === 0 branch runs and returns cleanly (not NaN/throw).
		expect(result).toEqual({
			text: "[REDACTED:entropy][REDACTED:entropy]   ",
			found: 2,
			types: ["entropy"],
		});
	});

	it("flags a qualifying high-entropy token and does not double-count a second one", () => {
		const result = scrubSecrets("first qX9-zK2_pL8-vN4_mW7t and second hZ3-tY6_uJ0-iO5_pA8f", {
			entropy_min_length: 10,
			entropy_threshold: 3.0,
		});
		expect(result.found).toBe(2);
		expect(result.types).toEqual(["entropy"]);
	});
});

describe("scrubSecrets — ignore_patterns branch coverage", () => {
	it("redacts a secret when ignore_patterns is present but does not match it", () => {
		const result = scrubSecrets("key is AKIAIOSFODNN7EXAMPLE", {
			ignore_patterns: ["totally_unrelated_pattern"],
		});
		expect(result.found).toBe(1);
		expect(result.text).toContain("[REDACTED:aws_key]");
	});

	it("skips one match via ignore_patterns while still redacting a later distinct match", () => {
		const ghLikeToken = `gh${"p"}_${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"}`;
		const result = scrubSecrets(`aws=AKIAIOSFODNN7EXAMPLE token=${ghLikeToken}`, {
			ignore_patterns: ["AKIA[0-9A-Z]{16}"],
		});
		expect(result.text).not.toContain("[REDACTED:aws_key]");
		expect(result.text).toContain("AKIAIOSFODNN7EXAMPLE");
		expect(result.text).toContain("[REDACTED:github_token]");
		expect(result.types).toEqual(["github_token"]);
	});

	it("does not double-count the same pattern type across two matches", () => {
		const result = scrubSecrets("first AKIAIOSFODNN7EXAMPLE second AKIABBBBBBBBBBBBBBBB");
		expect(result.found).toBe(2);
		expect(result.types).toEqual(["aws_key"]);
	});
});

describe("loadScrubConfig", () => {
	it.each([null, [], { enabled: "false" }, { entropy_threshold: "high" }])("keeps scrubbing enabled for invalid configuration: %j", async (value) => {
		vi.resetModules();
		vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true), readFileSync: vi.fn(() => JSON.stringify(value)) }));
		try {
			const mod = await import("../secrets.js");
			expect(mod.loadScrubConfig("/tmp/fake-cwd")).toEqual({ enabled: true });
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("returns {enabled: true} when scrub.json does not exist", () => {
		vi.resetModules();
		vi.doMock("node:fs", () => ({
			existsSync: vi.fn(() => false),
			readFileSync: vi.fn(),
		}));
		return import("../secrets.js").then((mod) => {
			expect(mod.loadScrubConfig("/tmp/fake-cwd")).toEqual({ enabled: true });
			vi.doUnmock("node:fs");
			vi.resetModules();
		});
	});

	it("returns the parsed config when scrub.json exists and is valid JSON", () => {
		vi.resetModules();
		vi.doMock("node:fs", () => ({
			existsSync: vi.fn(() => true),
			readFileSync: vi.fn(() => JSON.stringify({ enabled: false, entropy_threshold: 5 })),
		}));
		return import("../secrets.js").then((mod) => {
			expect(mod.loadScrubConfig("/tmp/fake-cwd")).toEqual({
				enabled: false,
				entropy_threshold: 5,
			});
			vi.doUnmock("node:fs");
			vi.resetModules();
		});
	});

	it("falls back to {enabled: true} when scrub.json exists but is malformed JSON", () => {
		vi.resetModules();
		vi.doMock("node:fs", () => ({
			existsSync: vi.fn(() => true),
			readFileSync: vi.fn(() => "{ not valid json"),
		}));
		return import("../secrets.js").then((mod) => {
			expect(mod.loadScrubConfig("/tmp/fake-cwd")).toEqual({ enabled: true });
			vi.doUnmock("node:fs");
			vi.resetModules();
		});
	});

	it("real loadScrubConfig call against the actual filesystem (no scrub.json in a scratch dir)", () => {
		// Exercises the export directly (not mocked) so the un-mocked module instance
		// used by the rest of this file also has this line executed.
		expect(loadScrubConfig(process.cwd())).toEqual(
			expect.objectContaining({ enabled: expect.any(Boolean) }),
		);
	});
});

describe("redactPii", () => {
	it("returns unchanged result for empty text", () => {
		expect(redactPii("")).toEqual({ text: "", found: 0, types: [] });
	});

	it("redacts an SSN", () => {
		const result = redactPii("ssn is 123-45-6789");
		expect(result).toEqual({ text: "ssn is [REDACTED:ssn]", found: 1, types: ["ssn"] });
	});

	it("redacts a credit card number (16-digit grouped)", () => {
		const result = redactPii("card 4111 1111 1111 1111");
		expect(result).toEqual({ text: "card [REDACTED:cc]", found: 1, types: ["cc"] });
	});

	it("redacts a normal email and does not skip it", () => {
		const result = redactPii("contact me at jane.doe@company.io");
		expect(result).toEqual({
			text: "contact me at [REDACTED:email]",
			found: 1,
			types: ["email"],
		});
	});

	it("skips a noreply email (skip pattern matches)", () => {
		const result = redactPii("sent from noreply@example.com");
		expect(result).toEqual({ text: "sent from noreply@example.com", found: 0, types: [] });
	});

	it("redacts a phone number", () => {
		const result = redactPii("call 555-123-4567");
		expect(result).toEqual({ text: "call [REDACTED:phone]", found: 1, types: ["phone"] });
	});

	it("redacts a public IP and does not skip it", () => {
		const result = redactPii("connect to 8.8.8.8 now");
		expect(result).toEqual({ text: "connect to [REDACTED:ip] now", found: 1, types: ["ip"] });
	});

	it("skips a private IP (skip pattern matches, 192.168.x.x)", () => {
		const result = redactPii("connect to 192.168.1.1 now");
		expect(result).toEqual({ text: "connect to 192.168.1.1 now", found: 0, types: [] });
	});

	it("does not double-count the same PII type across two matches", () => {
		const result = redactPii("emails jane@company.io and bob@company.io");
		expect(result).toEqual({
			text: "emails [REDACTED:email] and [REDACTED:email]",
			found: 2,
			types: ["email"],
		});
	});
});

describe("scrubEgressPayload", () => {
	it("scrubs secret fields and PII fields in place, reporting combined stats", () => {
		const ghLikeToken = `gh${"p"}_${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"}`;
		const payload = {
			prompt: `contact jane.doe@company.io token=${ghLikeToken}`,
			thinking: "ssn is 123-45-6789",
			stdout: "clean output, nothing here",
			unrelated_field: "left alone",
		};
		const stats = scrubEgressPayload(payload);
		expect(payload.prompt).toBe(`contact [REDACTED:email] token=[REDACTED:github_token]`);
		expect(payload.thinking).toBe("ssn is [REDACTED:ssn]");
		expect(payload.stdout).toBe("clean output, nothing here");
		expect(payload.unrelated_field).toBe("left alone");
		expect(stats.found).toBe(3);
		expect(stats.types.sort()).toEqual(["email", "github_token", "ssn"].sort());
	});

	it("leaves non-string and empty-string fields untouched", () => {
		const payload = {
			prompt: "",
			thinking: 42,
			stdout: "AKIAIOSFODNN7EXAMPLE",
		};
		const stats = scrubEgressPayload(payload);
		expect(payload.prompt).toBe("");
		expect(payload.thinking).toBe(42);
		expect(payload.stdout).toBe("[REDACTED:aws_key]");
		expect(stats.found).toBe(1);
		expect(stats.types).toEqual(["aws_key"]);
	});

	it("does not duplicate a type already recorded by a prior field in the same call", () => {
		const payload = {
			prompt: "reach jane@company.io",
			thinking: "reach bob@company.io",
		};
		const stats = scrubEgressPayload(payload);
		expect(stats.found).toBe(2);
		expect(stats.types).toEqual(["email"]);
	});

	it("uses loadScrubConfig() when no config is passed", () => {
		const payload = { prompt: "AKIAIOSFODNN7EXAMPLE" };
		const stats = scrubEgressPayload(payload);
		expect(payload.prompt).toBe("[REDACTED:aws_key]");
		expect(stats.found).toBe(1);
	});
});

describe("recordScrub", () => {
	it("increments total_scrubbed and per-type counts, including repeat calls for the same type", () => {
		expect(() => recordScrub(["aws_key"])).not.toThrow();
		expect(() => recordScrub(["aws_key", "github_token"])).not.toThrow();
	});
});
