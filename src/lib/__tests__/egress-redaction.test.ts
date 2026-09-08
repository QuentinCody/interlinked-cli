import { describe, expect, it } from "vitest";
import { REDACTION_CHUNK } from "../hook-template-chunks/redaction.js";
import type { JsonObject } from "../json-types.js";
import { redactPii, scrubEgressPayload } from "../secrets.js";

// Build the hook's self-contained inline redactPii from REDACTION_CHUNK so we
// can assert the canonical TS scrubber and the .mjs mirror behave identically.
// Test-only eval of trusted in-repo source — this is the parity guarantee.
// SAFETY: REDACTION_CHUNK declares redactPii(text), and this factory returns that named export; the corpus below checks its string output against the canonical scrubber.
const mjs = new Function(`${REDACTION_CHUNK}; return { redactPii };`)() as {
	redactPii: (t: string) => string;
};

describe("redactPii — PII coverage", () => {
	it("masks SSN", () => {
		expect(redactPii("ssn 521-44-8190 end").text).toBe("ssn [REDACTED:ssn] end");
	});
	it("masks email but skips noreply / example / localhost", () => {
		expect(redactPii("ping jane.real@acme.com").text).toBe("ping [REDACTED:email]");
		expect(redactPii("noreply@github.com").text).toBe("noreply@github.com");
		expect(redactPii("a@example.com").text).toBe("a@example.com");
	});
	it("masks credit cards (16- and 15-digit)", () => {
		expect(redactPii("card 4111 1111 1111 1111").text).toBe("card [REDACTED:cc]");
		expect(redactPii("amex 3782 822463 10005").text).toBe("amex [REDACTED:cc]");
	});
	it("masks US phone numbers", () => {
		expect(redactPii("call 555-123-4567").text).toBe("call [REDACTED:phone]");
	});
	it("masks public IPv4 but keeps loopback / private ranges", () => {
		expect(redactPii("ip 8.8.8.8").text).toBe("ip [REDACTED:ip]");
		expect(redactPii("hosts 127.0.0.1 10.0.0.5 192.168.1.1 172.16.5.4").text).toBe(
			"hosts 127.0.0.1 10.0.0.5 192.168.1.1 172.16.5.4",
		);
	});
	it("leaves non-PII untouched (version strings, paths)", () => {
		expect(redactPii("version 2.1.156 at /a/b.ts:42").text).toBe("version 2.1.156 at /a/b.ts:42");
	});
});

describe("scrubEgressPayload — two-tier egress contract", () => {
	it("scrubs secrets on every string field AND PII on prompt/thinking", () => {
		const payload: JsonObject = {
			prompt: "ssn 521-44-8190 email jane@acme.com key sk-ABCDEF0123456789abcdef0123",
			thinking: "card 4111 1111 1111 1111 ip 8.8.8.8",
			tool_response_json: '{"content":"AKIA1234567890ABCDEF"}',
			tool_input: { file_path: "/x" },
			session_id: "keep-me",
		};
		const stats = scrubEgressPayload(payload, { enabled: true });
		expect(stats.found).toBeGreaterThan(0);
		// prompt: PII masked
		expect(payload.prompt).toContain("[REDACTED:ssn]");
		expect(payload.prompt).toContain("[REDACTED:email]");
		expect(payload.prompt).not.toContain("521-44-8190");
		// prompt: secret masked too (secrets run on ALL string fields)
		expect(payload.prompt).not.toContain("sk-ABCDEF0123456789abcdef0123");
		// thinking: PII masked
		expect(payload.thinking).toContain("[REDACTED:cc]");
		expect(payload.thinking).toContain("[REDACTED:ip]");
		// tool_response_json: secret masked (secrets on all string fields)
		expect(payload.tool_response_json).not.toContain("AKIA1234567890ABCDEF");
		// non-target fields untouched
		expect(payload.session_id).toBe("keep-me");
		expect(payload.tool_input).toEqual({ file_path: "/x" });
	});

	it("does NOT apply PII redaction to tool I/O — only secrets (avoids mangling code/logs)", () => {
		const payload: JsonObject = {
			tool_response_json: '{"text":"customer ssn 521-44-8190 in a file we read"}',
		};
		scrubEgressPayload(payload, { enabled: true });
		// An SSN sitting in tool output is NOT PII-scrubbed — PII applies to NL fields only.
		expect(payload.tool_response_json).toContain("521-44-8190");
	});
});

describe("redactPii — behavioral parity with the .mjs hook mirror", () => {
	// Same input → identical output across the canonical TS scrubber and the
	// self-contained hook mirror. If these ever drift, this fails.
	const cases = [
		"ssn 521-44-8190 here",
		"email jane.real@acme.com and noreply@x.com and a@example.com",
		"card 4111 1111 1111 1111 amex 3782 822463 10005",
		"phone 555-123-4567 and (555) 987 6543",
		"ip 8.8.8.8 vs 127.0.0.1 vs 10.0.0.5 vs 192.168.0.1 vs 172.16.5.4",
		"no pii here, version 2.1.156, path /a/b.ts:42",
		"mixed 521-44-8190 jane@acme.com 8.8.8.8 done",
	];
	for (const input of cases) {
		it(`matches the mirror for: ${input.slice(0, 32)}`, () => {
			expect(redactPii(input).text).toBe(mjs.redactPii(input));
		});
	}
});
