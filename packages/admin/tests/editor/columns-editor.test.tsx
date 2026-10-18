/**
 * The columns block in the editor: inserting it, its map of the layout,
 * opening a column at full width, and changing columns from their menus.
 */

import { i18n } from "@lingui/core";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../src/styles.css";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

type Block = { _type: string; _key: string; [key: string]: unknown };

const paragraph = (key: string, text: string): Block => ({
	_type: "block",
	_key: key,
	style: "normal",
	children: [{ _type: "span", _key: `${key}s`, text }],
});

const heading = (key: string, text: string): Block => ({
	...paragraph(key, text),
	style: "h2",
});

/** Two columns holding "Left" and "Right"; `columnKey` names the columns' keys. */
const columnsBlock = (key = "cols", columnKey = key): Block => ({
	_type: "columns",
	_key: key,
	columns: [
		{ _type: "column", _key: `${columnKey}-a`, content: [paragraph(`${key}-a1`, "Left")] },
		{ _type: "column", _key: `${columnKey}-b`, content: [paragraph(`${key}-b1`, "Right")] },
	],
});

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editor: Editor | null = null;
	const onChange = vi.fn();
	const screen = await render(
		<PortableTextEditor
			onEditorReady={(instance) => {
				editor = instance;
			}}
			onChange={onChange}
			{...props}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy(), { timeout: 3000 });
	const pm = document.querySelector<HTMLElement>(".ProseMirror")!;
	const latest = (): Block[] =>
		(onChange.mock.calls.at(-1)?.[0] as Block[] | undefined) ?? ((props.value ?? []) as Block[]);
	return { screen, editor: editor!, pm, onChange, latest };
}

function columnTexts(blocks: Block[]): string[][] {
	const columns = blocks.find((block) => block._type === "columns")?.columns as
		| Array<{ content: Array<{ children?: Array<{ text: string }> }> }>
		| undefined;
	return (columns ?? []).map((column) =>
		column.content.map((block) => block.children?.map((child) => child.text).join("") ?? ""),
	);
}

const openColumns = () => [...document.querySelectorAll<HTMLElement>(".emdash-column-open")];

/** The position just inside the first textblock holding `text`. */
function textPos(editor: Editor, text: string): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
	});
	return found;
}

describe("columns block editor", () => {
	it("inserts two empty columns from the slash menu and opens the first", async () => {
		const { screen, editor, pm } = await renderEditor();
		pm.focus();
		await userEvent.keyboard("/columns");
		let item: HTMLButtonElement | undefined;
		await vi.waitFor(() => {
			item = [
				...document.querySelectorAll<HTMLButtonElement>(
					"[data-slash-command-menu] button[data-index]",
				),
			].find(
				(button) => button.querySelector("[data-slash-item-title]")?.textContent === "Columns",
			);
			expect(item).toBeTruthy();
		});
		item!.click();

		await vi.waitFor(() => expect(editor.state.doc.firstChild?.type.name).toBe("columns"));
		const columns = editor.state.doc.firstChild!;
		expect(columns.childCount).toBe(2);
		expect(editor.state.selection.$from.node(2).type.name).toBe("column");
		expect(editor.state.selection.$from.index(1)).toBe(0);
		await expect
			.element(screen.getByRole("button", { name: "Column 1 of 2" }))
			.toHaveAttribute("aria-expanded", "true");
		await userEvent.keyboard("Typed");
		expect(editor.state.doc.firstChild!.firstChild!.textContent).toBe("Typed");
	});

	it("maps each column as a box naming what it holds, with none open when it loads", async () => {
		const { screen, onChange } = await renderEditor({
			value: [
				{
					_type: "columns",
					_key: "cols",
					columns: [
						{
							_type: "column",
							_key: "a",
							content: [heading("a1", "Opening times"), paragraph("a2", "Every day")],
						},
						{ _type: "column", _key: "b", span: 2, content: [paragraph("b1", "Getting here")] },
						{ _type: "column", _key: "c", content: [] },
					],
				},
			],
		});

		const first = screen.getByRole("button", { name: "Column 1 of 3" });
		await expect.element(first).toHaveAttribute("aria-expanded", "false");
		await expect.element(first).toHaveAccessibleDescription("Opening times Heading 2, Paragraph");
		await expect
			.element(screen.getByRole("button", { name: "Column 2 of 3" }))
			.toHaveAccessibleDescription("Getting here Paragraph");
		await expect
			.element(screen.getByRole("button", { name: "Column 3 of 3" }))
			.toHaveAccessibleDescription("Empty");
		const boxes = [...document.querySelectorAll<HTMLElement>(".emdash-columns-map-box")];
		expect(boxes[1]!.offsetWidth).toBeGreaterThan(boxes[0]!.offsetWidth * 1.5);
		expect(openColumns()).toEqual([]);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("opens a column at full width from its box, and closes it from the box or Done", async () => {
		const { screen, editor, onChange } = await renderEditor({
			value: [columnsBlock(), paragraph("after", "After")],
		});
		const box = screen.getByRole("button", { name: "Column 2 of 2" });

		await box.click();

		await expect.element(box).toHaveAttribute("aria-expanded", "true");
		expect(openColumns()).toHaveLength(1);
		const column = openColumns()[0]!;
		expect(column.textContent).toContain("Right");
		const block = document.querySelector<HTMLElement>(".emdash-columns-node")!;
		expect(column.offsetWidth).toBeGreaterThan(block.offsetWidth * 0.9);

		await box.click();
		await expect.element(box).toHaveAttribute("aria-expanded", "false");
		expect(openColumns()).toEqual([]);

		await box.click();
		await screen.getByRole("button", { name: "Done" }).click();
		await expect.element(box).toHaveAttribute("aria-expanded", "false");
		const { selection } = editor.state;
		expect(selection instanceof NodeSelection && selection.node.type.name).toBe("columns");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("opens the column the selection moves into, and closes it when the selection leaves", async () => {
		const { screen, editor } = await renderEditor({
			value: [columnsBlock(), paragraph("after", "After")],
		});

		editor.commands.setTextSelection(textPos(editor, "Right"));
		await expect
			.element(screen.getByRole("button", { name: "Column 2 of 2" }))
			.toHaveAttribute("aria-expanded", "true");

		editor.commands.setTextSelection(textPos(editor, "After"));
		await vi.waitFor(() => expect(openColumns()).toEqual([]));
	});

	it("keeps a column open while the document changes before it", async () => {
		const { screen, editor } = await renderEditor({
			value: [paragraph("before", "Before"), columnsBlock()],
		});
		await screen.getByRole("button", { name: "Column 2 of 2" }).click();

		editor.view.dispatch(editor.state.tr.insertText("More ", textPos(editor, "Before")));

		await vi.waitFor(() => expect(editor.state.doc.firstChild?.textContent).toBe("More Before"));
		expect(openColumns()).toHaveLength(1);
		expect(openColumns()[0]!.textContent).toContain("Right");
	});

	it("opens a column in one columns block only, when another's columns share its keys", async () => {
		const { screen } = await renderEditor({
			value: [columnsBlock("first", "shared"), columnsBlock("second", "shared")],
		});

		await screen.getByRole("button", { name: "Column 1 of 2" }).first().click();

		expect(openColumns()).toHaveLength(1);
		expect(document.querySelectorAll('.emdash-columns-map-box[aria-expanded="true"]')).toHaveLength(
			1,
		);
	});

	it("selects the block in an open column on Escape, then the columns block, closing it", async () => {
		const { editor, pm } = await renderEditor({ value: [columnsBlock()] });
		editor.commands.setTextSelection(textPos(editor, "Left"));
		pm.focus();

		await userEvent.keyboard("{Escape}");

		let { selection } = editor.state;
		expect(selection instanceof NodeSelection && selection.node.textContent).toBe("Left");
		expect(openColumns()).toHaveLength(1);

		await userEvent.keyboard("{Escape}");

		({ selection } = editor.state);
		expect(selection instanceof NodeSelection && selection.node.type.name).toBe("columns");
		await vi.waitFor(() => expect(openColumns()).toEqual([]));
	});

	it("moves a block dropped on another column's box to the end of that column", async () => {
		const { screen, editor, latest } = await renderEditor({ value: [columnsBlock()] });
		const from = textPos(editor, "Left") - 1;
		editor.view.dispatch(
			editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, from)),
		);
		editor.view.dragging = { slice: editor.state.selection.content(), move: true };
		const box = screen.getByRole("button", { name: "Column 2 of 2" }).element();
		const { left, top, width, height } = box.getBoundingClientRect();

		box.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				clientX: left + width / 2,
				clientY: top + height / 2,
				dataTransfer: new DataTransfer(),
			}),
		);

		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([[], ["Right", "Left"]]));
		await expect.element(box).toHaveAttribute("aria-expanded", "true");
	});

	it("moves, widens, adds and deletes columns from an open column's menu", async () => {
		const { screen, latest } = await renderEditor({ value: [columnsBlock()] });
		const openMenu = async () => {
			await screen.getByRole("button", { name: "Column actions" }).click();
			await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
		};
		await screen.getByRole("button", { name: "Column 1 of 2" }).click();

		await openMenu();
		await screen.getByRole("menuitem", { name: "Move later" }).click();
		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([["Right"], ["Left"]]));
		await expect
			.element(screen.getByRole("button", { name: "Column 2 of 2" }))
			.toHaveAttribute("aria-expanded", "true");

		await openMenu();
		await userEvent.hover(screen.getByRole("menuitem", { name: "Width" }).element());
		await screen.getByRole("menuitemradio", { name: "Wide", exact: true }).click();
		await vi.waitFor(() => {
			const columns = latest()[0]!.columns as Array<{ span?: number }>;
			expect(columns.map((column) => column.span)).toEqual([undefined, 2]);
		});
		expect(document.querySelectorAll(".emdash-columns-map-box")[1]?.getAttribute("data-span")).toBe(
			"2",
		);

		await openMenu();
		await screen.getByRole("menuitem", { name: "Add column after" }).click();
		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([["Right"], ["Left"], []]));
		await expect
			.element(screen.getByRole("button", { name: "Column 3 of 3" }))
			.toHaveAttribute("aria-expanded", "true");

		await openMenu();
		await screen.getByRole("menuitem", { name: "Delete column" }).click();
		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([["Right"], ["Left"]]));
	});

	it("lays out its map in the interface direction, not the content's", async () => {
		const previousLocale = i18n.locale;
		const previousDir = document.documentElement.dir;
		i18n.load("ar", {});
		i18n.activate("ar");
		document.documentElement.dir = "rtl";
		try {
			await renderEditor({ value: [columnsBlock()] });

			await vi.waitFor(() => {
				const map = document.querySelector<HTMLElement>(".emdash-columns-map");
				expect(map && getComputedStyle(map).direction).toBe("rtl");
			});
		} finally {
			document.documentElement.dir = previousDir;
			i18n.activate(previousLocale);
		}
	});
});
