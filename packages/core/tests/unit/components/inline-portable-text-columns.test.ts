// @vitest-environment jsdom

/**
 * A columns block in the visual editor: its columns open as editable blocks,
 * laid out with the renderer's markup, and the page can change what a column
 * holds but not the layout.
 */

import type { JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	InlinePortableTextEditor,
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";
import { UnsupportedPortableTextMarksError } from "../../../src/content/converters/mark-safety.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function paragraph(key: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block" as const,
		_key: key,
		style: "normal" as const,
		markDefs: [],
		children: [{ _type: "span" as const, _key: `${key}-1`, text, marks: [] as string[] }],
		...extra,
	};
}

function numbered(key: string, text: string) {
	return paragraph(key, text, { listItem: "number", level: 1, listId: "steps" });
}

// A story beside a sidebar of shared blocks, as a news article stores it.
const sidebarLayout = {
	_type: "columns",
	_key: "layout",
	gap: "lg",
	verticalAlignment: "top",
	columns: [
		{
			_type: "column",
			_key: "story",
			span: 2,
			content: [paragraph("p1", "The story."), paragraph("p2", "More of it.")],
		},
		{
			_type: "column",
			_key: "aside",
			content: [{ _type: "blockSet", _key: "set", ref: "right-column" }],
		},
	],
};

const twoTextColumns = {
	_type: "columns",
	_key: "pair",
	columns: [
		{ _type: "column", _key: "left", content: [paragraph("l1", "Left side.")] },
		{ _type: "column", _key: "right", content: [paragraph("r1", "Right side.")] },
	],
};

type Doc = JSONContent & { content: JSONContent[] };

function toPM(blocks: unknown[]): Doc {
	return portableTextToPM(blocks as Parameters<typeof portableTextToPM>[0]) as Doc;
}

function roundTrip(blocks: unknown[]) {
	return pmToPortableText(toPM(blocks)) as Array<Record<string, any>>;
}

describe("inline editor: columns conversion", () => {
	it("opens each column's blocks as blocks to edit", () => {
		const columns = toPM([sidebarLayout]).content[0]!;

		expect(columns).toMatchObject({
			type: "columns",
			attrs: { emdashKey: "layout", gap: "lg", verticalAlignment: "top" },
		});
		expect(columns.content?.map((column) => column.type)).toEqual(["column", "column"]);
		expect(columns.content?.[0]).toMatchObject({
			attrs: { emdashKey: "story", span: 2 },
			content: [{ type: "paragraph" }, { type: "paragraph" }],
		});
		expect(columns.content?.[1]?.content?.[0]).toMatchObject({
			type: "pluginBlock",
			attrs: { blockType: "blockSet", data: { ref: "right-column" } },
		});
	});

	it("saves a columns block with its key, its columns' keys and its layout", () => {
		const [saved] = roundTrip([sidebarLayout]);

		expect(saved).toMatchObject({
			_type: "columns",
			_key: "layout",
			gap: "lg",
			verticalAlignment: "top",
			columns: [
				{
					_type: "column",
					_key: "story",
					span: 2,
					content: [
						{ _type: "block", children: [{ text: "The story." }] },
						{ _type: "block", children: [{ text: "More of it." }] },
					],
				},
				{ _type: "column", _key: "aside", content: [{ _type: "blockSet", ref: "right-column" }] },
			],
		});
	});

	it("keeps the stored fields it doesn't edit, on the block and its columns", () => {
		const [saved] = roundTrip([
			{
				...twoTextColumns,
				wrap: true,
				importedFrom: "core/columns",
				columns: [
					{ ...twoTextColumns.columns[0], width: "40%", note: "kept" },
					twoTextColumns.columns[1],
				],
			},
		]);

		expect(saved).toMatchObject({ wrap: true, importedFrom: "core/columns" });
		expect(saved?.columns[0]).toMatchObject({ width: "40%", note: "kept" });
	});

	it("stores an empty column as no blocks", () => {
		const block = {
			_type: "columns",
			_key: "half-empty",
			columns: [
				{ _type: "column", _key: "empty", content: [] },
				{ _type: "column", _key: "full", content: [paragraph("f1", "Text.")] },
			],
		};
		const doc = toPM([block]);

		expect(doc.content[0]?.content?.[0]?.content).toEqual([{ type: "paragraph" }]);
		expect(pmToPortableText(doc)[0]).toMatchObject({
			columns: [{ _key: "empty", content: [] }, { _key: "full" }],
		});
	});

	it("keeps a plugin block, a centred line and nested columns inside a column", () => {
		const [saved] = roundTrip([
			{
				_type: "columns",
				_key: "outer",
				columns: [
					{
						_type: "column",
						_key: "a",
						content: [
							paragraph("c1", "Centred.", { textAlign: "center" }),
							{ _type: "marketing.hero", _key: "hero", headline: "Climb" },
						],
					},
					{ _type: "column", _key: "b", content: [twoTextColumns] },
				],
			},
		]);

		expect(saved?.columns[0].content).toMatchObject([
			{ textAlign: "center", children: [{ text: "Centred." }] },
			{ _type: "marketing.hero", headline: "Climb" },
		]);
		expect(saved?.columns[1].content).toMatchObject([
			{
				_type: "columns",
				_key: "pair",
				columns: [
					{ _key: "left", content: [{ children: [{ text: "Left side." }] }] },
					{ _key: "right", content: [{ children: [{ text: "Right side." }] }] },
				],
			},
		]);
	});

	it("gives a column a new key when it repeats its sibling's", () => {
		const [saved] = roundTrip([
			{
				...twoTextColumns,
				columns: twoTextColumns.columns.map((column) => ({ ...column, _key: "same" })),
			},
		]);

		const keys = saved?.columns.map((column: { _key: string }) => column._key);
		expect(keys[0]).toBe("same");
		expect(keys[1]).not.toBe("same");
	});

	it("won't open a column holding a mark it can't save", () => {
		const marked = paragraph("m", "Highlighted");
		marked.children[0]!.marks = ["highlight"];

		expect(() =>
			toPM([{ ...twoTextColumns, columns: [{ ...twoTextColumns.columns[0], content: [marked] }] }]),
		).toThrow(UnsupportedPortableTextMarksError);
	});

	it("numbers each column's list from its own start", () => {
		const doc = toPM([
			{
				_type: "columns",
				_key: "lists",
				columns: [
					{ _type: "column", _key: "a", content: [numbered("a1", "One"), numbered("a2", "Two")] },
					{ _type: "column", _key: "b", content: [numbered("b1", "One")] },
				],
			},
		]);

		const lists = doc.content[0]!.content!.map((column) => column.content![0]!);
		expect(lists.map((list) => list.type)).toEqual(["orderedList", "orderedList"]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([1, 1]);
		expect(lists[0]!.attrs?.listId).not.toBe(lists[1]!.attrs?.listId);
	});

	it("keeps a columns block it can't open as it was stored", () => {
		const unreadable = { _type: "columns", _key: "odd", columns: [{ _type: "row", _key: "r" }] };
		const doc = toPM([unreadable]);

		expect(doc.content[0]?.type).toBe("pluginBlock");
		expect({ ...pmToPortableText(doc)[0], _key: "odd" }).toEqual(unreadable);
	});
});

describe("inline editor: columns on the page", () => {
	let container: HTMLDivElement;
	let root: Root;
	let puts: Array<{ data: { body: Array<Record<string, any>> } }>;

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		puts = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT" && typeof init.body === "string")
					puts.push(JSON.parse(init.body));
				return Response.json({ data: {} });
			}),
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function mount(value: unknown[]) {
		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: structuredClone(value) as React.ComponentProps<
						typeof InlinePortableTextEditor
					>["value"],
					collection: "posts",
					entryId: "entry-1",
					field: "body",
				}),
			);
		});
		const editable = container.querySelector<HTMLElement>(".ProseMirror");
		expect(editable).not.toBeNull();
		return editable!;
	}

	// The component does not expose its editor, so this uses the instance
	// Tiptap's core attaches to its view's root element (`view.dom.editor`).
	function editorOf(editable: HTMLElement): Editor {
		const editor = (editable as HTMLElement & { editor?: Editor }).editor;
		expect(editor).toBeDefined();
		return editor!;
	}

	/** The position just inside the start of `text`. */
	function startOf(editor: Editor, text: string): number {
		let start = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.text?.startsWith(text)) start = pos;
		});
		expect(start).toBeGreaterThan(-1);
		return start;
	}

	async function blur(editable: HTMLElement) {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
	}

	function select(editor: Editor, from: number, to: number) {
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
		);
	}

	it("lays the columns out with the renderer's markup, so the site's styles apply", async () => {
		const editable = await mount([sidebarLayout]);
		// Less the editor's own mark for where the caret is.
		const markup = (element: Element) =>
			[...element.classList].filter((name) => name !== "has-caret");

		const columns = editable.querySelector(":scope > .emdash-columns");
		expect(markup(columns!)).toEqual([
			"emdash-columns",
			"emdash-columns--gap-lg",
			"emdash-columns--align-top",
		]);
		expect(Array.from(columns!.children, markup)).toEqual([
			["emdash-column", "emdash-column--span-2"],
			["emdash-column"],
		]);
	});

	it("marks the layout and the column the caret is in, before the editor has focus", async () => {
		const editable = await mount([twoTextColumns]);
		const editor = editorOf(editable);
		const columns = editable.querySelector(".emdash-columns")!;
		const marked = () =>
			[columns, ...columns.children].map((element) => element.classList.contains("has-caret"));

		expect(editor.view.hasFocus()).toBe(false);
		expect(marked()).toEqual([true, true, false]);

		const right = startOf(editor, "Right side.");
		await act(async () => select(editor, right, right));
		expect(marked()).toEqual([true, false, true]);
	});

	it("names the layout and each column, and never saves the names", async () => {
		const editable = await mount([sidebarLayout]);
		const columns = editable.querySelector(".emdash-columns")!;

		expect(columns.getAttribute("data-emdash-columns-label")).toBe(
			"2 columns (edit layout in admin)",
		);
		expect(
			Array.from(columns.children, (column) => column.getAttribute("data-emdash-column-label")),
		).toEqual(["Column 1 of 2", "Column 2 of 2"]);

		const editor = editorOf(editable);
		await act(async () => {
			editor.commands.insertContentAt(startOf(editor, "The story."), "Edited: ");
		});
		await blur(editable);

		expect(puts).toHaveLength(1);
		const saved = JSON.stringify(puts[0]);
		expect(saved).not.toContain("Column 1 of 2");
		expect(saved).not.toContain("edit layout");
	});

	it("saves an edit in one column, keeping the layout, its keys and the other column", async () => {
		const editable = await mount([sidebarLayout]);
		const editor = editorOf(editable);

		await act(async () => {
			editor.commands.insertContentAt(startOf(editor, "More of it."), "And ");
		});
		await blur(editable);

		expect(puts).toHaveLength(1);
		expect(puts[0]!.data.body[0]).toMatchObject({
			_type: "columns",
			_key: "layout",
			gap: "lg",
			verticalAlignment: "top",
			columns: [
				{
					_key: "story",
					span: 2,
					content: [
						{ children: [{ text: "The story." }] },
						{ children: [{ text: "And More of it." }] },
					],
				},
				{ _key: "aside", content: [{ _type: "blockSet", ref: "right-column" }] },
			],
		});
	});

	it("doesn't save when focus leaves columns that weren't touched", async () => {
		const editable = await mount([
			{
				_type: "columns",
				_key: "lists",
				columns: [
					{ _type: "column", _key: "a", content: [numbered("a1", "One"), numbered("a2", "Two")] },
					{ _type: "column", _key: "b", content: [numbered("b1", "One"), paragraph("b2", "")] },
				],
			},
			sidebarLayout,
		]);

		await blur(editable);
		await blur(editable);
		await blur(editable);

		expect(puts).toHaveLength(0);
	});

	it("won't delete across two columns", async () => {
		const editor = editorOf(await mount([twoTextColumns]));
		const before = editor.getJSON();

		select(editor, startOf(editor, "Left side.") + 4, startOf(editor, "Right side.") + 5);
		editor.commands.deleteSelection();
		editor.commands.insertContent("x");

		expect(editor.getJSON()).toEqual(before);
	});

	it("won't take a column with the line above it", async () => {
		const editor = editorOf(await mount([paragraph("above", "Above."), twoTextColumns]));
		const before = editor.getJSON();

		select(editor, startOf(editor, "Above.") + 2, startOf(editor, "Left side.") + 4);
		editor.commands.deleteSelection();

		expect(editor.getJSON()).toEqual(before);
	});

	it("still deletes inside one column", async () => {
		const editor = editorOf(await mount([twoTextColumns]));

		const start = startOf(editor, "Left side.");
		select(editor, start, start + 5);
		editor.commands.deleteSelection();

		expect(editor.getJSON().content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
			"side.",
		);
	});

	it("pastes a copied layout as the blocks it held, never as new columns", async () => {
		const editable = await mount([
			paragraph("i1", "Item.", { listItem: "bullet", level: 1 }),
			twoTextColumns,
		]);
		const editor = editorOf(editable);
		const copied = editable.querySelector(".emdash-columns")!.outerHTML;

		await act(async () => {
			editor.commands.setTextSelection(startOf(editor, "Item.") + 5);
			editor.commands.insertContent(copied);
		});

		let columnsBlocks = 0;
		editor.state.doc.descendants((node) => {
			if (node.type.name === "columns") columnsBlocks++;
		});
		expect(columnsBlocks).toBe(1);
		expect(editor.getJSON().content?.[0]).toMatchObject({
			type: "bulletList",
			content: [
				{
					type: "listItem",
					content: [
						{ type: "paragraph", content: [{ text: "Item." }] },
						{ type: "paragraph", content: [{ text: "Left side." }] },
						{ type: "paragraph", content: [{ text: "Right side." }] },
					],
				},
			],
		});
	});
});
