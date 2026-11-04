import { join } from "node:path";
import { expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
    read: vi.fn<(path: string) => string[]>(),
    stat: vi.fn<(path: string) => { size: number; isDirectory(): boolean; isFile(): boolean }>(),
}));
vi.mock("node:child_process", () => ({ execSync: () => { throw new Error("Git unavailable"); } }));
vi.mock("node:fs", () => ({ readdirSync: filesystem.read, statSync: filesystem.stat }));
import { discoverFiles, discoverFunctionTokenFiles } from "./file-discovery.js";

it.each([
    { entries: ["src", "z.ts", "a.ts", "scratch"] },
    { entries: ["z.ts", "a.ts", "scratch", "src"] },
])("prioritizes src and stops both child and parent walks at the shared file budget ($entries)", ({ entries }) => {
    filesystem.read.mockReset(); filesystem.stat.mockReset();
    const root = "/virtual-project", source = join(root, "src");
    const names = Array.from({ length: 50_001 }, (_, i) => `${String(i).padStart(5, "0")}.ts`);
    filesystem.read.mockImplementation(path => {
        if (path === root) return [...entries];
        if (path === source) return names;
        throw new Error(`Unexpected traversal: ${path}`);
    });
    filesystem.stat.mockImplementation(path => ({
        size: 1, isDirectory: () => path === source, isFile: () => path !== source,
    }));
    const files = discoverFiles(root);
    expect(files).toHaveLength(50_000);
    expect(files[0]).toBe(join(source, "00000.ts"));
    expect(files.at(-1)).toBe(join(source, "49999.ts"));
    expect(filesystem.read.mock.calls.map(([path]) => path)).toEqual([root, source]);
    expect(filesystem.stat).not.toHaveBeenCalledWith(join(source, "50000.ts"));
    expect(filesystem.stat).not.toHaveBeenCalledWith(join(root, "a.ts"));
});

it("keeps token discovery away from ignored, non-file and over-budget directories", () => {
    filesystem.read.mockReset(); filesystem.stat.mockReset();
    const root = "/virtual-project", source = join(root, "src"), later = join(root, "later");
    const names = Array.from({ length: 50_000 }, (_, i) => `${i}.ts`);
    filesystem.read.mockImplementation(path => {
        if (path === root) return [".git", "socket", "src", "later"];
        if (path === source) return names;
        throw new Error(`Unexpected traversal: ${path}`);
    });
    filesystem.stat.mockImplementation(path => ({
        size: 1, isDirectory: () => path === source || path === later,
        isFile: () => path.startsWith(`${source}/`),
    }));
    const files = discoverFunctionTokenFiles(root);
    expect(files).toHaveLength(50_000);
    expect(files[0]).toBe(join(source, "0.ts"));
    expect(files.at(-1)).toBe(join(source, "49999.ts"));
    expect(filesystem.read.mock.calls.map(([path]) => path)).toEqual([root, source]);
    expect(filesystem.stat).not.toHaveBeenCalledWith(join(root, ".git"));
    expect(files).not.toContain(join(root, "socket"));
});
