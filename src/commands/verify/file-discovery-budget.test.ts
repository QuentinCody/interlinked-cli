import { join } from "node:path";
import { expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
    read: vi.fn<(path: string) => string[]>(),
    stat: vi.fn<(path: string) => { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>(),
}));
vi.mock("node:child_process", () => ({ execSync: () => { throw new Error("Git unavailable"); } }));
vi.mock("node:fs", () => ({ readdirSync: filesystem.read, lstatSync: filesystem.stat, existsSync: () => false }));
import { discoverFiles, discoverFunctionTokenFiles } from "./file-discovery.js";

it.each([
    { entries: ["src", "z.ts", "a.ts", "scratch"] },
    { entries: ["z.ts", "a.ts", "scratch", "src"] },
])("retains the full source population and later siblings beyond 50,000 files ($entries)", ({ entries }) => {
    filesystem.read.mockReset(); filesystem.stat.mockReset();
    const root = "/virtual-project", source = join(root, "src");
    const names = Array.from({ length: 50_001 }, (_, i) => `${String(i).padStart(5, "0")}.ts`);
    filesystem.read.mockImplementation(path => {
        if (path === root) return [...entries];
        if (path === source) return names;
        throw new Error(`Unexpected traversal: ${path}`);
    });
    filesystem.stat.mockImplementation(path => ({
        isSymbolicLink: () => false, isDirectory: () => path === source, isFile: () => path !== source,
    }));
    const files = discoverFiles(root);
    expect(files).toHaveLength(50_003);
    expect(files).toContain(join(source, "00000.ts"));
    expect(files).toContain(join(source, "50000.ts"));
    expect(files).toContain(join(root, "a.ts"));
    expect(files).toContain(join(root, "z.ts"));
    expect(filesystem.read.mock.calls.map(([path]) => path)).toEqual([root, source]);
    expect(filesystem.stat).toHaveBeenCalledWith(join(source, "50000.ts"));
});

it("keeps token discovery away from ignored/non-file inputs and includes later directories", () => {
    filesystem.read.mockReset(); filesystem.stat.mockReset();
    const root = "/virtual-project", source = join(root, "src"), later = join(root, "later");
    const names = Array.from({ length: 50_000 }, (_, i) => `${i}.ts`);
    filesystem.read.mockImplementation(path => {
        if (path === root) return [".git", "socket", "src", "later"];
        if (path === source) return names;
        if (path === later) return ["last.ts"];
        throw new Error(`Unexpected traversal: ${path}`);
    });
    filesystem.stat.mockImplementation(path => ({
        isSymbolicLink: () => false, isDirectory: () => path === source || path === later,
        isFile: () => path.startsWith(`${source}/`) || path === join(later, "last.ts"),
    }));
    const files = discoverFunctionTokenFiles(root);
    expect(files).toHaveLength(50_001);
    expect(files).toContain(join(source, "49999.ts"));
    expect(files).toContain(join(later, "last.ts"));
    expect(filesystem.read.mock.calls.map(([path]) => path).sort()).toEqual([root, later, source].sort());
    expect(filesystem.stat).not.toHaveBeenCalledWith(join(root, ".git"));
    expect(files).not.toContain(join(root, "socket"));
});
