// ===========================================
// Legacy skill-copy recognition (pure, no filesystem)
// ===========================================
// Decides whether an unmanifested on-disk skill file is a copy that an older
// Interlinked installer wrote, so a refresh may replace it. `skill-installers.ts`
// reads the files; this module only compares text.
//
// Older installers rewrote the frontmatter `description` and left an extra
// blank line before the closing `---`. An exact compare therefore rejected
// every such copy as "unowned", and the `enforce` copies stayed stale. The
// compare below ignores the description value and frontmatter whitespace. It
// keeps the `name` line and the body byte for byte, so a user-authored skill
// that only shares the name is never matched.

const MASKED_DESCRIPTION = 'description: "__INTERLINKED_MANAGED_DESCRIPTION__"';
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function hasSkillName(content: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^name\\s*:\\s*${escaped}\\s*$`, "m").test(content);
}

/** Frontmatter lines without blank lines or trailing whitespace, with the
 * description value (inline, or a block scalar and its indented lines) masked. */
function comparableFrontmatterLines(frontmatter: string): string[] {
    const out: string[] = [];
    let inDescription = false;
    for (const raw of frontmatter.split("\n")) {
        const line = raw.trimEnd();
        if (line === "") continue;
        if (inDescription && /^\s/.test(line)) continue;
        inDescription = /^description\s*:/.test(line);
        out.push(inDescription ? MASKED_DESCRIPTION : line);
    }
    return out;
}

/** `content` in a form where the frontmatter description value and frontmatter
 * whitespace do not count. A file without frontmatter is returned unchanged. */
export function legacyComparableText(content: string): string {
    const match = FRONTMATTER.exec(content);
    if (match === null) return content;
    const lines = comparableFrontmatterLines(match[1] ?? "");
    return ["---", ...lines, "---", content.slice(match[0].length)].join("\n");
}

/** Recognizer for an unmanifested copy of `name`: it matches `expected` in
 * comparable form, or equals the evidenced old-installer bytes exactly. */
export function recognizedLegacySkill(
    expected: Buffer,
    name: string,
    evidencedLegacy?: Buffer,
): (content: Buffer) => boolean {
    const expectedText = legacyComparableText(expected.toString("utf-8"));
    return (content) => {
        const currentText = content.toString("utf-8");
        if (!hasSkillName(currentText, name)) return false;
        return (
            legacyComparableText(currentText) === expectedText ||
            evidencedLegacy?.equals(content) === true
        );
    };
}

/** Both headings the pre-native-Cursor installer emitted: the generated
 * teaching-skill alias used `# <name>`, the hand-written enforce alias used the
 * slash-command form `# /<name>`. Recognizing only the first left every
 * `.cursor/rules/enforce.mdc` un-flagged by `doctor` and undeleted by
 * uninstall. Both still require the canonical-path pointer as corroboration. */
export function recognizedCursorAlias(name: string): (content: Buffer) => boolean {
    const headings = [`# ${name} — Cursor rule alias`, `# /${name} — Cursor rule alias`];
    return (content) => {
        const text = content.toString("utf-8");
        return (
            headings.some((heading) => text.includes(heading)) &&
            text.includes(`.interlinked/skills/${name}/SKILL.md`)
        );
    };
}
