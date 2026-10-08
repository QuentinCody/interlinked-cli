import { describe, expect, it } from "vitest";
import { scanSecrets } from "./signatures.js";

describe("signature regex-source retry budget", () => {
    it("fails closed when regex-like credential spans exhaust the retry budget", () => {
        const sourceSpan = ["postgres", "://", "[user]", ":", "[value]", "@"].join("");
        expect(scanSecrets(sourceSpan.repeat(255))).toEqual([]);
        const matches = scanSecrets(sourceSpan.repeat(256));
        expect(matches.map(({ rule_id, matched_text, severity }) => ({ rule_id, matched_text, severity }))).toEqual([
            { rule_id: "sig-secret-db-connection", matched_text: sourceSpan, severity: "critical" },
        ]);
    });
});
