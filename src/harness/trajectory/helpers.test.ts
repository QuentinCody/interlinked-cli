import { describe, expect, it } from "vitest";
import {
	anchorHash,
	commandFamily,
	commandHeads,
	detectAllSecretLiterals,
	extractHosts,
	isPrivateOrLoopbackIPv4,
	isSourceCodeFile,
	looksLikeHighConfidenceSecret,
	looksLikeSecretLiteral,
} from "./helpers.js";

/**
 * `extractHosts` runs on every PreToolUse Bash command, so a superlinear regex
 * here is a stall on the guard path, not just a slow function. The domain
 * pattern was quadratic until 2026-08-04: `(?:[a-zA-Z0-9-]+\.)+` re-partitioned
 * a long hyphen-and-dot run at every start offset, measured at exactly 4x per
 * doubling (32KB of `a-a.` took 1.35s). Found by an empirical ReDoS probe over
 * the `redos_catastrophic` corpus hits.
 */
describe("extractHosts", () => {
	describe("— extraction (semantics)", () => {
		it("P1: pulls the host out of an http URL", () => {
			expect(extractHosts("curl http://a-b.example.com/x")).toContain("a-b.example.com");
		});

		it("P2: pulls a bare dotted hostname", () => {
			expect(extractHosts("ping foo.bar.co.uk")).toContain("foo.bar.co.uk");
		});

		it("P3: pulls a hyphenated single-label-plus-tld host", () => {
			expect(extractHosts("see my-host.local now")).toContain("my-host.local");
		});

		it("P4: pulls a deep multi-label host without truncating it", () => {
			// A bound too tight (e.g. {1,12}) silently matches a SHIFTED window here
			// — "b.c.…example" instead of the real host — which is worse than not
			// matching, because the caller then classifies the wrong name.
			expect(extractHosts("get a.b.c.d.e.f.g.h.i.j.k.l.m.example.com")).toContain(
				"a.b.c.d.e.f.g.h.i.j.k.l.m.example.com",
			);
		});

		it("P5: pulls an IPv4 literal", () => {
			expect(extractHosts("nc 10.0.0.1 8080")).toContain("10.0.0.1");
		});

		it("P6: pulls the domain out of an email-shaped token", () => {
			expect(extractHosts("git config user.email bob@example.com")).toContain("example.com");
		});

		it("P7: pulls the domain from an email whose local part is dotted and hyphenated", () => {
			expect(extractHosts("scp a-b.c_d@sub.domain.co.uk:/x /tmp")).toContain("sub.domain.co.uk");
		});

		it("N1: finds nothing in a command with no dotted token", () => {
			expect(extractHosts("ls -la /tmp")).toHaveLength(0);
		});
	});

	describe("— cost (linearity)", () => {
		// Ratio, never an absolute ceiling: this repo has been burned three times
		// by wall-clock thresholds that failed under parallel load while saying
		// nothing about the code. 4x the input should cost ~4x (linear); the
		// quadratic form cost ~16x. The threshold sits between, with margin.
		it("stays linear on an adversarial hyphen-and-dot run", () => {
			const measure = (reps: number): number => {
				const input = `curl ${"a-a.".repeat(reps)} `;
				const start = performance.now();
				extractHosts(input);
				return performance.now() - start;
			};

			// Best-of-N, not a single sample. A lone sample makes the RATIO as
			// noisy as the wall-clock thresholds this test exists to avoid: one GC
			// pause landing in the `large` run pushed the ratio to 15.7 under a
			// loaded full-suite coverage run while the code was perfectly linear.
			// `min` is the noise-robust statistic — interference only ever adds.
			const best = (reps: number): number => {
				let lo = Number.POSITIVE_INFINITY;
				for (let i = 0; i < 5; i++) lo = Math.min(lo, measure(reps));
				return lo;
			};

			measure(500); // warm up the JIT so the first real sample is not an outlier
			const small = Math.max(best(2000), 0.5);
			const large = best(8000);

			// 4x input: linear lands near 4, quadratic near 16.
			expect(large / small).toBeLessThan(8);
		});
	});
});

describe("commandFamily", () => {
    it("recognizes the supported typecheck scripts as verifiers", () => {
        expect(commandFamily("npm run typecheck")).toBe("build");
        expect(commandFamily("npm run typecheck:stable")).toBe("build");
        expect(commandFamily("pnpm typecheck")).toBe("build");
    });
	describe("— positive (must fire)", () => {
		it("P1: classifies a lint-family command as lint", () => {
			expect(commandFamily("eslint src/")).toBe("lint");
		});
	});

	describe("— negative (falls back to head verb)", () => {
		it("N1: falls back to the lowercased basename of the head verb", () => {
			expect(commandFamily("/usr/bin/LS -la")).toBe("ls");
		});

		it("N2: falls back to empty string for a blank command", () => {
			expect(commandFamily("   ")).toBe("");
		});
	});
});

describe("commandHeads", () => {
	it("P1: skips shell prefixes (sudo, env VAR=x) to find the real head verb", () => {
		expect(commandHeads("sudo env FOO=bar /usr/bin/curl example.com")).toEqual(["curl"]);
	});

	it("N1: returns empty array for a segment that is only prefixes", () => {
		expect(commandHeads("sudo env FOO=bar")).toEqual([]);
	});
});

describe("anchorHash", () => {
	it("P1: hashes a fixed sentinel for an all-blank oldString", () => {
		expect(anchorHash("   \n  \n")).toBe(anchorHash(""));
	});

	it("N1: hashes first+last non-empty trimmed lines for a multi-line string", () => {
		const expected = anchorHash("first\nlast");
		expect(anchorHash("  first  \nmiddle\n  last  ")).toBe(expected);
	});

	it("N2: single non-empty line is both first and last", () => {
		const expected = anchorHash("only\nonly");
		expect(anchorHash("only")).toBe(expected);
	});
});

describe("isSourceCodeFile", () => {
	it("P1: true for a .ts source file", () => {
		expect(isSourceCodeFile("src/foo.ts")).toBe(true);
	});

	it("N1: false for a .d.ts declaration file", () => {
		expect(isSourceCodeFile("src/foo.d.ts")).toBe(false);
	});

	it("N2: false for a non-code extension (.json)", () => {
		expect(isSourceCodeFile("package.json")).toBe(false);
	});

	it("N3: false for an unrecognized extension", () => {
		expect(isSourceCodeFile("README")).toBe(false);
	});
});

describe("isPrivateOrLoopbackIPv4", () => {
	it("P1: 0.0.0.0/8 is private", () => {
		expect(isPrivateOrLoopbackIPv4("0.1.2.3")).toBe(true);
	});

	it("P2: 10/8 is private", () => {
		expect(isPrivateOrLoopbackIPv4("10.1.2.3")).toBe(true);
	});

	it("P3: 127/8 is loopback", () => {
		expect(isPrivateOrLoopbackIPv4("127.0.0.1")).toBe(true);
	});

	it("P4: 169.254/16 is link-local", () => {
		expect(isPrivateOrLoopbackIPv4("169.254.1.1")).toBe(true);
	});

	it("P5: 172.16-31/12 is private", () => {
		expect(isPrivateOrLoopbackIPv4("172.20.0.1")).toBe(true);
	});

	it("P6: 192.168/16 is private", () => {
		expect(isPrivateOrLoopbackIPv4("192.168.1.1")).toBe(true);
	});

	it("N1: a public IPv4 is not private/loopback", () => {
		expect(isPrivateOrLoopbackIPv4("8.8.8.8")).toBe(false);
	});

	it("N2: 172.15.x is outside the 172.16-31 private band", () => {
		expect(isPrivateOrLoopbackIPv4("172.15.0.1")).toBe(false);
	});

	it("N3: 169.253.x is outside the link-local band", () => {
		expect(isPrivateOrLoopbackIPv4("169.253.0.1")).toBe(false);
	});

	it("N4: a non-IPv4 string returns false", () => {
		expect(isPrivateOrLoopbackIPv4("not-an-ip")).toBe(false);
	});

	it("N5: an octet over 255 returns false", () => {
		expect(isPrivateOrLoopbackIPv4("999.1.2.3")).toBe(false);
	});
});

describe("secret-literal detection", () => {
	it("P1: looksLikeSecretLiteral is true when a low-confidence shape (openai key) is present", () => {
		expect(looksLikeSecretLiteral(`key=sk-${"a".repeat(20)}`)).toBe(true);
	});

	it("N1: looksLikeSecretLiteral is false with no credential-shaped literal", () => {
		expect(looksLikeSecretLiteral("hello world")).toBe(false);
	});

	it("P2: looksLikeHighConfidenceSecret is true for an AWS access key", () => {
		expect(looksLikeHighConfidenceSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true);
	});

	it("N2: looksLikeHighConfidenceSecret is false for a low-confidence-only shape (slack token)", () => {
		expect(looksLikeHighConfidenceSecret("xoxb-1234567890-abc")).toBe(false);
	});

	it("skips a duplicate token match when collecting all secret literals", () => {
		const content = `AKIAABCDEFGHIJKLMNOP and again AKIAABCDEFGHIJKLMNOP`;
		const matches = detectAllSecretLiterals(content);
		expect(matches).toEqual([{ kind: "aws_access_key", token: "AKIAABCDEFGHIJKLMNOP", high: true }]);
	});
});
