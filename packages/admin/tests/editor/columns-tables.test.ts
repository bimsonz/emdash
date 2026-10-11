/**
 * A table inside a column is a row of that column, so it is pasted and keyed
 * as a table of the document is.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColumnBlock, ColumnsBlock } from "../../src/components/editor/ColumnsExtension";
import { TopBlockDocument } from "../../src/components/editor/EmbedBlockShell";
import { createTableCellSafety } from "../../src/components/editor/TableCellSafety";
import {
	EmDashTable,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
	TableIdentity,
} from "../../src/components/editor/TableExtensions";

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

const table = (key: string): JSONContent => ({
	type: "table",
	attrs: { emdashKey: key },
	content: [
		{
			type: "tableRow",
			attrs: { emdashKey: `${key}-row` },
			content: [
				{
					type: "tableCell",
					attrs: { emdashKey: `${key}-cell` },
					content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
				},
			],
		},
	],
});

function createEditor(content: JSONContent[], onRejected = vi.fn()) {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ document: false }),
			TopBlockDocument,
			ColumnsBlock,
			ColumnBlock,
			EmDashTable,
			EmDashTableRow,
			EmDashTableHeader,
			EmDashTableCell,
			TableIdentity,
			createTableCellSafety(onRejected),
		],
		content: { type: "doc", content },
	});
	editors.push(editor);
	return { editor, onRejected };
}

function tableKeys(editor: Editor): string[] {
	const keys: string[] = [];
	editor.state.doc.descendants((node) => {
		if (node.type.spec.tableRole === "table") keys.push(node.attrs.emdashKey);
	});
	return keys;
}

describe("tables inside columns", () => {
	it("accepts a pasted columns block that holds a table", () => {
		const { editor, onRejected } = createEditor([{ type: "paragraph" }]);
		const columns = editor.schema.nodeFromJSON({
			type: "columns",
			content: [{ type: "column", content: [table("pasted")] }],
		});
		const plugin = editor.state.plugins.find(({ key }) => key.startsWith("tableCellSafety$"));

		plugin!.props.handlePaste!(
			editor.view,
			new ClipboardEvent("paste"),
			new Slice(Fragment.from(columns), 0, 0),
		);

		expect(onRejected).not.toHaveBeenCalled();
	});

	it("gives a copied table in a column a key of its own", () => {
		const { editor } = createEditor([
			{
				type: "columns",
				content: [
					{ type: "column", content: [table("source-table")] },
					{ type: "column", content: [{ type: "paragraph" }] },
				],
			},
		]);
		let secondColumnStart = -1;
		let seen = 0;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "column" && seen++ === 1) secondColumnStart = pos + 1;
		});
		const source = editor.state.doc.firstChild!.firstChild!.firstChild!;

		editor.view.dispatch(editor.state.tr.insert(secondColumnStart, source));

		const keys = tableKeys(editor);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
		expect(keys).toContain("source-table");
	});
});
