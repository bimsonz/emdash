/**
 * Block keys inside columns: a block in a column owns its key as a top-level
 * block does, so it keeps it from save to save while blocks are added before
 * it, and a column's empty last line isn't saved.
 */

import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

type Block = { _type: string; _key: string; children?: Array<{ text: string }> };
type Columns = Block & { columns: Array<{ _key: string; content: Block[] }> };

const paragraph = (key: string, text: string) => ({
	_type: "block",
	_key: key,
	style: "normal",
	children: [{ _type: "span", _key: `${key}-s`, text }],
});

const textOf = (block: Block) => block.children?.map((child) => child.text).join("") ?? "";

async function renderColumns() {
	let editor: Editor | null = null;
	const changes: Block[][] = [];
	await render(
		<PortableTextEditor
			value={
				[
					{
						_type: "columns",
						_key: "cols",
						columns: [
							{ _type: "column", _key: "a", content: [paragraph("left", "Left")] },
							{ _type: "column", _key: "b", content: [paragraph("right", "Right")] },
						],
					},
				] as PortableTextEditorProps["value"]
			}
			onEditorReady={(instance) => {
				editor = instance;
			}}
			onChange={(blocks) => changes.push(blocks as Block[])}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	return { editor: editor!, changes };
}

/** Where the text block holding `text` starts or ends. */
function textPosition(editor: Editor, text: string, end = false): number {
	let position = -1;
	editor.state.doc.descendants((node, pos) => {
		if (position === -1 && node.isTextblock && node.textContent === text) {
			position = end ? pos + node.nodeSize - 1 : pos + 1;
		}
	});
	return position;
}

async function focus(editor: Editor, position: number) {
	editor.commands.focus(position);
	await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
}

/** The saved blocks of column `index` once they hold these texts. */
function savedColumn(changes: Block[][], index: number, texts: string[]): Promise<Block[]> {
	return vi.waitFor(() => {
		const block = (changes.at(-1) ?? []).find((saved) => saved._type === "columns") as
			| Columns
			| undefined;
		const content = block?.columns[index]?.content ?? [];
		expect(content.map(textOf)).toEqual(texts);
		return content;
	});
}

describe("block keys in columns", () => {
	it("keeps the key of a block typed into a column while a block is added before it", async () => {
		const { editor, changes } = await renderColumns();
		await focus(editor, textPosition(editor, "Right", true));
		await userEvent.keyboard("{Enter}Typed");
		let blocks = await savedColumn(changes, 1, ["Right", "Typed"]);
		const typed = blocks[1]!._key;
		// Its own key, not one derived from where it is.
		expect(typed).not.toContain(":");

		await focus(editor, textPosition(editor, "Right"));
		await userEvent.keyboard("{Enter}{ArrowUp}Before");
		blocks = await savedColumn(changes, 1, ["Before", "Right", "Typed"]);
		expect(blocks.map((block) => block._key).slice(1)).toEqual(["right", typed]);
	});

	it("doesn't save a column's empty last line", async () => {
		const { editor, changes } = await renderColumns();
		await focus(editor, textPosition(editor, "Left", true));
		await userEvent.keyboard("!{Enter}");
		await savedColumn(changes, 0, ["Left!"]);
	});
});
