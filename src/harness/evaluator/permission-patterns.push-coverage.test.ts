import { describe, expect, it } from "vitest";
import { extractPermissionPattern } from "./permission-patterns.js";

describe("WebFetch proposal URL boundaries", () => {
    it.each(["https://", "http://", "https://?q=secret", "file:///tmp/input", "data:text/plain,hello"])(
        "does not propose a domain permission for %s", (url) => {
            expect(extractPermissionPattern("WebFetch", { url })).toBeNull();
        },
    );
    it("proposes only the normalized hostname, excluding credentials, port, and path", () => {
        expect(extractPermissionPattern("web_fetch", { url: "https://reader@example.COM:8443/private?q=1" }))
            .toBe("WebFetch(domain:example.com)");
    });
});
