// ===========================================
// Per-edit mutation — RepoProvisioner + the in-memory 1-node impl (build steps 3–4)
// ===========================================
// `applyChangeSet` is the non-destructive overlay primitive: apply the whole
// tool_input atomically to a COPY of the tree. The RepoProvisioner contract wraps
// it so the cloud Sandbox impl (real filesystem) and the in-memory impl share one
// shape; the Artifacts impl is the deferred optimization (stubbed, out of scope).

import { type ChangeSet, changedPaths, type FileOp, type PatchEdit } from "./changeset.js";
import { reconstructAfterContent } from "../apply-patch-content.js";

export type FileTree = Map<string, string>;

interface OverlaySnapshot {
	tree: FileTree;
	changedPaths: string[];
}

interface RepoProvisioner {
	seed(files: FileTree): Promise<void>;
	/** Apply the whole change set to a copy — for evaluation, not persisted. */
	applyOverlay(changeSet: ChangeSet): Promise<OverlaySnapshot>;
	/** Persist the change set into the session tree (on a measured-clean allow). */
	commitChange(changeSet: ChangeSet): Promise<void>;
	/** N independent worker roots for mutant fan-out (clj-mutate's unique roots). */
	forkCopy(n: number): Promise<FileTree[]>;
}

function applyEdits(content: string, edits: PatchEdit[]): string {
	let result = content;
	for (const e of edits) {
		const idx = result.indexOf(e.oldString);
		if (idx === -1) throw new Error(`patch oldString not found: ${JSON.stringify(e.oldString)}`);
		result = result.slice(0, idx) + e.newString + result.slice(idx + e.oldString.length);
	}
	return result;
}

function reconstructedV4aContent(
	tree: FileTree,
	op: Extract<FileOp, { kind: "apply_patch" }>,
): { sourcePath: string; after: string } {
	const sourcePath = op.section.fromPath ?? op.path;
	const after = reconstructAfterContent(op.section, tree.get(sourcePath) ?? "");
	if (after === null) throw new Error(`could not reconstruct apply_patch section for ${op.path}`);
	return { sourcePath, after };
}

function applyV4aOp(tree: FileTree, op: Extract<FileOp, { kind: "apply_patch" }>): void {
	const { sourcePath, after } = reconstructedV4aContent(tree, op);
	if (op.section.op === "delete") {
		tree.delete(sourcePath);
		return;
	}
	if (sourcePath !== op.path) tree.delete(sourcePath);
	tree.set(op.path, after);
}

function applyOp(tree: FileTree, op: FileOp): void {
	switch (op.kind) {
		case "write":
			tree.set(op.path, op.content);
			return;
		case "patch":
			tree.set(op.path, applyEdits(tree.get(op.path) ?? "", op.edits));
			return;
		case "apply_patch":
			applyV4aOp(tree, op);
			return;
		case "delete":
			tree.delete(op.path);
			return;
		case "rename": {
			const content = tree.get(op.from);
			if (content !== undefined) {
				tree.delete(op.from);
				tree.set(op.to, content);
			}
			return;
		}
	}
}

/** Apply a ChangeSet to a COPY of the tree (non-destructive) — the overlay primitive. */
export function applyChangeSet(tree: FileTree, changeSet: ChangeSet): FileTree {
	const next = new Map(tree);
	for (const op of changeSet.ops) applyOp(next, op);
	return next;
}

/**
 * The local 1-node RepoProvisioner — an in-memory file tree. The Sandbox impl
 * mirrors this contract over a real filesystem (`gitCheckout` + `writeFile`).
 */
export class InMemoryProvisioner implements RepoProvisioner {
	private tree: FileTree = new Map();

	seed(files: FileTree): Promise<void> {
		this.tree = new Map(files);
		return Promise.resolve();
	}

	applyOverlay(changeSet: ChangeSet): Promise<OverlaySnapshot> {
		return Promise.resolve({
			tree: applyChangeSet(this.tree, changeSet),
			changedPaths: changedPaths(changeSet),
		});
	}

	commitChange(changeSet: ChangeSet): Promise<void> {
		this.tree = applyChangeSet(this.tree, changeSet);
		return Promise.resolve();
	}

	forkCopy(n: number): Promise<FileTree[]> {
		return Promise.resolve(Array.from({ length: n }, () => new Map(this.tree)));
	}
}
