import { describe, expect, it } from "vitest";
import {
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkPlaceholderDataInUi,
	checkSilentDemoFallback,
} from "./demo-data.js";

const TS = "src/lib/foo.ts";
const TEST = "src/lib/foo.test.ts";

describe("checkDemoDataUnmarked", () => {
	it("flags test emails (foo@example.com)", () => {
		const code = `const users = [{ email: "alice@example.com" }];`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Stripe test card numbers", () => {
		const code = `const card = "4242424242424242";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.some((m) => m.text.includes("Stripe / payment test card"))).toBe(true);
	});

	it("flags lorem ipsum", () => {
		const code = `const text = "Lorem ipsum dolor sit amet";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.some((m) => m.text.includes("lorem ipsum"))).toBe(true);
	});

	it("flags lorem ipsum with extra internal spacing between the words", () => {
		const code = `const text = "Lorem   ipsum dolor sit amet";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("lorem ipsum"))).toBe(true);
	});

	it("flags faker import", () => {
		const code = `import { faker } from "@faker-js/faker";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.some((m) => m.text.includes("faker / chance / falso import"))).toBe(true);
	});

	it("flags identifier prefixes (mockUsers, fakeData, sampleX)", () => {
		const code = `const mockUsers = []; const fakeData = {}; const sampleOrders = [];`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(3);
		expect(matches.some((m) => m.text.includes("demo/mock identifier prefix"))).toBe(true);
	});

	it("flags sentinel UUIDs", () => {
		const code = `const id = "00000000-0000-0000-0000-000000000000";`;
		expect(checkDemoDataUnmarked(code, TS).length).toBeGreaterThan(0);
	});

	it("does not fire when @demo-data directive is present", () => {
		const code = `
// @demo-data: revenue chart pending API integration
const revenue = [{ email: "alice@example.com" }];
`;
		expect(checkDemoDataUnmarked(code, TS)).toEqual([]);
	});

	it("does not fire on test files", () => {
		const code = `const u = [{ email: "alice@example.com" }];`;
		expect(checkDemoDataUnmarked(code, TEST)).toEqual([]);
	});

	it("does not fire on __fixtures__ files", () => {
		expect(
			checkDemoDataUnmarked(
				`const u = [{ email: "alice@example.com" }];`,
				"src/__fixtures__/users.ts",
			),
		).toEqual([]);
	});

	it("flags an RFC test-domain URL not caught by the email/faker patterns", () => {
		const code = `const url = "https://foo.test/api";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toMatch(/RFC test domain/);
	});

	it("does not flag an RFC test-domain URL marked with @demo-data", () => {
		const code = `
// @demo-data: pointing at the sandbox host on purpose
const url = "https://foo.test/api";
`;
		expect(checkDemoDataUnmarked(code, TS)).toEqual([]);
	});

	it("stops at MAX_MATCHES (8) even when far more smells are present on one line", () => {
		// 20 Stripe test-card hits on a single line — well past the 8-match cap,
		// exercising the inner-loop break (matches.length >= MAX_MATCHES).
		const cards = Array(20).fill('"4242424242424242"').join(", ");
		const code = `const many = [${cards}];`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(8);
	});

	it("does not fire on a non-JS/TS file extension", () => {
		const code = `email: alice@example.com`;
		expect(checkDemoDataUnmarked(code, "docs/notes.md")).toEqual([]);
	});

	it("stops before evaluating the RFC-domain bank once MAX_MATCHES is already hit", () => {
		// Line 1 alone exhausts the 8-match cap via SMELL_PATTERNS; line 2's RFC
		// test-domain URL must not add a 9th match.
		const cards = Array(20).fill('"4242424242424242"').join(", ");
		const code = `const many = [${cards}];\nconst url = "https://foo.test/api";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(8);
	});

	it("does not exceed MAX_MATCHES from the RFC-domain bank on the same line the cap is hit", () => {
		// All 8 slots fill from the card pattern on ONE line; an RFC test-domain
		// URL on that SAME line must not sneak in a 9th match via the bank-2 guard.
		const cards = Array(8).fill('"4242424242424242"').join(", ");
		const code = `const many = [${cards}]; const url = "https://foo.test/api";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(8);
	});

	it("reports the exact line number and message text for a SMELL_PATTERNS match", () => {
		const code = `const a = 1;\nconst users = [{ email: "alice@example.com" }];`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches[0]?.line).toBe(2);
		expect(matches[0]?.text).toContain("unmarked demo data (test-email literal)");
		expect(matches[0]?.text).toContain("alice@example.com");
	});

	it("truncates a long matched hit to 80 characters in the reported text", () => {
		const localPart = "a".repeat(90);
		const hit = `${localPart}@example.com`;
		const code = `const e = "${hit}";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain(hit.slice(0, 80));
		expect(matches[0]?.text).not.toContain(hit);
	});

	it("reports the correct 1-based line number for an RFC test-domain match on a later line", () => {
		const code = `const a = 1;\nconst url = "https://foo.test/api";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
	});

	it("truncates a long RFC test-domain line to 110 characters in the reported text", () => {
		const padding = "x".repeat(150);
		const code = `const url = "https://foo.test/api/${padding}";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain(code.trim().slice(0, 110));
		expect(matches[0]?.text).not.toContain(code.trim());
	});

	it("trims leading whitespace before truncating an RFC test-domain line", () => {
		const code = `   const url = "https://foo.test/api";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("domain): const url");
		expect(matches[0]?.text).not.toContain("domain):    const url");
	});

	it("flags a demo-data path addressed with backslash separators (Windows-style)", () => {
		const code = `const u = [{ email: "alice@example.com" }];`;
		expect(checkDemoDataUnmarked(code, "src\\__fixtures__\\users.ts")).toEqual([]);
	});

	it("does not fire on a __fixtures__ path with no leading directory", () => {
		const code = `const u = [{ email: "alice@example.com" }];`;
		expect(checkDemoDataUnmarked(code, "__fixtures__/users.ts")).toEqual([]);
	});

	it("flags a placeholder-name email with no doe/smith/test/user suffix", () => {
		const code = `const u = { email: "foo@example.com" };`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("placeholder-name email"))).toBe(true);
	});

	it("flags a placeholder-name email with no dot before the suffix", () => {
		const code = `const u = { email: "foouser@example.com" };`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("placeholder-name email"))).toBe(true);
	});

	it("flags a 555 phone number with a literal dash separator", () => {
		const code = `const x = "call 555-1234 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("test phone"))).toBe(true);
	});

	it("flags a 555 phone number with a literal space separator", () => {
		const code = `const x = "call 555 1234 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("test phone"))).toBe(true);
	});

	it("flags a 555 phone number with no separator before the digits", () => {
		const code = `const x = "call 5551234 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("test phone"))).toBe(true);
	});

	it("does not flag 555 followed by only two digits as a phone number", () => {
		const code = `const x = "call 555-12 now";`;
		expect(checkDemoDataUnmarked(code, TS)).toEqual([]);
	});

	it("flags a 555-XXX phone number with no trailing digit group", () => {
		const code = `const x = "call 555-123 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("test phone"))).toBe(true);
	});

	it("flags a 555 phone number followed by extra trailing digits", () => {
		const code = `const x = "call 555-123456 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("test phone"))).toBe(true);
	});

	it("flags the full phone match when the second separator group is a literal dash", () => {
		const code = `const x = "call 555-123-4 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("555-123-4"))).toBe(true);
	});

	it("flags the full phone match when the second separator group is a space", () => {
		const code = `const x = "call 555-123 4 now";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("555-123 4"))).toBe(true);
	});

	it("flags a test SSN", () => {
		const code = `const ssn = "123-45-6789";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("test SSN"))).toBe(true);
	});

	it("flags a full-length sentinel UUID made of f's", () => {
		const code = `const id = "ffffffff-ffff-ffff-ffff-ffffffffffff";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("sentinel UUID"))).toBe(true);
	});

	it("flags a full-length sentinel UUID made of a's", () => {
		const code = `const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("sentinel UUID"))).toBe(true);
	});

	it("flags a chance import even right at the closing quote boundary", () => {
		const code = `import { chance } from "chance";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("faker / chance / falso import"))).toBe(true);
	});

	it("flags a faker import with extra spacing after from", () => {
		const code = `import { faker } from  "faker";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("faker / chance / falso import"))).toBe(true);
	});

	it("flags a mock-prefixed identifier with irregular spacing around the sign", () => {
		const code = `const  mockUsers  = [];`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("demo/mock identifier prefix"))).toBe(true);
	});

	it("flags a mock-prefixed identifier with a single-letter suffix and no space before the sign", () => {
		// A single capital letter after "mock" leaves [\w$]* with nothing to
		// give back, so there is no fallback character for a negated sign
		// class to steal — this is the shape that actually pins the sign.
		const code = `const mockX=1;`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("demo/mock identifier prefix"))).toBe(true);
	});

	it("flags an exported mock getter, including with irregular spacing", () => {
		const code = `export  function  getMockUsers() { return []; }`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("exported mock getter"))).toBe(true);
		expect(matches.some((m) => m.text.includes("getMockUsers"))).toBe(true);
	});

	it("flags a plain-http RFC test-domain URL", () => {
		const code = `const url = "http://foo.test/api";`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.some((m) => m.text.includes("RFC test domain"))).toBe(true);
	});
});

describe("checkSilentDemoFallback", () => {
	it("flags try { fetch } catch { return literal }", () => {
		const code = `
async function loadUsers() {
  try {
    return await fetch("/api/users").then(r => r.json());
  } catch {
    return [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
  }
}
`;
		const matches = checkSilentDemoFallback(code, TS);
		expect(matches.length).toBe(1);
	});

	it("does not fire when catch rethrows", () => {
		const code = `
try { return await fetch("/api"); } catch (e) { throw e; }
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when catch returns a non-literal", () => {
		const code = `
try { return await fetch("/api"); } catch { return defaultData; }
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire in test files", () => {
		const code = `try { fetch(); } catch { return [{a:1}]; }`;
		expect(checkSilentDemoFallback(code, TEST)).toEqual([]);
	});

	// FP refinement (2026-07): a catch that SURFACES the error in a
	// structured result (`return { ok: false, error: err.message }`) is
	// error handling, not a silent demo fallback. Only fire when the catch
	// hides the failure entirely.

	it("does not fire when the catch returns a literal embedding the error binding", () => {
		const code = `
async function check() {
  try {
    return await fetch("/api/health").then(r => r.json());
  } catch (e) {
    return { status: "fail", message: e.message };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch returns an ok:false / error-field result", () => {
		const code = `
async function load() {
  try {
    return await api.getUsers();
  } catch {
    return { ok: false, error: "upstream unavailable" };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch logs before returning a literal", () => {
		const code = `
async function load() {
  try {
    return await client.list();
  } catch (err) {
    console.error("list failed", err);
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("STILL fires when the error binding is captured but never used", () => {
		const code = `
async function loadItems() {
  try {
    return await fetch("/api/items").then(r => r.json());
  } catch (e) {
    return [{ id: 1, title: "Sample item" }];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("STILL fires when the returned literal has no error/fail field", () => {
		const code = `
async function loadStats() {
  try {
    return await api.stats();
  } catch {
    return { visits: 1200, conversions: 34 };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("does not fire when the try block is never closed (unbalanced braces)", () => {
		const code = `try { return await fetch("/api");`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when a try block is followed by finally instead of catch", () => {
		const code = `try { return await fetch("/api"); } finally { cleanup(); }`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch block is never closed (unbalanced braces)", () => {
		const code = `try { return await fetch("/api"); } catch (e) { return [1,`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("fires when the try starts at offset 0 (no preceding newline to count)", () => {
		const code = `try { return await fetch("/api").then(r => r.json()); } catch { return [1, 2]; }`;
		const matches = checkSilentDemoFallback(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("does not fire on a non-JS/TS file extension", () => {
		const code = `try { return await fetch("/api"); } catch { return [1, 2]; }`;
		expect(checkSilentDemoFallback(code, "docs/notes.md")).toEqual([]);
	});

	it("does not fire when the catch both rethrows conditionally AND returns a literal", () => {
		// catchHidesFailure only runs once tryHasRealCall && catchReturnsLiteral
		// are both true; this reaches the /\bthrow\b/ check inside it.
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch (e) {
    if (fatal) throw e;
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch references the error binding directly (no throw/log/field)", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch (err) {
    report(err);
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("flags a call made without an await keyword (the leading await group is optional)", () => {
		const code = `
async function loadUsers() {
  try {
    return fetch("/api/users").then(r => r.json());
  } catch {
    return [{ id: 1, name: "Alice" }];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("flags a bare axios call with irregular spacing around the dots and parens", () => {
		const code = `
async function load() {
  try {
    return axios  .  getUsers  ().then(r => r.data);
  } catch {
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("flags a bare client.method call with a multi-character method name", () => {
		const code = `
async function load() {
  try {
    return client.getRecords();
  } catch {
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("flags a bare http call with irregular spacing around the dots and parens", () => {
		const code = `
async function load() {
  try {
    return http  .  getStatus  ().then(r => r.data);
  } catch {
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("does not fire when the catch logs via console with irregular spacing (no error binding referenced)", () => {
		const code = `
async function load() {
  try {
    return await client.list();
  } catch {
    console  .  error  ("list failed");
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch logs via logger with irregular spacing (no error binding referenced)", () => {
		const code = `
async function load() {
  try {
    return await client.list();
  } catch {
    logger  .  warn  ("list failed");
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch logs via ctx.log with irregular spacing (no error binding referenced)", () => {
		const code = `
function load(ctx) {
  try {
    return client.list();
  } catch {
    ctx  .  log  ("list failed");
    return [];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when a conditional throw with no error-binding usage protects an otherwise-silent catch", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    if (isFatal) throw new Error("fatal");
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("recognizes a try block with no space before the opening brace", () => {
		const code = `
async function load() {
  try{
    return await fetch("/api/data").then(r => r.json());
  } catch {
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("stops at MAX_MATCHES (5) when more silent-fallback try/catch blocks exist", () => {
		const block = (n: number): string => `
function loadThing${n}() {
  try {
    return await fetch("/api/thing${n}").then(r => r.json());
  } catch {
    return [${n}];
  }
}
`;
		const code = Array.from({ length: 6 }, (_, i) => block(i)).join("\n");
		const matches = checkSilentDemoFallback(code, TS);
		expect(matches.length).toBe(5);
	});

	it("does not fire when non-whitespace text sits between the try block and catch", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } xxx catch {
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("still recognizes catch across a blank line after the try block", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  }

  catch {
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("still recognizes a catch binding when extra space precedes the parenthesis", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch  (e) {
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("still recognizes catch when extra space precedes the opening brace", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch (e)  {
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("still recognizes a typed catch binding", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch (e: unknown) {
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("reports the try block's own line number, not lines that follow it", () => {
		const code = `const a = 1;
const b = 2;
try {
  return await fetch("/api/data").then(r => r.json());
} catch {
  return [1, 2, 3];
}
const trailingLine1 = "x";
const trailingLine2 = "y";
const trailingLine3 = "z";`;
		const matches = checkSilentDemoFallback(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(3);
	});

	it("reports a descriptive message naming try/catch for a silent demo fallback", () => {
		const code = `
try {
  return await fetch("/api/data").then(r => r.json());
} catch {
  return [1, 2, 3];
}
`;
		const matches = checkSilentDemoFallback(code, TS);
		expect(matches[0]?.text).toContain("silent demo fallback");
		expect(matches[0]?.text).toContain("catch");
	});

	it("correctly extracts a catch body containing a nested block (finds the return past it)", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    if (isDev) { doSomething(); }
    return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("does not treat a conditional inline return as a silent literal fallback", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    if (isDev) return [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("still recognizes a literal return with extra internal spacing", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    return  [1, 2, 3];
  }
}
`;
		expect(checkSilentDemoFallback(code, TS).length).toBe(1);
	});

	it("does not fire when the catch returns an ok:false field with irregular spacing", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    return { ok  :  false };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch returns a success:false field with irregular spacing", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    return { success  :  false };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch returns an error field with irregular spacing", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    return { error  : "upstream unavailable" };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when the catch returns a status:'failed' field with irregular spacing", () => {
		const code = `
async function load() {
  try {
    return await fetch("/api/data").then(r => r.json());
  } catch {
    return { status  :  'failed' };
  }
}
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});
});

describe("checkDemoRuntimeMissingBanner", () => {
	it("flags root layout that imports demoData but no DemoBanner", () => {
		const code = `
import { demoData } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;
		const matches = checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx");
		expect(matches.length).toBe(1);
	});

	it("does not fire when DemoBanner is mounted", () => {
		const code = `
import { DemoBanner } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body><DemoBanner />{children}</body></html>;
}
`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});

	it("does not fire on non-root files", () => {
		const code = `import { demoData } from "@interlinked/demo-runtime"; const x = demoData("a", []);`;
		expect(checkDemoRuntimeMissingBanner(code, "src/lib/foo.ts")).toEqual([]);
	});

	it("does not fire on root files that don't import demo runtime", () => {
		const code = `export default function Layout({ children }) { return <>{children}</>; }`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});

	it("reports a descriptive message and line 1 for a missing DemoBanner", () => {
		const code = `
import { demoData } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;
		const matches = checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx");
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("DemoBanner");
		expect(matches[0]?.text).toContain("root layout imports demo-runtime");
	});

	it("flags a root layout addressed with backslash path separators", () => {
		const code = `
import { demoData } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;
		const matches = checkDemoRuntimeMissingBanner(code, "myproject\\src\\app\\layout.tsx");
		expect(matches.length).toBe(1);
	});

	it("flags a root layout addressed as a bare filename with no directory prefix", () => {
		const code = `
import { demoData } from "@interlinked/demo-runtime";
export default function App() {
  return <div>{children}</div>;
}
`;
		const matches = checkDemoRuntimeMissingBanner(code, "App.tsx");
		expect(matches.length).toBe(1);
	});

	it("flags a relative demo-runtime import with extra spacing after from", () => {
		const code = `
import { demoData } from  "../lib/demo-runtime";
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;
		const matches = checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx");
		expect(matches.length).toBe(1);
	});

	it("recognizes a DemoBanner usage with a space after the opening angle bracket", () => {
		const code = `
import { DemoBanner } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body>< DemoBanner />{children}</body></html>;
}
`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});

	it("recognizes a DemoBanner usage with extra spacing before the self-closing slash", () => {
		const code = `
import { DemoBanner } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body><DemoBanner  />{children}</body></html>;
}
`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});

	it("recognizes a DemoBanner usage without a self-closing slash (explicit closing tag)", () => {
		const code = `
import { DemoBanner } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body><DemoBanner>{children}</DemoBanner></body></html>;
}
`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});
});

describe("checkDemoRuntimeMissingBanner — recognizes every canonical root-layout path", () => {
	// Paths that are NOT a suffix of a shorter path also in ROOT_LAYOUT_PATHS —
	// each one here is the ONLY entry that can match it, so emptying that
	// entry's string literal is independently observable through this file.
	// ("src/app/layout.tsx", "src/app/layout.jsx", "src/pages/_app.tsx", and
	// "src/App.tsx" are deliberately excluded: each is already a suffix match
	// for a shorter root also in the list, so losing its own entry changes
	// nothing observable.)
	const rootPaths = [
		"app/layout.tsx",
		"app/layout.jsx",
		"pages/_app.tsx",
		"pages/_app.jsx",
		"src/main.tsx",
		"src/main.jsx",
		"src/index.tsx",
		"src/index.jsx",
		"App.tsx",
	];
	const code = `
import { demoData } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;
	for (const path of rootPaths) {
		it(`flags a root layout at the canonical path "${path}"`, () => {
			expect(checkDemoRuntimeMissingBanner(code, path).length).toBe(1);
		});
	}
});

describe("checkPlaceholderDataInUi", () => {
	const UI = "src/components/Dashboard.tsx";

	it("flags a sequential-digit run rendered as text", () => {
		const code = `export const Stat = () => <span className="count">123456</span>;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a repeated-digit run rendered as a JSX child", () => {
		const code = `export const Stat = () => <div>{99999}</div>;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a mock-named value in a visible attribute", () => {
		const code = `export const Card = () => <Stat label="Revenue" value={mockRevenue} />;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags lorem ipsum rendered as copy", () => {
		const code = `export const Hero = () => <p>Lorem ipsum dolor sit amet consectetur</p>;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a known placeholder-image host", () => {
		const code = `export const Avatar = () => <img src="https://placehold.co/64x64" alt="u" />;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a hardcoded number a nearby comment marks as placeholder", () => {
		const code = [
			"export function Mrr() {",
			"  // placeholder until the revenue API lands",
			'  return <Stat value="12,847" />;',
			"}",
		].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("does not fire on a real value passed through an identifier", () => {
		const code = `export const Card = () => <Stat label="Revenue" value={revenue} />;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on a plausible, non-placeholder-shaped number", () => {
		const code = `export const Price = () => <Stat value="$1,234" />;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on an input placeholder attribute", () => {
		const code = `export const Search = () => <input placeholder="Search products" />;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on a non-UI file", () => {
		const code = `export const data = { count: 123456, label: "Lorem ipsum dolor" };`;
		expect(checkPlaceholderDataInUi(code, "src/lib/stats.ts")).toEqual([]);
	});

	it("is suppressed when the UI renders a visible sample-data disclaimer", () => {
		const code = [
			"export const Dashboard = () => (",
			"  <div>",
			"    <Banner>Sample data — these figures are illustrative</Banner>",
			"    <span>123456</span>",
			"  </div>",
			");",
		].join("\n");
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on commented-out markup", () => {
		const code = `export const X = () => <div>{/* <span>123456</span> */}</div>;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});
});
