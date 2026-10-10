/**
 * Rows: the blocks a page is built from. A row is a child of the document or
 * of a column, so a list or a table is one row, and a columns block is one row
 * of the document while each of its columns holds rows of its own. Moving,
 * selecting and inserting blocks all work on rows.
 */

import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, type Selection } from "@tiptap/pm/state";

export function isRowParent(node: ProseMirrorNode): boolean {
	return node.type.name === "doc" || node.type.name === "column";
}

/** The depth of the innermost row holding `$pos`, or `null` when `$pos` sits between rows. */
export function rowDepth($pos: ResolvedPos): number | null {
	if (isRowParent($pos.parent)) return null;
	for (let depth = $pos.depth; depth > 0; depth--) {
		if (isRowParent($pos.node(depth - 1))) return depth;
	}
	return null;
}

/** Where the innermost row holding `$pos` starts; `$pos` itself when it sits between rows. */
export function rowStart($pos: ResolvedPos): number {
	const depth = rowDepth($pos);
	return depth === null ? $pos.pos : $pos.before(depth);
}

/** A selection of one whole row, such as the block handle makes. */
export function rowNodeSelection(selection: Selection): NodeSelection | null {
	return selection instanceof NodeSelection && isRowParent(selection.$from.parent)
		? selection
		: null;
}

/**
 * The rows a selection touches, all in one parent: a selection that crosses
 * from one column into another covers the whole columns block.
 */
export function rowRange(
	$from: ResolvedPos,
	$to: ResolvedPos,
): { from: number; to: number } | null {
	const range = $from.blockRange($to, isRowParent);
	return range ? { from: range.start, to: range.end } : null;
}
