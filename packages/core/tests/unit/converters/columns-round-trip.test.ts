import { describe, it, expect } from "vitest";

import { UnsupportedPortableTextMarksError } from "../../../src/content/converters/mark-safety.js";
import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	ProseMirrorDocument,
	ProseMirrorNode,
} from "../../../src/content/converters/types.js";

const paragraph = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
	_type: "block" as const,
	_key: key,
	style: "normal" as const,
	children: [{ _type: "span" as const, _key: `${key}s`, text }],
	...extra,
});

const blocks = [
	{
		_type: "columns",
		_key: "cols",
		gap: "lg",
		verticalAlignment: "center",
		theme: "kept",
		columns: [
			{ _type: "column", _key: "a", span: 2, content: [paragraph("p1", "Left")] },
			{
				_type: "column",
				_key: "b",
				width: "30%",
				content: [
					{ _type: "htmlBlock", _key: "h", html: "<p>Inline</p>" },
					{
						_type: "columns",
						_key: "inner",
						columns: [{ _type: "column", _key: "c", content: [] }],
					},
				],
			},
		],
	},
] as PortableTextBlock[];

/** The blocks with every `_key` below the columns blocks and columns removed, which conversion without identity regenerates. */
function withoutBlockKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutBlockKeys);
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	const keep = record._type === "columns" || record._type === "column";
	return Object.fromEntries(
		Object.entries(record)
			.filter(([key]) => keep || key !== "_key")
			.map(([key, child]) => [key, withoutBlockKeys(child)]),
	);
}

describe("columns round trip (core converters)", () => {
	it("converts columns to editor nodes and back", () => {
		const doc = portableTextToProsemirror(blocks);
		const node = doc.content[0] as ProseMirrorNode;

		expect(node.type).toBe("columns");
		expect(node.content?.map((child) => child.type)).toEqual(["column", "column"]);
		expect(withoutBlockKeys(prosemirrorToPortableText(doc))).toEqual(withoutBlockKeys(blocks));
	});

	it("keeps columns opaque, and exactly as stored, when converting with identity", () => {
		const doc = portableTextToProsemirror(blocks, { preserveIdentity: true });

		expect((doc.content[0] as ProseMirrorNode).type).not.toBe("columns");
		expect(prosemirrorToPortableText(doc)).toEqual(blocks);
	});

	it("refuses unsupported marks inside a column, as at the top level", () => {
		const withHighlight = [
			{
				_type: "columns",
				_key: "cols",
				columns: [
					{
						_type: "column",
						_key: "a",
						content: [
							{
								_type: "block",
								_key: "p",
								children: [{ _type: "span", _key: "s", text: "x", marks: ["highlight"] }],
							},
						],
					},
				],
			},
		] as PortableTextBlock[];

		expect(() => portableTextToProsemirror(withHighlight)).toThrow(
			UnsupportedPortableTextMarksError,
		);
	});

	it("numbers the lists in each column on their own", () => {
		const item = (key: string, text: string) =>
			paragraph(key, text, { listItem: "number", level: 1, listId: "shared", listStart: 1 });
		const doc = portableTextToProsemirror([
			{
				_type: "columns",
				_key: "cols",
				columns: [
					{ _type: "column", _key: "a", content: [item("a1", "One"), item("a2", "Two")] },
					{ _type: "column", _key: "b", content: [item("b1", "One")] },
				],
			},
		] as PortableTextBlock[]);
		const lists = (doc.content[0] as ProseMirrorNode).content!.map(
			(column) => column.content![0]!.attrs as Record<string, unknown>,
		);

		expect(lists.map((attrs) => attrs.start)).toEqual([1, 1]);
		expect(lists[0]!.listId).not.toBe(lists[1]!.listId);
	});

	it("reads a columns node with no stored keys", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "columns",
					content: [{ type: "column", content: [{ type: "paragraph" }] }],
				},
			],
		};
		const [block] = prosemirrorToPortableText(doc) as Array<{
			_key: string;
			columns: Array<{ _key: string; content: unknown[] }>;
		}>;

		expect(block!._key).toBeTruthy();
		expect(block!.columns[0]!._key).toBeTruthy();
		expect(block!.columns[0]!.content).toEqual([]);
	});
});
