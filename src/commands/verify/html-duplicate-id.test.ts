import { describe, expect, it } from "vitest";
import { buildAgentSafetyChecks } from "../../harness/check-registry/builders.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { runPerFileChecks } from "./file-checks.js";
import { emptyResults } from "./tool-results-types.js";

const content = '<body>\n<div id="panel"></div>\n<script>const html = `<p id="panel">`;</script>\n<p id="panel"></p>\n</body>';

describe("duplicate HTML ID pipeline", () => {
    it("reports the same location through verify and PostToolUse after an ID-only edit", () => {
        const r = emptyResults();
        runPerFileChecks({
            file: "/tmp/index.html", content, cwd: "/tmp", r,
            moduleExportsCache: new Map(), allEnvRefs: new Map(), piiOpts: {},
        });
        expect(r.htmlDuplicateId).toEqual([{
            check: "html_duplicate_id", file: "index.html", line: 4,
            message: 'Duplicate HTML id "panel"; first used on line 2.',
        }]);
        const oldContent = content.replace('<p id="panel"></p>', '<p id="other"></p>');
        const post = buildAgentSafetyChecks(content, "/tmp/index.html", "post", oldContent)
            .find((check) => check.name === "html_duplicate_id");
        expect(post?.severity).toBe("warning");
        expect(post?.fn()).toEqual([{
            line: 4, text: 'Duplicate HTML id "panel"; first used on line 2.',
        }]);
    });

    it("runs by default, supports explicit skip, and never blocks pre-execution", () => {
        expect(getEffectiveSkipChecks(undefined, false).has("html_duplicate_id")).toBe(false);
        expect(getEffectiveSkipChecks("html_duplicate_id", false).has("html_duplicate_id")).toBe(true);
        expect(buildAgentSafetyChecks(content, "index.html", "pre_block")
            .some((check) => check.name === "html_duplicate_id")).toBe(false);
    });
});
