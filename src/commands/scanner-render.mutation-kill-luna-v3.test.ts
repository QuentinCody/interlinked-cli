import { describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/formatter.js";
import {
    isPickError,
    pickFlagDecision,
    pickReview,
    renderReview,
    renderStatus,
    renderToggleResult,
} from "./scanner-render.js";

describe("scanner render helpers", () => {
    // test-contract: only non-null objects carrying an error field are pick errors.
    it("recognizes pick errors without accepting null or primitives", () => {
        expect(isPickError({ error: "bad" })).toBe(true);
        expect(isPickError(null)).toBe(false);
        expect(isPickError("bad")).toBe(false);
    });

    // test-contract: no decision flags selected produces an undefined decision.
    it("returns no flag decision when all flags are false", () => {
        expect(pickFlagDecision({ allow: false, redact: false, block: false })).toBeUndefined();
    });

    // test-contract: an unknown requested key is reported as an error rather than selecting a review.
    it("reports a missing requested review key", () => {
        expect(pickReview([{ key: "newest", path: "/repo/review.json", timestamp: "2026-01-01T00:00:00Z", url: "https://example.test", tool_name: "WebFetch", finding_count: 0 }], "missing")).toEqual({
            error: 'no pending review with key "missing"',
        });
    });

    // test-contract: an empty pending-review list has no selectable review.
    it("returns null for an empty review list", () => {
        expect(pickReview([], undefined)).toBeNull();
    });

    // test-contract: an absent reason is omitted from toggle output.
    it("does not render an undefined toggle reason", () => {
        const output = renderToggleResult({
            cwd: "/repo",
            current: false,
            target: true,
            opts: {},
            localRulesPath: "/repo/rules",
            auditPath: "/repo/audit",
        });
        expect(output).not.toContain("reason: undefined");
    });

    // test-contract: findings are highlighted in source order while preserving intervening body text.
    it("highlights findings at their original positions", () => {
        const output = stripAnsi(renderReview({
            timestamp: "2026-01-01T00:00:00Z", prompt: "Fetch page", tool_name: "WebFetch", cache_key: "review", redacted_body: "<EMAIL> and <NAME>",
            url: "https://example.test",
            findings: [
                { start: 10, end: 13, label: "name", text: "bob", source: "test" },
                { start: 0, end: 5, label: "email", text: "alice", source: "test" },
            ],
            body: "alice and bob",
        }));
        expect(output).toContain("alice <EMAIL> and bob <NAME>");
    });

    // test-contract: a review with no findings renders an empty findings section without injected content.
    it("renders an empty review without sentinel lines", () => {
        const output = renderReview({
            timestamp: "2026-01-01T00:00:00Z", prompt: "Fetch page", tool_name: "WebFetch", cache_key: "review", redacted_body: "No personal data.",
            url: "https://example.test",
            findings: [],
            body: "No personal data.",
        });
        expect(output).toContain("Findings");
        expect(output).toContain("0");
        expect(output).not.toContain("Stryker was here");
    });

    // test-contract: a status without audit entries omits recent activity entirely.
    it("renders status without a recent-activity section when history is empty", () => {
        const output = renderStatus({
            enabled: true,
            runtime_status: null,
            last_audit: [],
            local_rules_path: "/repo/rules",
            audit_path: "/repo/audit",
        });
        expect(output).not.toContain("Recent Activity");
        expect(output).not.toContain("Stryker was here");
    });

    // test-contract: a no-op toggle still renders its primary state and does not inject array content.
    it("renders an unchanged toggle without sentinel lines", () => {
        const output = renderToggleResult({
            cwd: "/repo",
            current: true,
            target: true,
            opts: {},
            localRulesPath: "/repo/rules",
            auditPath: "/repo/audit",
        });
        expect(output).toContain("PII filter: ENABLED (already on)");
        expect(output).not.toContain("Stryker was here");
    });
});
