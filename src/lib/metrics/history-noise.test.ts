import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobShapes, classifyHistoryPath, type HistoryVerdict, historyKind, resolveVerdicts, withShape } from "./history-noise.js";

const BUNDLE = `${"var f=function(a,b){return a+b},x=f(1,2),y=f(x,3);".repeat(600)}\n`;

describe("classifyHistoryPath", () => {
	// MUST-SET-ASIDE
	it.each([
		["pnpm-lock.yaml", "lockfile"],
		["apps/x/package-lock.json", "lockfile"],
		["Cargo.lock", "lockfile"],
		["prisma/migrations/migration_lock.toml", "lockfile"],
		["packages/db/src/migrations/meta/0009_snapshot.json", "migration snapshot"],
		["drizzle/meta/_journal.json", "migration snapshot"],
		["dist/app.js", "generated (path)"],
		["src/api_pb.ts", "generated (path)"],
		["libs/pdf.min.js", "vendor (tool-path)"],
		["vendor/x/y.go", "vendor (path)"],
	])("sets %s aside as %s", (path, reason) => {
		expect(classifyHistoryPath(path)).toEqual({ kind: "set-aside", reason });
	});
	// MUST-NOT-SET-ASIDE
	it.each([
		"src/app.ts", "src/lib/Panel.svelte", "scripts/run.py", "src/db/schema.sql", "styles/app.css", "index.html",
		"translations/de.json", "config/settings.yaml", "docs/guide.md", "package.json", "src/migrations/0001_init.sql",
		"src/snapshot.json", "tests/fixtures/meta/data.json",
	])("keeps %s", path => {
		expect(classifyHistoryPath(path).kind).not.toBe("set-aside");
	});
	it("names code and data apart", () => {
		expect(historyKind("src/app.ts")).toBe("code");
		expect(historyKind("src/Panel.svelte")).toBe("code");
		expect(historyKind("styles/app.css")).toBe("code");
		expect(historyKind("src/app.test.ts")).toBe("code");
		expect(historyKind("translations/de.json")).toBe("data");
		expect(historyKind("docs/guide.md")).toBe("data");
		expect(historyKind("config/settings.yaml")).toBe("data");
		expect(historyKind("Dockerfile")).toBe("data");
	});
});

describe("withShape", () => {
	it("sets a code or data verdict aside when the content is minified", () => {
		expect(withShape(classifyHistoryPath("site/app.js"), BUNDLE)).toEqual({ kind: "set-aside", reason: "generated (shape)" });
		expect(withShape(classifyHistoryPath("site/app.css"), BUNDLE)).toEqual({ kind: "set-aside", reason: "generated (shape)" });
	});
	it("keeps hand-written content and an earlier set-aside reason", () => {
		expect(withShape(classifyHistoryPath("src/a.ts"), "export const a = 1;\n").kind).not.toBe("set-aside");
		expect(withShape(classifyHistoryPath("pnpm-lock.yaml"), BUNDLE)).toEqual({ kind: "set-aside", reason: "lockfile" });
	});
});

describe("blobShapes (a real git repository)", () => {
	const roots: string[] = [];
	afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
	function repo(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "history-noise-"));
		roots.push(root);
		const git = (...args: string[]): void => { execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" }); };
		git("init", "-q");
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		return root;
	}
	it("finds the minified blob and nothing else", () => {
		const root = repo({ "site/app.js": BUNDLE, "src/a.ts": "export const a = 1;\n", "data/blob.json": `{"k":"${"QUJD".repeat(5000)}"}\n`, "gone.js": "x" });
		const found = blobShapes(root, [{ path: "site/app.js", rev: "HEAD" }, { path: "src/a.ts", rev: "HEAD" }, { path: "data/blob.json", rev: "HEAD" }, { path: "missing.js", rev: "HEAD" }]);
		expect([...found.keys()]).toEqual(["site/app.js"]);
		expect(found.get("site/app.js")).toMatch(/^mean line /);
	});
	it("reads a blob from an older revision", () => {
		const root = repo({ "site/app.js": BUNDLE });
		execFileSync("git", ["-C", root, "rm", "-q", "site/app.js"]);
		execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "rm"]);
		expect(blobShapes(root, [{ path: "site/app.js", rev: "HEAD" }]).size).toBe(0);
		expect(blobShapes(root, [{ path: "site/app.js", rev: "HEAD~1" }]).size).toBe(1);
	});
	it("resolves verdicts once per path: path rules first, then the blob shape of the surviving paths", () => {
		const root = repo({ "site/app.js": BUNDLE, "src/a.ts": "export const a = 1;\n", "pnpm-lock.yaml": "lockfileVersion: 9\n" });
		const cache = new Map<string, HistoryVerdict>();
		resolveVerdicts(root, [{ path: "site/app.js", rev: "HEAD" }, { path: "src/a.ts", rev: "HEAD" }, { path: "pnpm-lock.yaml", rev: "HEAD" }], cache);
		expect(cache.get("site/app.js")).toEqual({ kind: "set-aside", reason: "generated (shape)" });
		expect(cache.get("src/a.ts")).toEqual({ kind: "code" });
		expect(cache.get("pnpm-lock.yaml")).toEqual({ kind: "set-aside", reason: "lockfile" });
		cache.set("src/a.ts", { kind: "data" });
		resolveVerdicts(root, [{ path: "src/a.ts", rev: "HEAD" }], cache);
		expect(cache.get("src/a.ts")).toEqual({ kind: "data" });
	});
	it("returns nothing for an empty request or a directory that is not a repository", () => {
		expect(blobShapes(tmpdir(), []).size).toBe(0);
		expect(blobShapes(join(tmpdir(), "no-such-directory-for-history-noise"), [{ path: "a.js", rev: "HEAD" }]).size).toBe(0);
	});
});
