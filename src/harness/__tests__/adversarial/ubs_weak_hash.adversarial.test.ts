// Independent adversarial review of the `ubs_weak_hash` pre_block check
// (2026-10-21). Every negative here was a probed false positive before the
// detector was refined: `scratch/2026-10-21-adversarial/ubs_weak_hash.probe.mts`.
// A pre_block check blocks an agent's edit, so each of these is a legitimate
// edit the gate used to refuse.

import { describe, expect, it } from "vitest";
import { checkWeakHash } from "../../checks/agent-safety-crypto.js";

describe("ubs_weak_hash — negative (must not fire)", () => {
	it("N1: Python hashlib.md5(..., usedforsecurity=False) — the stdlib's own non-security marker", () => {
		const code =
			"import hashlib\n\ndef cache_key(payload: bytes) -> str:\n    return hashlib.md5(payload, usedforsecurity=False).hexdigest()\n";
		expect(checkWeakHash(code, "src/cache/keys.py")).toEqual([]);
	});

	it("N2: usedforsecurity=False on a LATER line of a multi-line call", () => {
		const code = "digest = hashlib.md5(\n    payload,\n    usedforsecurity=False,\n).hexdigest()\n";
		expect(checkWeakHash(code, "src/cache/keys.py")).toEqual([]);
	});

	it("N3: a function DECLARATION named md5 (a wrapper module)", () => {
		const code =
			'export function md5(input: string): string {\n\treturn createHash("sha256").update(input).digest("hex").slice(0, 32);\n}\n';
		expect(checkWeakHash(code, "src/util/md5.ts")).toEqual([]);
	});

	it("N4: a .d.ts ambient declaration of a third-party md5 package", () => {
		const code =
			'declare module "md5" {\n\tfunction md5(message: string | Uint8Array): string;\n\texport = md5;\n}\n';
		expect(checkWeakHash(code, "types/md5.d.ts")).toEqual([]);
	});

	it("N5: Python `def sha1(` and Go `func md5(` and Rust `pub fn md5(` declaration lines", () => {
		expect(checkWeakHash("def sha1(data: bytes) -> str:\n    ...\n", "src/git/objects.py")).toEqual([]);
		expect(checkWeakHash("func md5(b []byte) string {\n", "pkg/hash/md5.go")).toEqual([]);
		expect(checkWeakHash("pub fn md5(bytes: &[u8]) -> [u8; 16] {\n    compute(bytes)\n}\n", "src/digest.rs")).toEqual([]);
	});

	it("N6: an interface member signature named md5", () => {
		const code = "export interface Hasher {\n\tmd5(buf: Uint8Array): string;\n\tsha256(buf: Uint8Array): string;\n}\n";
		expect(checkWeakHash(code, "src/hash/types.ts")).toEqual([]);
	});

	it("N7: a class method definition and a JS object-method shorthand named md5", () => {
		expect(
			checkWeakHash(
				'export class Hasher {\n\tmd5(buf: Uint8Array): string {\n\t\treturn this.digest("sha256", buf);\n\t}\n}\n',
				"src/hash/hasher.ts",
			),
		).toEqual([]);
		expect(
			checkWeakHash("const api = {\n\tmd5(buf) {\n\t\treturn x(buf);\n\t},\n};\n", "src/hash/hasher.js"),
		).toEqual([]);
	});

	it("N8: a Gravatar URL — the protocol mandates MD5 of the e-mail", () => {
		const code =
			"export function gravatarUrl(email: string): string {\n\tconst hash = md5(email.trim().toLowerCase());\n\treturn `https://www.gravatar.com/avatar/${hash}?d=identicon`;\n}\n";
		expect(checkWeakHash(code, "src/ui/avatar.ts")).toEqual([]);
		expect(
			checkWeakHash("const h = md5(email); // gravatar requires md5\n", "src/ui/avatar.ts"),
		).toEqual([]);
	});

	it("N9: Markdown prose that names hashlib.md5( as the anti-pattern", () => {
		const code = "# Hashing\n\nDo not call hashlib.md5(data) for passwords; use argon2.\n";
		expect(checkWeakHash(code, "docs/crypto-policy.md")).toEqual([]);
	});

	it("N10: a multi-line Python docstring that mentions hashlib.md5(", () => {
		const code = [
			"def key(x):",
			'    """Build a cache key.',
			"",
			"    Never hashlib.md5(x) here: keys are sha256.",
			'    """',
			"    return hashlib.sha256(x).hexdigest()",
			"",
		].join("\n");
		expect(checkWeakHash(code, "src/cache/keys.py")).toEqual([]);
	});

	it("N11: a Prettier multi-line method signature named md5 (round 2)", () => {
		const code = [
			"export class Hasher {",
			"\tmd5(",
			"\t\tbuf: Uint8Array,",
			'\t\tencoding: "hex" | "base64" = "hex",',
			"\t): string {",
			'\t\treturn this.digest("sha256", buf, encoding);',
			"\t}",
			"}",
			"",
		].join("\n");
		expect(checkWeakHash(code, "src/hash/hasher.ts")).toEqual([]);
	});

	it("N12: a method signature whose parameter type has its own parens (round 2)", () => {
		const code =
			'export class Hasher {\n\tsha1(data: string, cb: (err: Error | null, hex: string) => void): void {\n\t\tthis.run("sha256", data, cb);\n\t}\n}\n';
		expect(checkWeakHash(code, "src/hash/hasher.ts")).toEqual([]);
	});

	it("N13: an inline TS type-literal member named md5 (round 2)", () => {
		expect(checkWeakHash("type HashFn = { md5(buf: Uint8Array): string };\n", "src/util/types.ts")).toEqual([]);
	});

	it("N14: JSX text that names md5() on one line (round 2)", () => {
		const code = "export const Policy = () => (\n\t<p>We never use md5() for passwords.</p>\n);\n";
		expect(checkWeakHash(code, "src/ui/Policy.tsx")).toEqual([]);
	});
});

describe("ubs_weak_hash — positive (must fire)", () => {
	it("P6: a multi-line CALL statement is not a signature (round 2)", () => {
		expect(checkWeakHash("md5(\n\tbuf,\n);\n", "src/x.ts").map((m) => m.line)).toEqual([1]);
	});

	it("P7: a JSX expression call and a call after an inline type member still fire (round 2)", () => {
		expect(checkWeakHash("const el = <p>{md5(email)}</p>;\n", "src/ui/a.tsx")).toHaveLength(1);
		expect(
			checkWeakHash("type H = { md5(b: Uint8Array): string }; const x = md5(y);\n", "src/a.ts"),
		).toHaveLength(1);
	});

	it("P1: the declaration is exempt but the call in its body still fires", () => {
		const code = "def sha1(data: bytes) -> str:\n    return hashlib.sha1(data).hexdigest()\n";
		expect(checkWeakHash(code, "src/git/objects.py").map((m) => m.line)).toEqual([2]);
	});

	it("P2: usedforsecurity=True is explicitly security-bearing", () => {
		expect(checkWeakHash("h = hashlib.md5(x, usedforsecurity=True)\n", "src/auth/pw.py")).toHaveLength(1);
	});

	it("P3: a bare call statement and a call in a condition are not signatures", () => {
		const out = checkWeakHash("md5(buf);\nif (md5(a) === md5(b)) {\n", "src/x.ts");
		expect(out.map((m) => m.line)).toEqual([1, 2]);
	});

	it("P4: a docstring does not hide a real hashlib.md5( call on the next code line", () => {
		const code = 'def f():\n    """Never hashlib.md5(x)."""\n    return hashlib.md5(x)\n';
		expect(checkWeakHash(code, "a.py").map((m) => m.line)).toEqual([3]);
	});

	it("P5: Node createHash(\"md5\") with a block-ish argument on the call line", () => {
		expect(
			checkWeakHash('const h = createHash("md5").update(buf, { encoding: "hex" });\n', "src/auth.ts"),
		).toHaveLength(1);
	});
});
