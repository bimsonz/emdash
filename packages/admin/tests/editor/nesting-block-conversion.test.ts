/**
 * The admin editor carries its own Portable Text converters, separate from the ones
 * in @emdash-cms/core, and a save goes through these. Core's round-trip tests do not
 * cover them: an attribute can round-trip in core and still be dropped on every save.
 */

import { describe, it, expect } from "vitest";

import {
	_prosemirrorToPortableText as prosemirrorToPortableText,
	_portableTextToProsemirror as portableTextToProsemirror,
} from "../../src/components/PortableTextEditor";

interface NestingPT {
	_type: string;
	layout?: string;
	gap?: string;
	align?: string;
	widths?: string;
	children?: Array<{ _type: string; children?: unknown[] }>;
}

const embedded = [
	{
		_type: "table",
		_key: "t1",
		hasHeaderRow: true,
		rows: [
			{
				_type: "tableRow",
				_key: "r1",
				cells: [
					{
						_type: "tableCell",
						_key: "h1",
						content: [{ _type: "span", _key: "s1", text: "Merged" }],
						isHeader: true,
						colspan: 2,
						textAlign: "right",
					},
				],
			},
		],
	},
	{
		_type: "iframe",
		_key: "f1",
		src: "https://www.youtube.com/embed/abc",
		title: "Video",
		width: 560,
		height: 315,
		allowFullscreen: true,
	},
	{
		_type: "htmlBlock",
		_key: "h2",
		html: "<div id=widget></div>",
		css: "#widget { color: red; }",
		js: "document.title = 'x';",
		isolated: true,
	},
];

function column(text: string) {
	return {
		type: "nestingColumn",
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	};
}

describe("nesting block round-trip (admin editor seam)", () => {
	it("keeps every layout attribute through PM to PT", () => {
		const [block] = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "nestingBlock",
					attrs: { layout: "grid", gap: "lg", align: "center", widths: "wide-first" },
					content: [column("left"), column("right")],
				},
			],
		}) as unknown as NestingPT[];

		expect(block).toMatchObject({
			_type: "nestingBlock",
			layout: "grid",
			gap: "lg",
			align: "center",
			widths: "wide-first",
		});
		expect(block.children).toHaveLength(2);
	});

	it("keeps every layout attribute through PT to PM", () => {
		const doc = portableTextToProsemirror([
			{
				_type: "nestingBlock",
				_key: "n1",
				layout: "flex",
				gap: "sm",
				align: "end",
				widths: "narrow-last",
				children: [
					{ _type: "nestingColumn", _key: "c1", children: [] },
					{ _type: "nestingColumn", _key: "c2", children: [] },
				],
			},
		] as never);

		expect(doc.content?.[0]).toMatchObject({
			type: "nestingBlock",
			attrs: { layout: "flex", gap: "sm", align: "end", widths: "narrow-last" },
		});
	});

	it("survives a full PT to PM to PT cycle, which is what a save does", () => {
		const original = {
			_type: "nestingBlock",
			_key: "n1",
			layout: "grid",
			gap: "md",
			align: "start",
			widths: "wide-last",
			children: [
				{ _type: "nestingColumn", _key: "c1", children: [] },
				{ _type: "nestingColumn", _key: "c2", children: [] },
			],
		};

		const roundTripped = prosemirrorToPortableText(
			portableTextToProsemirror([original] as never) as never,
		) as unknown as NestingPT[];

		expect(roundTripped[0]).toMatchObject({
			layout: "grid",
			gap: "md",
			align: "start",
			widths: "wide-last",
		});
	});

	it("falls back to equal for a missing or unrecognised widths value", () => {
		const doc = portableTextToProsemirror([
			{
				_type: "nestingBlock",
				_key: "n1",
				widths: "sideways",
				children: [{ _type: "nestingColumn", _key: "c1", children: [] }],
			},
		] as never);

		expect(doc.content?.[0]).toMatchObject({ attrs: { widths: "equal" } });
	});

	it("round-trips tables, iframes and isolated HTML inside a column", () => {
		const original = {
			_type: "nestingBlock",
			_key: "n1",
			layout: "grid",
			gap: "md",
			align: "start",
			widths: "equal",
			children: [{ _type: "nestingColumn", _key: "c1", children: embedded }],
		};

		const doc = portableTextToProsemirror([original] as never) as unknown as {
			content: Array<{ content: Array<{ content: Array<{ type: string }> }> }>;
		};

		expect(doc.content[0]!.content[0]!.content.map((n) => n.type)).toEqual([
			"table",
			"iframeBlock",
			"htmlBlock",
		]);
		expect(
			(prosemirrorToPortableText(doc as never) as unknown as NestingPT[])[0]!.children![0]!
				.children,
		).toStrictEqual(embedded);
	});

	it("keeps a plugin's own iframe type a plugin block inside a column", () => {
		const doc = portableTextToProsemirror(
			[
				{
					_type: "nestingBlock",
					_key: "n1",
					children: [
						{
							_type: "nestingColumn",
							_key: "c1",
							children: [{ _type: "iframe", _key: "p1", src: "https://example.com" }],
						},
					],
				},
			] as never,
			new Set(["iframe"]),
		) as unknown as { content: Array<{ content: Array<{ content: Array<{ type: string }> }> }> };

		expect(doc.content[0]!.content[0]!.content[0]!.type).toBe("pluginBlock");
	});
});
