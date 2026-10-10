import { safeFields } from "./portable-text-fields.js";

export const COLUMNS_GAPS = ["none", "sm", "md", "lg"] as const;
export const COLUMNS_VERTICAL_ALIGNMENTS = ["top", "center", "bottom"] as const;
export const COLUMN_SPANS = [1, 2, 3] as const;
/** The most columns the editor offers to add. Stored blocks may hold more. */
export const MAX_EDITOR_COLUMNS = 6;

export type PortableTextColumnsGap = (typeof COLUMNS_GAPS)[number];
export type PortableTextColumnsVerticalAlignment = (typeof COLUMNS_VERTICAL_ALIGNMENTS)[number];
export type PortableTextColumnSpan = (typeof COLUMN_SPANS)[number];

export interface PortableTextColumn {
	_type: "column";
	_key: string;
	content: Array<{ _type: string; _key: string; [key: string]: unknown }>;
	/** Relative width: a column with span 2 is twice as wide as a column with span 1. */
	span?: PortableTextColumnSpan;
	/** A CSS length the column starts from. Set by imports or by hand; the editor never writes it. */
	width?: string;
	[key: string]: unknown;
}

export interface PortableTextColumnsBlock {
	_type: "columns";
	_key: string;
	columns: PortableTextColumn[];
	gap?: PortableTextColumnsGap;
	verticalAlignment?: PortableTextColumnsVerticalAlignment;
	/** Columns wrap onto new rows at a minimum width, rather than stacking on narrow screens. */
	wrap?: boolean;
	[key: string]: unknown;
}

export interface PortableTextColumnsProseMirrorNode {
	attrs?: Record<string, unknown>;
	content?: readonly unknown[];
}

const BLOCK_FIELDS = new Set(["_type", "_key", "columns", "gap", "verticalAlignment", "wrap"]);
const COLUMN_FIELDS = new Set(["_type", "_key", "content", "span"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const readKey = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * A columns block the editor can open. Anything else typed `columns` stays an
 * opaque block, so a malformed one is kept exactly as stored.
 */
export function isPortableTextColumnsInput(value: unknown): value is PortableTextColumnsBlock {
	return (
		isRecord(value) &&
		value._type === "columns" &&
		Array.isArray(value.columns) &&
		value.columns.length > 0 &&
		value.columns.every(
			(column) => isRecord(column) && column._type === "column" && Array.isArray(column.content),
		)
	);
}

/**
 * The editor nodes for a columns block. Attribute values are carried as stored,
 * including ones the renderer ignores, so an untouched block saves unchanged.
 * `convertContent` converts one column's blocks with the caller's converter.
 */
export function portableTextColumnsToProseMirror<Node>(
	block: PortableTextColumnsBlock,
	convertContent: (content: PortableTextColumn["content"], index: number) => Node[],
) {
	return {
		type: "columns",
		attrs: {
			emdashKey: readKey(block._key) ?? null,
			emdashData: safeFields(block, BLOCK_FIELDS),
			gap: block.gap ?? null,
			verticalAlignment: block.verticalAlignment ?? null,
			wrap: block.wrap ?? null,
		},
		content: block.columns.map((column, index) => {
			const content = convertContent(column.content, index);
			return {
				type: "column",
				attrs: {
					emdashKey: readKey(column._key) ?? null,
					emdashData: safeFields(column, COLUMN_FIELDS),
					span: column.span ?? null,
				},
				content: content.length > 0 ? content : [{ type: "paragraph" }],
			};
		}),
	};
}

/**
 * The Portable Text block for a `columns` node. A column whose key repeats a
 * sibling's gets a new one, since keys only need to be unique among siblings.
 */
export function proseMirrorColumnsToPortableText<Block>(
	node: PortableTextColumnsProseMirrorNode,
	convertContent: (content: unknown[], index: number) => Block[],
	createKey: () => string,
) {
	const attrs = isRecord(node.attrs) ? node.attrs : {};
	const usedKeys = new Set<string>();
	const columns = (node.content ?? []).filter(isRecord).map((column, index) => {
		const columnAttrs = isRecord(column.attrs) ? column.attrs : {};
		let key = readKey(columnAttrs.emdashKey) ?? createKey();
		while (usedKeys.has(key)) key = createKey();
		usedKeys.add(key);
		return {
			_type: "column" as const,
			_key: key,
			...safeFields(columnAttrs.emdashData, COLUMN_FIELDS),
			...(columnAttrs.span == null ? {} : { span: columnAttrs.span }),
			content: convertContent(Array.isArray(column.content) ? column.content : [], index),
		};
	});
	return {
		_type: "columns" as const,
		_key: readKey(attrs.emdashKey) ?? createKey(),
		...safeFields(attrs.emdashData, BLOCK_FIELDS),
		...(attrs.gap == null ? {} : { gap: attrs.gap }),
		...(attrs.verticalAlignment == null ? {} : { verticalAlignment: attrs.verticalAlignment }),
		...(attrs.wrap == null ? {} : { wrap: attrs.wrap }),
		columns,
	};
}
