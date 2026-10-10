/**
 * Editor nodes for the Portable Text `columns` block: a `columns` row holding
 * `column` nodes, each of which holds ordinary blocks, columns included.
 *
 * Layout attributes hold the stored values as they are, so an untouched block
 * saves unchanged; the renderer decides what each value means.
 */

import { Node, mergeAttributes } from "@tiptap/core";

function hiddenAttribute() {
	return { default: null, parseHTML: () => null, rendered: false };
}

/** Copied blocks keep their layout through the clipboard's HTML. */
function layoutAttribute(name: string) {
	return {
		default: null,
		parseHTML: (element: HTMLElement) => {
			const raw = element.getAttribute(`data-${name}`);
			if (raw === null) return null;
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return null;
			}
		},
		renderHTML: (attributes: Record<string, unknown>) =>
			attributes[name] == null ? {} : { [`data-${name}`]: JSON.stringify(attributes[name]) },
	};
}

export const ColumnsBlock = Node.create({
	name: "columns",
	group: "topBlock",
	content: "column+",
	isolating: true,
	defining: true,
	draggable: true,
	selectable: true,

	addAttributes() {
		return {
			emdashKey: hiddenAttribute(),
			emdashData: hiddenAttribute(),
			gap: layoutAttribute("gap"),
			verticalAlignment: layoutAttribute("vertical-alignment"),
			wrap: layoutAttribute("wrap"),
		};
	},

	parseHTML() {
		return [{ tag: "div[data-emdash-columns]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-emdash-columns": "" }), 0];
	},
});

export const ColumnBlock = Node.create({
	name: "column",
	content: "(block | topBlock)+",
	isolating: true,
	selectable: false,

	addAttributes() {
		return {
			emdashKey: hiddenAttribute(),
			emdashData: hiddenAttribute(),
			span: layoutAttribute("span"),
		};
	},

	parseHTML() {
		return [{ tag: "div[data-emdash-column]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-emdash-column": "" }), 0];
	},
});
