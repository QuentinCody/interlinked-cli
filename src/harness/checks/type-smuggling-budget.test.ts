import { beforeEach, expect, it, vi } from "vitest";
import { checkTypeSmuggling } from "./type-smuggling.js";
const counts = vi.hoisted(() => ({ programs: 0 }));
vi.mock("./check-typescript.js", async () => {
    const ts = (await import("typescript")).default;
    const wrapped = new Proxy(ts, { get(target, property) {
        if (property === "createProgram") return (...args: any[]) => { counts.programs++; return Reflect.apply(target.createProgram, target, args); };
        return Reflect.get(target, property);
    } });
    return { loadCheckTypescript: () => wrapped, resetCheckTypescriptCache() {} };
});
beforeEach(() => { counts.programs = 0; });
it("MUST-NOT-BUILD a compiler program for aliases, comments, strings or only escape casts", () => {
    for (const source of ['import { x as y } from "./x";', '// values as Thing\nconst x = 1;', 'const x = "value as Thing";', 'const x = 1 as const;', 'const x = 1 as unknown;', 'const x = 1 as any;']) {
        expect(checkTypeSmuggling(source, "/repo/fast.ts")).toEqual([]);
    }
    expect(counts.programs).toBe(0);
});
it("MUST-BUILD and retain a real incompatible cast, including a nested escape", () => {
    expect(checkTypeSmuggling('const x = "hello" as number;', "/repo/real.ts").length).toBeGreaterThan(0);
    expect(checkTypeSmuggling('const x = "hello" as unknown as number;', "/repo/real2.ts").length).toBeGreaterThan(0);
    expect(counts.programs).toBe(2);
});
