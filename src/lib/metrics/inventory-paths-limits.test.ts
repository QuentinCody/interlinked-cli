import { expect, it, vi, beforeEach } from "vitest";
import { inventoryPaths } from "./inventory-paths.js";

const io = vi.hoisted(() => ({ git: vi.fn(), read: vi.fn(), exists: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: io.git }));
vi.mock("node:fs", () => ({ readdirSync: io.read, existsSync: io.exists }));
beforeEach(() => { io.git.mockReset(); io.read.mockReset(); io.exists.mockReset(); io.exists.mockReturnValue(false); });
const foreground = { resourcePolicy: "foreground-survey" } as const;
function entry(name: string, directory = false) { return { name, isDirectory: () => directory }; }

it("retains more than fifty thousand filesystem entries and later sibling directories only for explicit foreground surveys", () => {
	io.git.mockImplementation(() => { throw new Error("not a Git repository"); });
	const population = Array.from({ length: 50_001 }, (_, index) => entry(`${index}.ts`));
	io.read.mockImplementation((path: string) => path === "/project" ? [entry("src", true), entry("later", true)] : path === "/project/src" ? population : [entry("end.ts")]);
	const full = inventoryPaths("/project", foreground);
	expect(full.paths).toHaveLength(50_002);
	expect(full.paths).toContain("src/50000.ts"); expect(full.paths).toContain("later/end.ts"); expect(full.issues).toEqual([]);
	const runtime = inventoryPaths("/project");
	expect(runtime.paths).toHaveLength(50_000); expect(runtime.issues.join(" ")).toMatch(/50000/);
});

it("keeps bounded runtime Git options and removes only foreground Git deadline and capture limits", () => {
	io.git.mockReturnValue("last.ts\0");
	expect(inventoryPaths("/project", foreground).paths).toEqual(["last.ts"]);
	expect(io.git.mock.calls[0]?.[2]).toMatchObject({ timeout: 0, maxBuffer: Infinity });
	io.git.mockClear(); inventoryPaths("/project");
	expect(io.git.mock.calls[0]?.[2]).toMatchObject({ timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
});

it("retains a known-worktree Git discovery failure without substituting ignored filesystem source", () => {
	io.git.mockImplementation((_bin: string, args: string[]) => {
		if (args.includes("--is-inside-work-tree")) return "true\n";
		throw new Error("Git enumeration failed: EIO");
	});
	io.read.mockReturnValue([entry("ignored.ts")]);
	const result = inventoryPaths("/project", foreground);
	expect(result.paths).toEqual([]); expect(result.issues.join(" ")).toMatch(/Git.*EIO/);
	expect(io.read).not.toHaveBeenCalled();
});

it("retains directory read failures and continues readable sibling populations", () => {
	io.git.mockImplementation(() => { throw new Error("not a Git repository"); });
	io.read.mockImplementation((path: string) => {
		if (path === "/project") return [entry("broken", true), entry("source", true)];
		if (path.endsWith("broken")) throw new Error("EACCES unreadable directory");
		return [entry("last.ts")];
	});
	const result = inventoryPaths("/project", foreground);
	expect(result.paths).toEqual(["source/last.ts"]); expect(result.issues.join(" ")).toMatch(/broken.*EACCES/);
});

it("propagates caller cancellation instead of turning it into a discovery fallback", () => {
	const controller = new AbortController(); controller.abort(new Error("survey cancelled"));
	expect(() => inventoryPaths("/project", { ...foreground, signal: controller.signal })).toThrow("survey cancelled");
	expect(io.git).not.toHaveBeenCalled(); expect(io.read).not.toHaveBeenCalled();
});

it("observes cancellation after a synchronous Git call before publishing its paths", () => {
	const controller = new AbortController();
	io.git.mockImplementation(() => { controller.abort(new Error("cancelled during native discovery")); return "last.ts\0"; });
	expect(() => inventoryPaths("/project", { ...foreground, signal: controller.signal })).toThrow("cancelled during native discovery");
	expect(io.read).not.toHaveBeenCalled();
});
