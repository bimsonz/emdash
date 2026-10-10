/**
 * Rows inside columns: the blocks of a column are selected, moved, duplicated
 * and converted one by one, as the document's are, and never leave their column.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import {
	BlockSelection,
	blockInsertPosition,
	duplicateBlocks,
	moveBlocks,
} from "../../src/components/editor/BlockCommands";
import { canTurnInto, turnInto } from "../../src/components/editor/blockTypes";
import { ColumnBlock, ColumnsBlock } from "../../src/components/editor/ColumnsExtension";
import { TopBlockDocument } from "../../src/components/editor/EmbedBlockShell";

let editor: Editor;
let element: HTMLDivElement;

const text = (value: string): JSONContent => ({
	type: "paragraph",
	content: [{ type: "text", text: value }],
});
const column = (...content: JSONContent[]): JSONContent => ({ type: "column", content });

function create(...content: JSONContent[]) {
	element = document.createElement("div");
	document.body.append(element);
	editor = new Editor({
		element,
		extensions: [
			StarterKit.configure({ document: false }),
			TopBlockDocument,
			ColumnsBlock,
			ColumnBlock,
			BlockSelection,
		],
		content: { type: "doc", content },
	});
}

function press(key: string) {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
	editor.view.dom.dispatchEvent(event);
	return event;
}

function posOf(value: string): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found === -1 && node.isTextblock && node.textContent === value) found = pos;
	});
	return found;
}

function caretIn(value: string) {
	editor.commands.setTextSelection(posOf(value) + 1);
}

function selectRow(value: string) {
	editor.commands.setNodeSelection(posOf(value));
}

function selectedText() {
	const { selection } = editor.state;
	return selection instanceof NodeSelection ? selection.node.textContent : null;
}

/** Each column's text blocks, in order. */
function columnTexts(): string[][] {
	const columns: string[][] = [];
	editor.state.doc.descendants((node) => {
		if (node.type.name !== "column") return true;
		const texts: string[] = [];
		node.forEach((child) => texts.push(child.textContent));
		columns.push(texts);
		return false;
	});
	return columns;
}

afterEach(() => {
	editor.destroy();
	element.remove();
});

describe("rows inside columns", () => {
	it("selects the block holding the caret on Escape, not the columns around it", () => {
		create({ type: "columns", content: [column(text("a1"), text("a2")), column(text("b1"))] });
		caretIn("a2");

		expect(press("Escape").defaultPrevented).toBe(true);
		expect(selectedText()).toBe("a2");
	});

	it("moves the selection between a column's blocks with the arrow keys, staying in the column", () => {
		create({ type: "columns", content: [column(text("a1"), text("a2")), column(text("b1"))] });
		caretIn("a1");
		press("Escape");

		press("ArrowDown");
		expect(selectedText()).toBe("a2");
		press("ArrowDown");
		expect(selectedText()).toBe("a2");
		press("ArrowUp");
		expect(selectedText()).toBe("a1");
	});

	it("moves a block within its column, and no further than the column's ends", () => {
		create(text("before"), {
			type: "columns",
			content: [column(text("a1"), text("a2")), column(text("b1"))],
		});
		selectRow("a1");

		expect(moveBlocks(editor, "down")).toBe(true);
		expect(columnTexts()).toEqual([["a2", "a1"], ["b1"]]);
		expect(moveBlocks(editor, "down")).toBe(false);

		selectRow("b1");
		expect(moveBlocks(editor, "up")).toBe(false);
		expect(editor.state.doc.firstChild?.textContent).toBe("before");
	});

	it("duplicates a block inside its column", () => {
		create({ type: "columns", content: [column(text("a1")), column(text("b1"))] });
		caretIn("b1");

		expect(duplicateBlocks(editor)).toBe(true);
		expect(columnTexts()).toEqual([["a1"], ["b1", "b1"]]);
	});

	it("selects a divider with Backspace from the start of the block after it in a column", () => {
		create({
			type: "columns",
			content: [column(text("a1"), { type: "horizontalRule" }, text("a2")), column(text("b1"))],
		});
		caretIn("a2");

		expect(press("Backspace").defaultPrevented).toBe(true);
		const { selection } = editor.state;
		expect(selection instanceof NodeSelection && selection.node.type.name).toBe("horizontalRule");
	});

	it("keeps a column when its only block is deleted", () => {
		create({ type: "columns", content: [column(text("a1")), column(text("b1"))] });
		caretIn("b1");
		press("Escape");

		press("Backspace");
		expect(columnTexts()).toEqual([["a1"], [""]]);
	});

	it("inserts a new block after the block holding the caret, inside the column", () => {
		create({ type: "columns", content: [column(text("a1"), text("a2")), column(text("b1"))] });
		caretIn("a1");

		expect(blockInsertPosition(editor.state.selection)).toBe(posOf("a2"));
	});

	it("keeps a block selected from inside a column selected when it is turned into a heading", () => {
		create({ type: "columns", content: [column(text("a1"), text("a2")), column(text("b1"))] });
		caretIn("a2");
		press("Escape");

		turnInto(editor, "heading2");
		const { selection } = editor.state;
		expect(selection instanceof NodeSelection && selection.node.type.name).toBe("heading");
		expect(selectedText()).toBe("a2");
	});

	it("offers to convert text in a column, but not a columns block or a selection across columns", () => {
		create({ type: "columns", content: [column(text("a1")), column(text("b1"))] });
		caretIn("a1");
		expect(canTurnInto(editor)).toBe(true);

		editor.commands.setNodeSelection(0);
		expect(canTurnInto(editor)).toBe(false);

		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, posOf("a1") + 1, posOf("b1") + 2),
			),
		);
		expect(canTurnInto(editor)).toBe(false);
	});
});
