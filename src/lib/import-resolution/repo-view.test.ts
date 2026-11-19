import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsRepoView, mapRepoView } from "./repo-view.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "repo-view-"));
	dirs.push(root);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
	return root;
}

describe("mapRepoView", () => {
	const view = mapRepoView(new Map([["a/package.json", "{}"], ["a/src/x.ts", "x"], ["b/tsconfig.json", "{}"]]));
	it("P1: reads, tests and lists the files it holds", () => {
		expect(view.read("a/src/x.ts")).toBe("x");
		expect(view.isFile("a/src/x.ts")).toBe(true);
		expect(view.configFiles()).toEqual(["a/package.json", "b/tsconfig.json"]);
	});
	it("N1: reports a missing file as absent", () => {
		expect(view.read("nope")).toBeNull();
		expect(view.isFile("nope")).toBe(false);
	});
});

describe("fsRepoView", () => {
	it("P1: finds config files in a plain directory and skips node_modules", () => {
		const root = tree({
			"package.json": "{}",
			"apps/web/tsconfig.json": "{}",
			"apps/web/svelte.config.js": "x",
			"node_modules/pkg/package.json": "{}",
			"apps/web/src/a.ts": "a",
		});
		const view = fsRepoView(root);
		expect(view.configFiles()).toEqual(["apps/web/svelte.config.js", "apps/web/tsconfig.json", "package.json"]);
		expect(view.isFile("apps/web/src/a.ts")).toBe(true);
		expect(view.read("apps/web/tsconfig.json")).toBe("{}");
	});
	it("N1: a directory is not a file and an unreadable path reads null", () => {
		const root = tree({ "d/x.ts": "x" });
		const view = fsRepoView(root);
		expect(view.isFile("d")).toBe(false);
		expect(view.read("d")).toBeNull();
		expect(view.read("../outside")).toBeNull();
	});
});
