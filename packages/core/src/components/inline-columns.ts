/**
 * The `columns` block in the visual editor.
 *
 * A columns block shows on the page as it is published: its columns side by
 * side at their widths, or stacked on a narrow screen, each holding its
 * blocks to edit in place. The markup is `Columns.astro`'s, so the site's
 * own styles lay it out. Labels name the layout and the column the caret is
 * in; they are decorations, so they never reach the document or a save.
 *
 * The page edits what the columns hold, not the layout. Adding, moving,
 * resizing and deleting columns happen in the admin's editor, so no change
 * made here can add a column or take one away.
 */

import { Extension, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { columnClasses, columnsClasses, columnStyle } from "./columns-layout.js";

function hiddenAttribute() {
	return { default: null, parseHTML: () => null, rendered: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Document node that also accepts `topBlock` nodes. Quotes and list items
 * accept only `block`, so a columns block can't be dropped or pasted into
 * one, where saving would drop it.
 */
export const InlineDocument = Node.create({
	name: "doc",
	topNode: true,
	content: "(block | topBlock)+",
});

// Neither node parses HTML, so a copied layout pastes as the blocks it held,
// never as new columns.
export const InlineColumns = Node.create({
	name: "columns",
	group: "topBlock",
	content: "column+",
	isolating: true,
	defining: true,
	selectable: false,
	draggable: false,

	addAttributes() {
		return {
			emdashKey: hiddenAttribute(),
			emdashData: hiddenAttribute(),
			gap: hiddenAttribute(),
			verticalAlignment: hiddenAttribute(),
			wrap: hiddenAttribute(),
		};
	},

	renderHTML({ node }) {
		return ["div", { class: columnsClasses(node.attrs).join(" ") }, 0];
	},
});

export const InlineColumn = Node.create({
	name: "column",
	content: "(block | topBlock)+",
	isolating: true,
	selectable: false,

	addAttributes() {
		return {
			emdashKey: hiddenAttribute(),
			emdashData: hiddenAttribute(),
			span: hiddenAttribute(),
		};
	},

	renderHTML({ node }) {
		const data: unknown = node.attrs.emdashData;
		const style = columnStyle(isRecord(data) ? data : {});
		return ["div", { class: columnClasses(node.attrs).join(" "), ...(style ? { style } : {}) }, 0];
	},
});

const layouts = new WeakMap<ProseMirrorNode, string>();

/** Every columns block in the document, in order, as its depth and its number of columns. */
function layoutOf(doc: ProseMirrorNode): string {
	let layout = layouts.get(doc);
	if (layout !== undefined) return layout;
	const rows: string[] = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) return false;
		if (node.type.name === "columns") rows.push(`${doc.resolve(pos).depth}:${node.childCount}`);
		return true;
	});
	layout = rows.join(",");
	layouts.set(doc, layout);
	return layout;
}

const labels = new WeakMap<ProseMirrorNode, DecorationSet>();

function labelsOf(doc: ProseMirrorNode): DecorationSet {
	let set = labels.get(doc);
	if (set) return set;
	const decorations: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) return false;
		if (node.type.name !== "columns") return true;
		const count = node.childCount;
		decorations.push(
			Decoration.node(pos, pos + node.nodeSize, {
				"data-emdash-columns-label": `${count} ${count === 1 ? "column" : "columns"} (edit layout in admin)`,
			}),
		);
		node.forEach((column, offset, index) => {
			const from = pos + 1 + offset;
			decorations.push(
				Decoration.node(from, from + column.nodeSize, {
					"data-emdash-column-label": `Column ${index + 1} of ${count}`,
				}),
			);
		});
		return true;
	});
	set = DecorationSet.create(doc, decorations);
	labels.set(doc, set);
	return set;
}

/** Labels the layout and its columns, and refuses any change to the layout. */
export const InlineColumnsLayout = Extension.create({
	name: "inlineColumnsLayout",

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("inlineColumnsLayout"),
				filterTransaction: (tr, state) =>
					!tr.docChanged || layoutOf(tr.doc) === layoutOf(state.doc),
				props: {
					decorations: (state) => labelsOf(state.doc),
				},
			}),
		];
	},
});

/** The columns block's default layout from `Columns.astro`, whose styles are scoped to it, and its labels. */
export const INLINE_COLUMNS_STYLES = `
	.emdash-inline-editor .emdash-columns {
		position: relative;
		display: flex;
		gap: 2rem;
		margin: 1.5rem 0;
		outline: 1px dashed color-mix(in srgb, currentColor 22%, transparent);
		outline-offset: 0.5rem;
	}
	.emdash-inline-editor .emdash-columns--gap-none {
		gap: 0;
	}
	.emdash-inline-editor .emdash-columns--gap-sm {
		gap: 1rem;
	}
	.emdash-inline-editor .emdash-columns--gap-lg {
		gap: 3rem;
	}
	.emdash-inline-editor .emdash-columns--align-top {
		align-items: flex-start;
	}
	.emdash-inline-editor .emdash-columns--align-center {
		align-items: center;
	}
	.emdash-inline-editor .emdash-columns--align-bottom {
		align-items: flex-end;
	}
	.emdash-inline-editor .emdash-columns--wrap {
		flex-wrap: wrap;
	}
	.emdash-inline-editor .emdash-column {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	.emdash-inline-editor .emdash-column--span-2 {
		flex-grow: 2;
	}
	.emdash-inline-editor .emdash-column--span-3 {
		flex-grow: 3;
	}
	.emdash-inline-editor .emdash-columns--wrap > .emdash-column {
		min-width: min(100%, 12rem);
	}
	.emdash-inline-editor .emdash-column > :first-child {
		margin-top: 0;
	}
	.emdash-inline-editor .emdash-column > :last-child {
		margin-bottom: 0;
	}
	@media (max-width: 768px) {
		.emdash-inline-editor .emdash-columns:not(.emdash-columns--wrap) {
			flex-direction: column;
		}
		.emdash-inline-editor .emdash-columns:not(.emdash-columns--wrap, .emdash-columns--gap-none) {
			gap: 1rem;
		}
	}
	.emdash-inline-editor .emdash-columns::before,
	.emdash-inline-editor .emdash-column::before {
		position: absolute;
		z-index: 1;
		inset-block-end: calc(100% + 0.125rem);
		inset-inline-start: 0;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
		font: 500 0.6875rem/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		letter-spacing: normal;
		text-transform: none;
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
	}
	.emdash-inline-editor .emdash-columns:is(:hover, .has-focus)::before {
		content: attr(data-emdash-columns-label);
		inset-block-end: calc(100% + 0.625rem);
		background: #f3f4f6;
		color: #4b5563;
	}
	.emdash-inline-editor .emdash-columns:has(.emdash-columns:is(:hover, .has-focus))::before {
		content: none;
	}
	.emdash-inline-editor .emdash-column.has-focus {
		outline: 2px solid oklch(57.72% 0.2324 260 / 0.55);
		outline-offset: 0.25rem;
	}
	.emdash-inline-editor .emdash-column.has-focus::before {
		content: attr(data-emdash-column-label);
		inset-block-end: auto;
		inset-block-start: -1.375rem;
		inset-inline-start: auto;
		inset-inline-end: 0;
		background: oklch(57.72% 0.2324 260);
		color: #fff;
	}
	.emdash-inline-editor .emdash-column.has-focus:has(.emdash-column.has-focus) {
		outline: none;
	}
	.emdash-inline-editor .emdash-column.has-focus:has(.emdash-column.has-focus)::before {
		content: none;
	}
	@media (prefers-color-scheme: dark) {
		.emdash-inline-editor .emdash-columns:is(:hover, .has-focus)::before {
			background: #1f2937;
			color: #d1d5db;
		}
	}
`;
