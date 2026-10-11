/**
 * Commands for the columns block: inserting it, and adding, moving, sizing
 * and deleting its columns. Each runs as one undoable step.
 */

import type { Editor, Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

import { MAX_EDITOR_COLUMNS } from "../../portable-text-columns.js";
import { prepareBlockInsert } from "./blockTypes.js";

const createKey = () => Math.random().toString(36).slice(2, 11);

function emptyColumn(schema: Schema) {
	return schema.nodes.column!.create({ emdashKey: createKey() }, schema.nodes.paragraph!.create());
}

/**
 * Inserts a columns block of `count` empty columns where a new block goes,
 * after deleting `range`, with the caret in the first column.
 */
export function insertColumns(editor: Editor, count = 2, range?: Range): boolean {
	const chain = editor
		.chain()
		.focus()
		.command(({ tr }) => {
			closeHistory(tr);
			return true;
		});
	if (range) chain.deleteRange(range);
	return chain
		.command(({ tr }) => prepareBlockInsert(tr))
		.command(({ tr }) => {
			const { schema } = tr.doc.type;
			const { $from } = tr.selection;
			if ($from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) return false;
			const block = schema.nodes.columns!.create(
				{ emdashKey: createKey() },
				Array.from({ length: count }, () => emptyColumn(schema)),
			);
			const start = $from.before();
			tr.replaceWith(start, $from.after(), block);
			const end = start + block.nodeSize;
			if (end === tr.doc.content.size) tr.insert(end, schema.nodes.paragraph!.create());
			tr.setSelection(TextSelection.create(tr.doc, start + 3)).scrollIntoView();
			return true;
		})
		.run();
}

function columnAt(editor: Editor, pos: number) {
	const column = editor.state.doc.nodeAt(pos);
	if (column?.type.name !== "column") return null;
	const $pos = editor.state.doc.resolve(pos);
	return { column, container: $pos.parent, index: $pos.index() };
}

/** Adds an empty column beside the one at `pos` and puts the caret in it. */
export function addColumn(editor: Editor, pos: number, side: "before" | "after"): boolean {
	const found = columnAt(editor, pos);
	if (!found || found.container.childCount >= MAX_EDITOR_COLUMNS || !editor.isEditable) {
		return false;
	}
	const at = side === "before" ? pos : pos + found.column.nodeSize;
	const tr = editor.state.tr.insert(at, emptyColumn(editor.schema));
	tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView();
	editor.view.dispatch(tr);
	editor.view.focus();
	return true;
}

/**
 * Swaps the column at `pos` with its neighbour, earlier (-1) or later (1) in
 * reading order. The neighbour moves, so the moved column keeps its state.
 */
export function moveColumn(editor: Editor, pos: number, direction: -1 | 1): boolean {
	const found = columnAt(editor, pos);
	if (!found || !editor.isEditable) return false;
	const { column, container, index } = found;
	const neighbourIndex = index + direction;
	if (neighbourIndex < 0 || neighbourIndex >= container.childCount) return false;
	const neighbour = container.child(neighbourIndex);
	const { tr } = editor.state;
	if (direction < 0) {
		tr.delete(pos - neighbour.nodeSize, pos).insert(
			pos + column.nodeSize - neighbour.nodeSize,
			neighbour,
		);
	} else {
		const end = pos + column.nodeSize;
		tr.delete(end, end + neighbour.nodeSize).insert(pos, neighbour);
	}
	editor.view.dispatch(tr.scrollIntoView());
	return true;
}

/** Sets the relative width of the column at `pos`; 1 is the default and stores nothing. */
export function setColumnSpan(editor: Editor, pos: number, span: number): boolean {
	const found = columnAt(editor, pos);
	if (!found || !editor.isEditable) return false;
	editor.view.dispatch(
		editor.state.tr.setNodeMarkup(pos, undefined, {
			...found.column.attrs,
			span: span === 1 ? null : span,
		}),
	);
	return true;
}

/** Deletes the column at `pos`, unless it is the only one. */
export function deleteColumn(editor: Editor, pos: number): boolean {
	const found = columnAt(editor, pos);
	if (!found || found.container.childCount <= 1 || !editor.isEditable) return false;
	editor.view.dispatch(editor.state.tr.delete(pos, pos + found.column.nodeSize));
	editor.view.focus();
	return true;
}

/** Updates the layout attributes of the columns block at `pos`. */
export function setColumnsLayout(
	editor: Editor,
	pos: number,
	attrs: Partial<Record<"gap" | "verticalAlignment" | "wrap", unknown>>,
): boolean {
	const node = editor.state.doc.nodeAt(pos);
	if (node?.type.name !== "columns" || !editor.isEditable) return false;
	editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
	return true;
}
