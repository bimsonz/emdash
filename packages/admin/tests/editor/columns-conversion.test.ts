import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { ColumnBlock, ColumnsBlock } from "../../src/components/editor/ColumnsExtension";
import { TopBlockDocument } from "../../src/components/editor/EmbedBlockShell";
import { HtmlBlockExtension } from "../../src/components/editor/HtmlBlockNode";
import { IframeBlockExtension } from "../../src/components/editor/IframeBlockNode";
import {
	EmDashOrderedList,
	normalizeOrderedListDocument,
} from "../../src/components/editor/ordered-list";
import { PluginBlockExtension } from "../../src/components/editor/PluginBlockNode";
import {
	EmDashTable,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
} from "../../src/components/editor/TableExtensions";
import {
	_PortableTextIdentityExtension as PortableTextIdentityExtension,
	_PortableTextSpanIdentity as PortableTextSpanIdentity,
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";
import { findUnsupportedPortableTextMarks } from "../../src/lib/portable-text-marks";

type Blocks = Parameters<typeof portableTextToProsemirror>[0];

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

function schema() {
	const editor = new Editor({
		extensions: [
			PortableTextIdentityExtension,
			PortableTextSpanIdentity,
			StarterKit.configure({ document: false, orderedList: false }),
			TopBlockDocument,
			EmDashOrderedList,
			ColumnsBlock,
			ColumnBlock,
			HtmlBlockExtension,
			IframeBlockExtension,
			PluginBlockExtension,
			EmDashTable,
			EmDashTableRow,
			EmDashTableCell,
			EmDashTableHeader,
		],
	});
	editors.push(editor);
	return editor.schema;
}

const paragraph = (key: string, text: string) => ({
	_type: "block",
	_key: key,
	style: "normal",
	children: [{ _type: "span", _key: `${key}s`, text }],
});
const column = (key: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
	_type: "column",
	_key: key,
	content,
	...extra,
});
const columns = (key: string, cols: unknown[], extra: Record<string, unknown> = {}) => ({
	_type: "columns",
	_key: key,
	columns: cols,
	...extra,
});

function roundTrip(blocks: unknown[], pluginTypes?: ReadonlySet<string>) {
	return prosemirrorToPortableText(
		portableTextToProsemirror(blocks as Blocks, pluginTypes) as never,
	);
}

describe("columns conversion (admin editor)", () => {
	it("opens a columns block as editable columns holding their blocks", () => {
		const doc = portableTextToProsemirror([
			columns("cols", [column("a", [paragraph("p1", "Left")]), column("b", [])]),
		] as Blocks);
		const node = doc.content[0] as {
			type: string;
			content: Array<{ type: string; content: Array<{ type: string }> }>;
		};

		expect(node.type).toBe("columns");
		expect(node.content.map((child) => child.type)).toEqual(["column", "column"]);
		expect(node.content[0]!.content[0]!.type).toBe("paragraph");
		expect(node.content[1]!.content).toEqual([{ type: "paragraph" }]);
	});

	it("round-trips the shape WordPress imports write", () => {
		const imported = [
			columns("cols", [
				column("a", [paragraph("p1", "Left")]),
				column("b", [paragraph("p2", "Right")]),
			]),
		];

		expect(roundTrip(imported)).toEqual(imported);
	});

	it("keeps layout values as stored, including ones the renderer ignores, and unknown fields", () => {
		const stored = [
			columns(
				"cols",
				[
					column("a", [paragraph("p1", "Wide")], { span: 2, width: "40%", note: "kept" }),
					column("b", [paragraph("p2", "Odd")], { span: 1 }),
				],
				{ gap: "xl", verticalAlignment: "middle", wrap: false, theme: { tone: "dark" } },
			),
		];

		expect(roundTrip(stored)).toEqual(stored);
	});

	it("keeps an empty column empty", () => {
		const stored = [columns("cols", [column("a", [paragraph("p1", "Only")]), column("b", [])])];

		expect(roundTrip(stored)).toEqual(stored);
	});

	it("keeps block keys that repeat across columns, and renames a repeated column key", () => {
		const stored = [
			columns("cols", [
				column("a", [paragraph("same", "One")]),
				column("b", [paragraph("same", "Two")]),
			]),
		];
		expect(roundTrip(stored)).toEqual(stored);

		const repeated = roundTrip([
			columns("cols", [
				column("a", [paragraph("p1", "One")]),
				column("a", [paragraph("p2", "Two")]),
			]),
		]) as Array<{ columns: Array<{ _key: string }> }>;
		const keys = repeated[0]!.columns.map((col) => col._key);
		expect(keys[0]).toBe("a");
		expect(keys[1]).not.toBe("a");
	});

	it("round-trips plugin, table, iframe, HTML and columns blocks inside a column", () => {
		const stored = [
			columns("outer", [
				column("a", [
					{ _type: "callout", _key: "plug", tone: "info" },
					{
						_type: "table",
						_key: "t",
						rows: [
							{
								_type: "tableRow",
								_key: "r",
								cells: [
									{
										_type: "tableCell",
										_key: "c",
										content: [{ _type: "span", _key: "s", text: "Cell" }],
									},
								],
							},
						],
					},
				]),
				column("b", [
					{ _type: "iframe", _key: "f", src: "https://example.com/embed" },
					{ _type: "htmlBlock", _key: "h", html: "<p>Inline</p>" },
					columns("inner", [column("c", [paragraph("p", "Two deep")])]),
				]),
			]),
		];

		expect(roundTrip(stored)).toEqual(roundTrip(roundTrip(stored)));
		const restored = roundTrip(stored) as Array<{
			columns: Array<{ content: Array<{ _type: string; _key: string }> }>;
		}>;
		expect(restored[0]!.columns[0]!.content.map((block) => block._type)).toEqual([
			"callout",
			"table",
		]);
		expect(restored[0]!.columns[1]!.content.map((block) => [block._type, block._key])).toEqual([
			["iframe", "f"],
			["htmlBlock", "h"],
			["columns", "inner"],
		]);
		expect(restored[0]!.columns[0]!.content[0]).toEqual({
			_type: "callout",
			_key: "plug",
			tone: "info",
		});
	});

	it("keeps a block type a plugin registers as that plugin's block inside a column", () => {
		const doc = portableTextToProsemirror(
			[
				columns("cols", [
					column("a", [{ _type: "iframe", _key: "f", src: "https://example.com" }]),
				]),
			] as Blocks,
			new Set(["iframe"]),
		);
		const inner = (doc.content[0] as { content: Array<{ content: Array<{ type: string }> }> })
			.content[0]!.content[0]!;

		expect(inner.type).toBe("pluginBlock");
	});

	it("leaves a malformed columns block, or one a plugin registers, as an opaque block", () => {
		const malformed = [
			{ _type: "columns", _key: "m1", columns: "nope" },
			{ _type: "columns", _key: "m2", columns: [] },
			{ _type: "columns", _key: "m3", columns: [{ _key: "x", content: [] }] },
			{ _type: "columns", _key: "m4", columns: [{ _type: "column", _key: "y" }] },
		];
		const doc = portableTextToProsemirror(malformed as Blocks);

		expect((doc.content as Array<{ type: string }>).map((node) => node.type)).toEqual([
			"pluginBlock",
			"pluginBlock",
			"pluginBlock",
			"pluginBlock",
		]);
		expect(roundTrip(malformed)).toEqual(malformed);

		const registered = portableTextToProsemirror(
			[columns("cols", [column("a", [])])] as Blocks,
			new Set(["columns"]),
		);
		expect((registered.content[0] as { type: string }).type).toBe("pluginBlock");
	});

	it("gives the editor a document its schema accepts as it is", () => {
		const doc = portableTextToProsemirror([
			paragraph("intro", "Intro"),
			columns("outer", [
				column("a", [{ _type: "htmlBlock", _key: "h", html: "<p>x</p>" }]),
				column("b", [columns("inner", [column("c", [])])]),
			]),
		] as Blocks);

		expect(() => schema().nodeFromJSON(doc).check()).not.toThrow();
	});

	it("numbers the lists in each column on their own, as the editor does after loading", () => {
		const item = (key: string, text: string) => ({
			...paragraph(key, text),
			listItem: "number",
			level: 1,
			listId: "shared",
			listStart: 1,
		});
		const doc = portableTextToProsemirror([
			columns("cols", [
				column("a", [item("a1", "One"), item("a2", "Two")]),
				column("b", [item("b1", "One")]),
			]),
		] as Blocks);

		expect(normalizeOrderedListDocument(schema().nodeFromJSON(doc))).toEqual([]);
	});

	it("reports an unsupported mark inside a column", () => {
		const blocks = [
			columns("cols", [
				column("a", [
					{
						_type: "block",
						_key: "p",
						children: [{ _type: "span", _key: "s", text: "x", marks: ["highlight"] }],
					},
				]),
			]),
		];

		expect(findUnsupportedPortableTextMarks(blocks)).toEqual(["highlight"]);
	});
});
