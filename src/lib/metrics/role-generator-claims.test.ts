import { describe, expect, it } from "vitest";
import { buildClaimIndex, type RawClaim, resolveClaims } from "./role-generator-claims.js";

const tracked = ["src/api/a.py", "src/api/b.py", "src/other.py", "web/gen/types.ts", "README.md", "lib/x.ts", "pkg/api.go"];
const claim = (path: string, baseDir = "", over: Partial<RawClaim> = {}): RawClaim => ({ tool: "t", path, baseDir, file: "cfg", line: 3, kind: "generator-config", ...over });

describe("resolveClaims", () => {
	it("MUST-FIRE: a directory output relative to the config directory resolves to a directory claim", () => {
		const { claims, skipped } = resolveClaims([claim("./gen", "web")], tracked);
		expect(skipped).toEqual([]);
		expect(claims.map((c) => [c.target, c.isDirectory])).toEqual([["web/gen", true]]);
	});

	it("MUST-FIRE: a file output resolves to that file only", () => {
		const { claims } = resolveClaims([claim("gen/types.ts", "web")], tracked);
		expect(claims.map((c) => [c.target, c.isDirectory])).toEqual([["web/gen/types.ts", false]]);
	});

	it("falls back to the repository root when the config-relative path does not exist", () => {
		expect(resolveClaims([claim("src/api", "web")], tracked).claims.map((c) => c.target)).toEqual(["src/api"]);
	});

	it("MUST-NOT-FIRE: a path that names nothing tracked is skipped and counted", () => {
		const { claims, skipped } = resolveClaims([claim("nowhere", "web")], tracked);
		expect(claims).toEqual([]);
		expect(skipped.map((s) => s.reason)).toEqual(["unresolved-path"]);
	});

	it("MUST-NOT-FIRE: the repository root and a generic top-level directory are too broad", () => {
		const { claims, skipped } = resolveClaims([claim("."), claim("src"), claim("lib"), claim("./")], tracked);
		expect(claims).toEqual([]);
		expect(skipped.map((s) => s.reason)).toEqual(["too-broad", "too-broad", "too-broad", "too-broad"]);
	});

	it("MUST-NOT-FIRE: a path with a shell variable is skipped, never guessed", () => {
		expect(resolveClaims([claim("$OUT/gen")], tracked).skipped.map((s) => s.reason)).toEqual(["variable-path"]);
	});

	it("MUST-NOT-FIRE: a path outside the repository is skipped", () => {
		expect(resolveClaims([claim("../../elsewhere", "web")], tracked).skipped.map((s) => s.reason)).toEqual(["outside-repository"]);
	});
});

describe("buildClaimIndex", () => {
	it("matches a file below a directory claim and a file claim exactly, and reports the first claim", () => {
		const { claims } = resolveClaims([claim("src/api"), claim("web/gen/types.ts")], tracked);
		const index = buildClaimIndex(claims);
		expect(index.match("src/api/a.py")?.target).toBe("src/api");
		expect(index.match("web/gen/types.ts")?.target).toBe("web/gen/types.ts");
		expect(index.match("src/other.py")).toBeNull();
		expect(index.match("src/apix/a.py")).toBeNull();
	});

	it("prefers the deepest claim", () => {
		const index = buildClaimIndex(resolveClaims([claim("web"), claim("web/api")], ["web/api/a.py", "web/b.py"]).claims);
		expect(index.match("web/api/a.py")?.target).toBe("web/api");
		expect(index.match("web/b.py")?.target).toBe("web");
	});
});
