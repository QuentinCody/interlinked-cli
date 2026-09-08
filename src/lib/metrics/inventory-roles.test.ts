import { describe, expect, it } from "vitest";
import { isDependencyLockfile, sourceRole } from "./inventory-roles.js";

describe("dependency lockfile roles", () => {
    it.each(["yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "Podfile.lock", "Pipfile.lock", "poetry.lock", "uv.lock",
        "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "packages.lock.json", ".terraform.lock.hcl"])("retains %s as dependency configuration", name => {
        expect(isDependencyLockfile(`packages/service/${name}`)).toBe(true);
        expect(sourceRole(`packages/service/${name}`)).toBe("configuration");
    });

    it.each(["src/clock.ts", "src/file-mutation-lock.ts", "src/block.js", "src/lockfile.ts", "src/locks.py", "src\\clock.ts"])("keeps lock-named implementation %s in the product scope", path => {
        expect(isDependencyLockfile(path)).toBe(false);
        expect(sourceRole(path)).toBe("product");
    });
});
