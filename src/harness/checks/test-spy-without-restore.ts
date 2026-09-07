// CLASS: a spy replaces a shared method and can leak into subsequent tests.
// FIRES WHEN: vi.spyOn/jest.spyOn in an active test or setup has no same-owner
// mockRestore/restoreAllMocks, applicable ancestor teardown, or discovered runner cleanup.
// DOES NOT FIRE: using/await using declarations, explicit restoration, skipped tests,
// objects/array literals created within a test (including property targets), restoreMocks:true,
// or applicable beforeEach/afterEach/afterAll restoration. clear/reset calls do not
// restore the original method. A sibling test's teardown is not applicable.
// CALIBRATION (2026-09-07, 2145 tracked tests; no independent precision measurement):
// | pass | hits/files | correction |
// | first | 55/21 | missing beforeEach, property restoration and local-object shapes |
// | second | 50/18 | recognized beforeEach, vi.mocked and direct local objects |
// | third | 44/16 | recognized properties of test-local objects |
// Pilot correction: test-local array literals are fresh too; module/suite arrays,
// shared-array aliases and Array.prototype still require restoration.
// Prototype 18/6 used a different regex/corpus scope. Advisory post warning only.
// KNOWN GAPS: aliases of vi/jest, helper cleanup and config merges/CLI overrides
// are unresolved; local restoration is lexical, not a control-flow proof. Config
// Factory-call freshness is assumed conservatively and can hide shared singletons.
// Config discovery uses the nearest package root, default config names and literal setup
// paths, never executes code; unreadable/dynamic explicit setup suppresses warnings.
// HOW TO EXTEND: add cleanup ownership cases to localRestores and P/N tests;
// extend config discovery separately without evaluating user config.
import type * as TS from "typescript";
import type { ParsedTsSource } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";
import { parseTestQuality, qualityBlocks, testCallKind, walkTestNodes, type QualityBlock } from "./test-quality-ast.js";
import { projectRestoresSpies } from "./test-spy-restore-config.js";

interface OwnedCall { call: TS.CallExpression; scope: TS.Node; hook: string | null; }

function ownerOf(parsed: ParsedTsSource, call: TS.CallExpression, blocks: QualityBlock[]): OwnedCall {
    const { ts, sf } = parsed;
    let current: TS.Node = call.parent;
    let hook: string | null = null;
    while (current !== sf) {
        const block = blocks.find((candidate) => candidate.body === current);
        if (block) return { call, scope: block.body, hook };
        if (ts.isCallExpression(current)) {
            const kind = testCallKind(ts, current.expression);
            if (kind && ["beforeEach", "beforeAll", "afterEach", "afterAll"].includes(kind.root)) hook = kind.root;
        }
        current = current.parent;
    }
    return { call, scope: sf, hook };
}

function assignedSpy(parsed: ParsedTsSource, call: TS.CallExpression): { name: string | null; using: boolean } {
    const { ts } = parsed;
    let node: TS.Node = call;
    while (ts.isPropertyAccessExpression(node.parent) || ts.isCallExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent)) {
        const using = ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Using) !== 0;
        return { name: ts.isIdentifier(parent.name) ? parent.name.text : null, using };
    }
    if (ts.isBinaryExpression(parent) && parent.right === node) return { name: parent.left.getText(), using: false };
    return { name: null, using: false };
}

function restoresSameSpy(parsed: ParsedTsSource, restore: TS.CallExpression, spy: TS.CallExpression, name: string | null): boolean {
    const { ts } = parsed;
    if (!ts.isPropertyAccessExpression(restore.expression)) return false;
    let receiver: TS.Expression = restore.expression.expression;
    if (["vi", "jest"].includes(receiver.getText()) && restore.expression.name.text === "restoreAllMocks") return true;
    if (restore.pos <= spy.pos && restore.end > spy.end) return true;
    if (ts.isCallExpression(receiver) && /^(?:vi|jest)\.mocked$/.test(receiver.expression.getText())) receiver = receiver.arguments[0] ?? receiver;
    if (receiver.getText() === name) return true;
    const [target, property] = spy.arguments;
    return target !== undefined && property !== undefined && ts.isStringLiteralLike(property)
        && receiver.getText() === `${target.getText()}.${property.text}`;
}

function localRestores(parsed: ParsedTsSource, spy: OwnedCall, restores: OwnedCall[], name: string | null): boolean {
    return restores.some((restore) => {
        if (!restoresSameSpy(parsed, restore.call, spy.call, name)) return false;
        const sameOwner = restore.scope === spy.scope && restore.hook === spy.hook && restore.call.end > spy.call.end;
        const ancestor = restore.scope.pos <= spy.scope.pos && restore.scope.end >= spy.scope.end;
        const teardown = ancestor && ["beforeEach", "afterEach", "afterAll"].includes(restore.hook ?? "");
        return sameOwner || teardown;
    });
}

function isTestBody(parsed: ParsedTsSource, scope: TS.Node): boolean {
    if (scope === parsed.sf) return false;
    const owner = scope.parent.parent;
    if (!parsed.ts.isCallExpression(owner)) return false;
    return ["it", "test", "specify"].includes(testCallKind(parsed.ts, owner.expression)?.root ?? "");
}

function targetRoot(parsed: ParsedTsSource, call: TS.CallExpression): TS.Identifier | null {
    let target = call.arguments[0];
    if (!target) return null;
    while (parsed.ts.isPropertyAccessExpression(target)) target = target.expression;
    return parsed.ts.isIdentifier(target) ? target : null;
}

function ownsFreshTarget(parsed: ParsedTsSource, spy: OwnedCall): boolean {
    const { ts } = parsed;
    const target = targetRoot(parsed, spy.call);
    if (!target || !isTestBody(parsed, spy.scope)) return false;
    let fresh = false;
    walkTestNodes(ts, spy.scope, (node) => {
        if (!ts.isVariableDeclaration(node) || node.pos > spy.call.pos || !node.initializer) return;
        const names = ts.isObjectBindingPattern(node.name) ? node.name.elements.map((element) => element.name.getText()) : [node.name.getText()];
        if (!names.includes(target.text)) return;
        const value = node.initializer;
        // Only the array itself is fresh, not entries destructured from it or
        // a same-named array declared in a separate nested scope.
        const arrayScope = node.parent.parent.parent;
        const localArray = ts.isIdentifier(node.name) && ts.isArrayLiteralExpression(value)
            && arrayScope.pos <= spy.call.pos && arrayScope.end >= spy.call.end;
        if (ts.isObjectLiteralExpression(value) || localArray
            || ts.isNewExpression(value) || ts.isCallExpression(value)) fresh = true;
    });
    return fresh;
}

function spyCalls(parsed: ParsedTsSource, blocks: QualityBlock[]): { spies: OwnedCall[]; restores: OwnedCall[] } {
    const { ts, sf } = parsed;
    const spies: OwnedCall[] = [];
    const restores: OwnedCall[] = [];
    walkTestNodes(ts, sf, (node): boolean | void => {
        if (!ts.isCallExpression(node)) return;
        const kind = testCallKind(ts, node.expression);
        if (!kind) return;
        if (kind.modifiers.some((modifier) => ["skip", "todo", "skipIf", "runIf"].includes(modifier))) return false;
        if (!ts.isPropertyAccessExpression(node.expression)) return;
        const method = node.expression.name.text;
        if (method === "spyOn" && ["vi", "jest"].includes(node.expression.expression.getText())) spies.push(ownerOf(parsed, node, blocks));
        if (["mockRestore", "restoreAllMocks"].includes(method)) restores.push(ownerOf(parsed, node, blocks));
    });
    return { spies, restores };
}

/** Report spies lacking visible applicable cleanup in source or discovered runner settings. */
export function checkSpyWithoutRestore(content: string, filePath: string): InlineMatch[] {
    const parsed = parseTestQuality(content, filePath);
    if (!parsed) return [];
    const { spies, restores } = spyCalls(parsed, qualityBlocks(parsed));
    if (spies.length === 0 || projectRestoresSpies(filePath)) return [];
    return spies.filter((spy) => {
        const assigned = assignedSpy(parsed, spy.call);
        return !assigned.using && !ownsFreshTarget(parsed, spy) && !localRestores(parsed, spy, restores, assigned.name);
    }).slice(0, 10).map((spy) => ({
        line: parsed.sf.getLineAndCharacterOfPosition(spy.call.getStart(parsed.sf)).line + 1,
        text: "spy_without_restore: no applicable restoration is visible for this spy. Use mockRestore in finally/teardown, using, or configure restoreMocks; clear/reset calls do not restore the original method.",
    }));
}
