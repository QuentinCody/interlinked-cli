export interface Receipt {
    id: string; text: string; source: string; version: string; callId: string; capturedComplete?: boolean;
}
export interface Block { id: string; start: number; end: number; text: string; mandatory: boolean; }
export interface Options {
    question?: string; budgetChars: number; minChars?: number; full?: boolean; baseline?: string;
}
export interface View {
    receiptId: string; source: string; version: string; capturedComplete: boolean | null;
    mode: string; fullText?: string; baseline?: string; spans?: Block[]; omittedBlocks?: number;
    omittedChars?: number; budgetExceeded?: boolean; expand: string; offsets: "UTF-16";
}
export type Scorer = (blocks: Block[], question: string) => Promise<Record<string, number>>;
const FAILURE = /\b(?:error|failed|failure|fatal|timeout|cancelled|canceled|truncated|incomplete|not checked)\b|\bexit(?:ed)?(?:\s+with)?[\s_]*(?:code)?["']?\s*[:=]?\s*-?[1-9]\d*\b/i;
export function splitBlocks(text: string): Block[] {
    const result: Block[] = [];
    let start = 0; let end = 0; let lines = 0;
    const flush = () => {
        if (end <= start) return;
        const value = text.slice(start, end);
        result.push({ id: String(result.length), start, end, text: value, mandatory: FAILURE.test(value) });
        start = end; lines = 0;
    };
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (lines >= 16 || end - start + line.length > 2000) flush();
        let remaining = line.length;
        while (remaining > 2000) {
            let length = 2000;
            if (/[\uD800-\uDBFF]/.test(text.charAt(end + length - 1))) length--;
            end += length; remaining -= length; flush();
        }
        end += remaining; lines++;
    }
    flush(); return result;
}
export function headTail(text: string, budget: number): string {
    if (text.length <= budget) return text;
    let head = Math.ceil(budget / 2); let tail = text.length - Math.floor(budget / 2);
    if (/[\uDC00-\uDFFF]/.test(text.charAt(head))) head--;
    if (/[\uDC00-\uDFFF]/.test(text.charAt(tail))) tail++;
    return text.slice(0, head) + "\n[output omitted]\n" + text.slice(tail);
}
function selectSpans(blocks: Block[], scores: Record<string, number>, budgetChars: number) {
    const selected = new Set(blocks.filter(block => block.mandatory).map(block => block.id));
    let characters = blocks.filter(block => selected.has(block.id)).reduce((sum, block) => sum + block.text.length, 0);
    for (const block of [...blocks].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0) || a.start - b.start)) {
        if (selected.has(block.id) || characters + block.text.length > budgetChars) continue;
        selected.add(block.id); characters += block.text.length;
    }
    return { spans: blocks.filter(block => selected.has(block.id)), characters };
}

export async function selectOutput(receipt: Receipt, options: Options, scorer: Scorer): Promise<View> {
    if (!Number.isSafeInteger(options.budgetChars) || options.budgetChars < 1) throw new Error("Invalid character budget");
    const view: View = { receiptId: receipt.id, source: receipt.source, version: receipt.version,
        capturedComplete: receipt.capturedComplete ?? null, mode: "full", offsets: "UTF-16",
        expand: "expand " + receipt.id + " [start end]" };
    if (options.full) return { ...view, fullText: receipt.text };
    const baseline = options.baseline ?? headTail(receipt.text, options.budgetChars);
    if (!options.question?.trim()) return { ...view, mode: "baseline", baseline };
    if (receipt.text.length <= (options.minChars ?? 6000)) return { ...view, fullText: receipt.text };
    const blocks = splitBlocks(receipt.text);
    let scores: Record<string, number>;
    try {
        scores = await scorer(blocks, options.question);
        if (blocks.some(block => { const value = scores[block.id]; return typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1; })) {
            throw new Error("Incomplete or invalid scores");
        }
    } catch {
        const spans = blocks.filter(block => block.mandatory);
        return { ...view, mode: "fallback", baseline, spans,
            budgetExceeded: baseline.length + spans.reduce((sum, block) => sum + block.text.length, 0) > options.budgetChars };
    }
    const { spans, characters } = selectSpans(blocks, scores, options.budgetChars);
    return { ...view, mode: "selected", spans, omittedBlocks: blocks.length - spans.length,
        omittedChars: receipt.text.length - characters, budgetExceeded: characters > options.budgetChars };
}
