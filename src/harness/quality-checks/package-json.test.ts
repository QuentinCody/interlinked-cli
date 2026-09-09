import { describe, expect, it } from "vitest";
import { checkPackageJsonConsistency } from "./package-json.js";

describe("package manifest shape boundaries", () => {
    it.each(["null", "[]", "42", '"manifest"'])("leaves non-object manifest %s to syntax/schema validation", (content) => {
        expect(checkPackageJsonConsistency(content)).toEqual([]);
    });

    it("ignores non-string dependency values while retaining genuine manifest findings", () => {
        const findings = checkPackageJsonConsistency(JSON.stringify({
            dependencies: { shared: "1.0.0", malformed: 5, invalid: "not a version" },
            devDependencies: { shared: "1.0.0", malformed: true },
            peerDependencies: null,
            optionalDependencies: ["not a dependency map"],
        }));
        expect(findings).toEqual([
            { kind: "duplicate", pkg: "shared", detail: '"shared" in both dependencies (1.0.0) and devDependencies (1.0.0)' },
            { kind: "invalid_semver", pkg: "invalid", detail: '"invalid": "not a version" in dependencies is not a valid version specifier' },
        ]);
    });
});
