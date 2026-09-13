import { extname } from "node:path";
import type { InlineMatch } from "../check-registry/types.js";

interface HtmlTag {
    name: string;
    closing: boolean;
    attributes: string;
    offset: number;
}

// Consume whole quoted attributes, including any markup inside them.
const TAG = /<\/?([a-z][^\t\n\f\r />]*)([\t\n\f\r /](?:[^<>"']|"[^"]*"|'[^']*')*)?>/iy;
const TEXT_ELEMENTS = new Set([
    "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript",
]);

function skipDeclaration(content: string, start: number): number | null {
    if (content.startsWith("<!--", start)) {
        const end = content.indexOf("-->", start + 4);
        return end < 0 ? content.length : end + 3;
    }
    if (!/^<[!?]/.test(content.slice(start, start + 2))) return null;
    const end = content.indexOf(">", start + 2);
    return end < 0 ? content.length : end + 1;
}

function skipTextContent(content: string, tag: HtmlTag, cursor: number): number {
    if (tag.closing) return cursor;
    if (tag.name === "plaintext") return content.length;
    if (!TEXT_ELEMENTS.has(tag.name)) return cursor;
    const endTag = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])[^>]*>`, "ig");
    endTag.lastIndex = cursor;
    return endTag.exec(content) ? endTag.lastIndex : content.length;
}

function* htmlTags(content: string): Generator<HtmlTag> {
    const pattern = new RegExp(TAG);
    let cursor = 0;
    while (cursor < content.length) {
        const start = content.indexOf("<", cursor);
        if (start < 0) return;
        const declarationEnd = skipDeclaration(content, start);
        if (declarationEnd !== null) {
            cursor = declarationEnd;
            continue;
        }
        pattern.lastIndex = start;
        const match = pattern.exec(content);
        if (!match) {
            // Do not reinterpret an incomplete tag's quoted contents as tags.
            if (/^<\/?[a-z]/i.test(content.slice(start, start + 3))) return;
            cursor = start + 1;
            continue;
        }
        const attributes = match[2] ?? "";
        const tag = {
            name: (match[1] ?? "").toLowerCase(),
            closing: content[start + 1] === "/",
            attributes,
            offset: pattern.lastIndex - 1 - attributes.length,
        };
        yield tag;
        cursor = skipTextContent(content, tag, pattern.lastIndex);
    }
}

function* outsideTemplates(content: string): Generator<HtmlTag> {
    let depth = 0;
    for (const tag of htmlTags(content)) {
        if (tag.name === "template" && tag.closing) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth === 0) yield tag;
        if (tag.name === "template" && !tag.closing) depth++;
    }
}

function* bodyTags(content: string): Generator<HtmlTag> {
    let inBody = false;
    for (const tag of outsideTemplates(content)) {
        if (tag.name === "body") {
            if (tag.closing) return;
            inBody = true;
        }
        if (inBody && !tag.closing) yield tag;
    }
}

function staticId(tag: HtmlTag): { value: string; offset: number } | null {
    const attributes = /([^\t\n\f\r /=>]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]+)))?/g;
    for (const match of tag.attributes.matchAll(attributes)) {
        if (match[1]?.toLowerCase() !== "id") continue;
        const value = match[2] ?? match[3] ?? match[4] ?? "";
        // HTML keeps the first duplicate attribute on one element. Dynamic
        // template expressions are not evidence of a fixed DOM identifier.
        if (!value || /[{}]|<%|%>/.test(value)) return null;
        return { value, offset: tag.offset + match.index };
    }
    return null;
}

/** Lexical, case-sensitive ID reuse inside an explicit body in .html/.htm.
 * Script/raw-text and inert template contents are excluded. Entity spellings
 * are compared literally; runtime DOM changes and template control flow are
 * not evaluated. This is a warning, never a pre-execution block.
 */
export function checkHtmlDuplicateId(content: string, filePath: string): InlineMatch[] {
    if (!/^[.]html?$/.test(extname(filePath).toLowerCase())) return [];
    const matches: InlineMatch[] = [];
    const seen = new Map<string, number>();
    let line = 1;
    let cursor = 0;
    for (const tag of bodyTags(content)) {
        const id = staticId(tag);
        if (!id) continue;
        line += (content.slice(cursor, id.offset).match(/\r\n?|\n/g) ?? []).length;
        cursor = id.offset;
        const firstLine = seen.get(id.value);
        if (firstLine === undefined) {
            seen.set(id.value, line);
            continue;
        }
        matches.push({
            line,
            text: `Duplicate HTML id ${JSON.stringify(id.value).slice(0, 80)}; first used on line ${firstLine}.`,
        });
    }
    return matches;
}
