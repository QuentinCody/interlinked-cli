import { describe, expect, it } from "vitest";
import { extractPermissionPattern } from "../permission-patterns.js";

// Former compound/writer tests described behavior intentionally removed by plan A.
describe("permission proposal boundaries", () => {
    it.each(["git  status && echo done", "echo&&printf two", " npm test && echo done", "git checkout main", "python3", "bash", "node", "FOO=bar ls"])("rejects unqualified generalization: %s", (command) => {
        expect(extractPermissionPattern("Bash", { command })).toBeNull();
    });
});
