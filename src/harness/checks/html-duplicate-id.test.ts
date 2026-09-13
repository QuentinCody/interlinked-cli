import { describe, expect, it } from "vitest";
import { checkHtmlDuplicateId } from "./html-duplicate-id.js";

describe("checkHtmlDuplicateId", () => {
    it("MUST-FIRE: reports every repeated ID at its attribute line and references the first", () => {
        const html = '<body>\n<div id="panel"></div>\n<span\n id=panel></span>\n<a id=panel></a></body>';
        expect(checkHtmlDuplicateId(html, "index.html")).toEqual([
            { line: 4, text: 'Duplicate HTML id "panel"; first used on line 2.' },
            { line: 5, text: 'Duplicate HTML id "panel"; first used on line 2.' },
        ]);
    });

    it("MUST-FIRE: detects duplicates across mixed-case markup and different quotes", () => {
        expect(checkHtmlDuplicateId('<BODY><div ID = "x"></div><p id=\'x\'></p></BODY>', "index.HTM"))
            .toEqual([{ line: 1, text: 'Duplicate HTML id "x"; first used on line 1.' }]);
    });

    it.each(["\n", "\r\n", "\r"])("preserves %j line endings in locations", (newline) => {
        const html = ['<body id="x">', '<p id="x"></p>', '</body>'].join(newline);
        expect(checkHtmlDuplicateId(html, "index.html"))
            .toEqual([{ line: 2, text: 'Duplicate HTML id "x"; first used on line 1.' }]);
    });

    it.each([
        '<script>const html = `<div id="x"></div>`; const selector = "#x";</script>',
        '<script type="application/json">{"html":"<div id=\'x\'>"}</script>',
        '<!-- <div id="x"></div> -->',
        '<style>p::after { content: \'<div id="x">\'; }</style>',
        '<textarea><div id="x"></div></textarea>',
        '<title><div id="x"></div></title>',
        '<iframe><div id="x"></div></iframe>',
        '<noscript><div id="x"></div></noscript>',
        '<template><div id="x"></div><template><b id="x"></b></template></template>',
        '<div title=\'<i id="x"></i>\' data-id="x"></div>',
    ])("ignores non-element ID text and inert contents: %s", (excluded) => {
        const html = `<body><div id="x"></div>${excluded}<p id="x"></p></body>`;
        expect(checkHtmlDuplicateId(html, "index.html"))
            .toEqual([{ line: 1, text: 'Duplicate HTML id "x"; first used on line 1.' }]);
    });

    it("counts IDs on script and template elements themselves", () => {
        expect(checkHtmlDuplicateId('<body><script id=x></script><template id=x></template></body>', "index.html"))
            .toEqual([{ line: 1, text: 'Duplicate HTML id "x"; first used on line 1.' }]);
    });

    it.each([
        '<body><div id=x></div><p id=X></p></body>',
        '<body><div id=""></div><p id=""></p></body>',
        '<body><div id="{{ item.id }}"></div><p id="{{ item.id }}"></p></body>',
        '<body><div id="<%= item.id %>"></div><p id="<%= item.id %>"></p></body>',
        '<head><meta id=x><meta id=x></head><body><p id=x></p></body><p id=x></p>',
        '<div id=x></div><p id=x></p>',
        '<!-- <body><div id=x></div><p id=x></p></body> -->',
        '<template><body><div id=x></div><p id=x></p></body></template>',
        '<body><div id=x id=x></div></body>',
        '<body><div id=first id=x></div><p id=x></p></body>',
        '<body><div id=x></div><div title="id=\'x\'"></div></body>',
        '<body><div id=x></div><script>const html = \'<p id=x>\';',
        '<body><div id=x></div><!-- <p id=x>',
        '<body><div id=x></div><p title="unterminated <b id=x>',
        '<body><div id=x></div><plaintext><p id=x>',
    ])("MUST-NOT-FIRE: out-of-scope or ambiguous IDs: %s", (html) => {
        expect(checkHtmlDuplicateId(html, "index.html")).toEqual([]);
    });

    it("handles quoted greater-than signs and raw-text closing prefixes", () => {
        const html = '<!doctype html><body><div title=">" id=x></div><script>"</script-extra><p id=x>"</script><p id=x></p></body>';
        expect(checkHtmlDuplicateId(html, "index.html"))
            .toEqual([{ line: 1, text: 'Duplicate HTML id "x"; first used on line 1.' }]);
    });

    it.each(["index.ts", "index.tsx", "index.vue", "index.md", "index.xhtml"])("MUST-NOT-FIRE: unsupported file %s", (file) => {
        expect(checkHtmlDuplicateId('<body><div id=x></div><p id=x></p></body>', file)).toEqual([]);
    });

    it("MUST-NOT-FIRE: does not merge IDs across files", () => {
        const html = '<body><div id=x></div></body>';
        expect(checkHtmlDuplicateId(html, "one.html")).toEqual([]);
        expect(checkHtmlDuplicateId(html, "two.html")).toEqual([]);
    });
});
