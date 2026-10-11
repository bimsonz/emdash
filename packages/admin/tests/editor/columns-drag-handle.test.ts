/**
 * The drag handle targets rows: a block of the document or of a column. A
 * list is one row, a column's blocks are rows of their own, and a column or a
 * list item never is.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { DragHandlePlugin, normalizeNestedOptions } from "@tiptap/extension-drag-handle";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { ColumnBlock, ColumnsBlock } from "../../src/components/editor/ColumnsExtension";
import { _rowsOnlyRule } from "../../src/components/editor/DragHandleWrapper";
import { TopBlockDocument } from "../../src/components/editor/EmbedBlockShell";

const text = (value: string): JSONContent => ({
	type: "paragraph",
	content: [{ type: "text", text: value }],
});

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

function setup(content: JSONContent[]) {
	const host = document.createElement("div");
	host.style.width = "640px";
	const editorElement = document.createElement("div");
	const handle = document.createElement("div");
	host.append(editorElement, handle);
	document.body.append(host);
	const editor = new Editor({
		element: editorElement,
		extensions: [
			StarterKit.configure({ document: false }),
			TopBlockDocument,
			ColumnsBlock,
			ColumnBlock,
		],
		content: { type: "doc", content },
	});
	const targets: string[] = [];
	const { plugin } = DragHandlePlugin({
		editor,
		element: handle,
		nestedOptions: normalizeNestedOptions({
			rules: [_rowsOnlyRule],
			defaultRules: false,
			edgeDetection: "none",
		}),
		onNodeChange: ({ node, pos }) => {
			if (node) {
				const depth = editor.state.doc.resolve(pos).depth;
				targets.push(`${node.type.name}:${node.textContent}@${depth}`);
			}
		},
	});
	editor.registerPlugin(plugin);
	cleanup = () => {
		editor.destroy();
		host.remove();
	};
	return { editor, targets };
}

async function hover(editor: Editor, label: string, occurrence = 0) {
	const element = [...editor.view.dom.querySelectorAll<HTMLElement>("p")].filter(
		(candidate) => candidate.textContent === label,
	)[occurrence]!;
	const rect = element.getBoundingClientRect();
	editor.view.dom.dispatchEvent(
		new MouseEvent("mousemove", {
			bubbles: true,
			clientX: rect.left + 4,
			clientY: rect.top + rect.height / 2,
		}),
	);
	await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

describe("drag handle targets", () => {
	it("targets a block inside a column, not the columns around it", async () => {
		const { editor, targets } = setup([
			text("Before"),
			{
				type: "columns",
				content: [
					{ type: "column", content: [text("Left one"), text("Left two")] },
					{ type: "column", content: [text("Right")] },
				],
			},
		]);

		await hover(editor, "Left two");
		expect(targets.at(-1)).toBe("paragraph:Left two@2");

		await hover(editor, "Right");
		expect(targets.at(-1)).toBe("paragraph:Right@2");

		await hover(editor, "Before");
		expect(targets.at(-1)).toBe("paragraph:Before@0");
	});

	it("targets a list as one block, at the top level and in a column", async () => {
		const list: JSONContent = {
			type: "bulletList",
			content: [
				{ type: "listItem", content: [text("First item")] },
				{ type: "listItem", content: [text("Second item")] },
			],
		};
		const { editor, targets } = setup([
			list,
			{ type: "columns", content: [{ type: "column", content: [structuredClone(list)] }] },
		]);

		await hover(editor, "Second item");
		expect(targets.at(-1)).toBe("bulletList:First itemSecond item@0");

		await hover(editor, "Second item", 1);
		expect(targets.at(-1)).toBe("bulletList:First itemSecond item@2");
	});
});
