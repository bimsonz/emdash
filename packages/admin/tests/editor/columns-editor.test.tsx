/**
 * The columns block in the editor: inserting it, folding it, and changing its
 * columns from their menus.
 */

import { i18n } from "@lingui/core";
import type { Editor } from "@tiptap/core";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { moveBlocks } from "../../src/components/editor/BlockCommands";
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

const columnsBlock = (key = "cols"): Block => ({
	_type: "columns",
	_key: key,
	columns: [
		{ _type: "column", _key: `${key}-a`, content: [paragraph(`${key}-a1`, "Left")] },
		{ _type: "column", _key: `${key}-b`, content: [paragraph(`${key}-b1`, "Right")] },
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

describe("columns block editor", () => {
	it("inserts two empty columns from the slash menu, with the caret in the first", async () => {
		const { editor, pm } = await renderEditor();
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
		await userEvent.keyboard("Typed");
		expect(columns.firstChild?.textContent).toBe("");
		expect(editor.state.doc.firstChild!.firstChild!.textContent).toBe("Typed");
	});

	it("folds to a summary without changing the document, and stays folded when moved", async () => {
		const { screen, editor, onChange } = await renderEditor({
			value: [columnsBlock(), paragraph("after", "After")],
		});
		const toggle = screen.getByRole("button", { name: "Collapse block" });
		await expect.element(toggle).toHaveAttribute("aria-expanded", "true");

		await toggle.click();

		const expand = screen.getByRole("button", { name: "Expand block" });
		await expect.element(expand).toHaveAttribute("aria-expanded", "false");
		await expect.element(expand).toHaveTextContent("2 columns, 2 blocks");
		expect(document.querySelector<HTMLElement>(".emdash-columns-row")?.offsetHeight).toBe(0);
		expect(onChange).not.toHaveBeenCalled();

		editor.commands.setNodeSelection(0);
		moveBlocks(editor, "down");
		await vi.waitFor(() => expect(editor.state.doc.child(1).type.name).toBe("columns"));
		await expect.element(screen.getByRole("button", { name: "Expand block" })).toBeInTheDocument();
	});

	it("stays folded when folded with the caret inside", async () => {
		const { screen, editor } = await renderEditor({ value: [columnsBlock()] });
		editor.commands.setTextSelection(4);
		editor.commands.focus();

		await screen.getByRole("button", { name: "Collapse block" }).click();
		editor.view.dispatch(editor.state.tr.setSelection(editor.state.selection));

		await expect.element(screen.getByRole("button", { name: "Expand block" })).toBeInTheDocument();
	});

	it("unfolds when the selection moves inside", async () => {
		const { screen, editor } = await renderEditor({ value: [columnsBlock()] });
		await screen.getByRole("button", { name: "Collapse block" }).click();
		await expect.element(screen.getByRole("button", { name: "Expand block" })).toBeInTheDocument();

		editor.commands.setTextSelection(4);

		await expect
			.element(screen.getByRole("button", { name: "Collapse block" }))
			.toBeInTheDocument();
	});

	it("moves, widens, adds and deletes columns from a column's menu", async () => {
		const { screen, latest } = await renderEditor({ value: [columnsBlock()] });
		const openMenu = async (index: number) => {
			await screen.getByRole("button", { name: "Column actions" }).nth(index).click();
			await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
		};

		await openMenu(0);
		await screen.getByRole("menuitem", { name: "Move later" }).click();
		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([["Right"], ["Left"]]));

		await openMenu(1);
		await userEvent.hover(screen.getByRole("menuitem", { name: "Width" }).element());
		await screen.getByRole("menuitemradio", { name: "Wide", exact: true }).click();
		await vi.waitFor(() => {
			const columns = latest()[0]!.columns as Array<{ span?: number }>;
			expect(columns.map((column) => column.span)).toEqual([undefined, 2]);
		});
		expect(document.querySelectorAll(".node-column")[1]?.getAttribute("data-span")).toBe("2");

		await openMenu(1);
		await screen.getByRole("menuitem", { name: "Add column after" }).click();
		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([["Right"], ["Left"], []]));

		await openMenu(2);
		await screen.getByRole("menuitem", { name: "Delete column" }).click();
		await vi.waitFor(() => expect(columnTexts(latest())).toEqual([["Right"], ["Left"]]));
	});

	it("keeps Escape for selecting the block in a column while the columns are unfolded", async () => {
		const { editor, pm } = await renderEditor({ value: [columnsBlock()] });
		editor.commands.setTextSelection(4);
		pm.focus();

		await userEvent.keyboard("{Escape}");

		const { selection } = editor.state;
		expect("node" in selection && (selection.node as { textContent: string }).textContent).toBe(
			"Left",
		);
	});

	it("lays out its controls in the interface direction, not the content's", async () => {
		const previousLocale = i18n.locale;
		const previousDir = document.documentElement.dir;
		i18n.load("ar", {});
		i18n.activate("ar");
		document.documentElement.dir = "rtl";
		try {
			await renderEditor({ value: [columnsBlock()] });

			await vi.waitFor(() => {
				const header = document.querySelector<HTMLElement>(".emdash-columns-header");
				expect(header && getComputedStyle(header).direction).toBe("rtl");
			});
		} finally {
			document.documentElement.dir = previousDir;
			i18n.activate(previousLocale);
		}
	});
});
