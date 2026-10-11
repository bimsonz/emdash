/**
 * Inserting blocks inside a column: the slash menu, Markdown shortcuts and
 * the insert button put the new block in the column holding the caret.
 */

import type { Editor, JSONContent } from "@tiptap/core";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../src/styles.css";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

/** The insert button of the first block of the first column. */
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: ({
		editor,
		onInsertBlock,
	}: {
		editor: Editor;
		onInsertBlock?: (insertPos: number) => void;
	}) => (
		<button
			type="button"
			onClick={() => {
				let pos = -1;
				editor.state.doc.descendants((node, nodePos) => {
					if (pos === -1 && node.type.name === "column")
						pos = nodePos + 1 + node.firstChild!.nodeSize;
				});
				onInsertBlock?.(pos);
			}}
		>
			Insert after the first block of the first column
		</button>
	),
}));

const paragraph = (key: string, text: string) => ({
	_type: "block" as const,
	_key: key,
	style: "normal" as const,
	children: [{ _type: "span" as const, _key: `${key}s`, text }],
});

const value = [
	paragraph("intro", "Intro"),
	{
		_type: "columns",
		_key: "cols",
		columns: [
			{ _type: "column", _key: "a", content: [paragraph("a1", "a1")] },
			{ _type: "column", _key: "b", content: [] },
		],
	},
	paragraph("outro", "Outro"),
];

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editorInstance: Editor | null = null;
	const screen = await render(
		<PortableTextEditor
			value={value}
			onEditorReady={(editor) => {
				editorInstance = editor;
			}}
			{...props}
		/>,
	);
	await vi.waitFor(() => expect(editorInstance).toBeTruthy(), { timeout: 3000 });
	const pm = document.querySelector(".ProseMirror") as HTMLElement;
	return { screen, editor: editorInstance!, pm };
}

/** The node types in each column. */
function columnContent(editor: Editor): string[][] {
	const columns = (editor.getJSON().content ?? []).find((node) => node.type === "columns");
	return (columns?.content ?? []).map((column: JSONContent) =>
		(column.content ?? []).map((node) =>
			node.type === "paragraph" ? (node.content?.[0]?.text ?? "") : node.type,
		),
	);
}

/** Puts the caret in the empty paragraph of the second column. */
async function caretInSecondColumn(editor: Editor, pm: HTMLElement) {
	let pos = -1;
	let seen = 0;
	editor.state.doc.descendants((node, nodePos) => {
		if (node.type.name === "column" && seen++ === 1) pos = nodePos + 2;
	});
	editor.chain().focus().setTextSelection(pos).run();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm));
}

async function chooseSlashCommand(title: string) {
	let item: HTMLButtonElement | undefined;
	await vi.waitFor(() => {
		const menu = document.querySelector<HTMLElement>("[data-slash-command-menu]");
		item = [...(menu?.querySelectorAll<HTMLButtonElement>("button[data-index]") ?? [])].find(
			(button) => button.querySelector("[data-slash-item-title]")?.textContent === title,
		);
		expect(item).toBeTruthy();
	});
	item!.click();
}

describe("inserting blocks inside a column", () => {
	it("puts a block chosen from the slash menu in the column holding the caret", async () => {
		const { editor, pm } = await renderEditor();
		await caretInSecondColumn(editor, pm);
		editor.commands.insertContent("/");

		await chooseSlashCommand("HTML");

		await vi.waitFor(() => expect(columnContent(editor)[1]).toContain("htmlBlock"));
		expect((editor.getJSON().content ?? []).map((node) => node.type)).toEqual([
			"paragraph",
			"columns",
			"paragraph",
		]);
	});

	it("turns --- into a divider inside the column", async () => {
		const { editor, pm } = await renderEditor();
		await caretInSecondColumn(editor, pm);

		await userEvent.keyboard("---");

		await vi.waitFor(() => expect(columnContent(editor)[1]?.[0]).toBe("horizontalRule"));
	});

	it("types the insert button's slash on a new line inside the column", async () => {
		const { screen, editor } = await renderEditor();

		await screen
			.getByRole("button", { name: "Insert after the first block of the first column" })
			.click();

		await vi.waitFor(() => expect(columnContent(editor)[0]).toEqual(["a1", "/"]));
	});

	it("keeps text alignment available for a paragraph in a column", async () => {
		const { screen, editor, pm } = await renderEditor();
		await caretInSecondColumn(editor, pm);

		await expect
			.element(
				screen
					.getByRole("toolbar", { name: "Text formatting" })
					.getByRole("button", { name: "Align center" }),
			)
			.toBeEnabled();
	});
});
