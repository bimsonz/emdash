import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";
import SiteCallout from "./fixtures/SiteCallout.astro";

const paragraph = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-span`, text, marks: [] }],
	...extra,
});
const callout = (key: string, label: string) => ({ _type: "callout", _key: key, label });
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

async function render(value: unknown[]) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, {
		props: { value, components: { type: { callout: SiteCallout } } },
	});
}

function columnsTag(html: string): string {
	return html.match(/<div[^>]*class="emdash-columns[^"]*"[^>]*>/)?.[0] ?? "";
}

function columnTags(html: string): string[] {
	return html.match(/<div[^>]*class="emdash-column(?:\s[^"]*)?"[^>]*>/g) ?? [];
}

describe("columns rendering", () => {
	it("renders a block in a column with the components passed to PortableText", async () => {
		const html = await render([columns("cols", [column("a", [callout("k1", "In a column")])])]);

		expect(html).toContain("<aside data-site-callout>In a column</aside>");
		expect(html).not.toContain("data-portabletext-unknown");
	});

	it("passes the components on to columns nested in a column", async () => {
		const inner = columns("inner", [column("b", [callout("k2", "Two deep")])]);
		const html = await render([columns("cols", [column("a", [inner])])]);

		expect(html).toContain("<aside data-site-callout>Two deep</aside>");
	});

	it("groups a column's quotes and numbers its lists as at the top level", async () => {
		const html = await render([
			columns("cols", [
				column("a", [
					paragraph("q1", "First line", { style: "blockquote" }),
					paragraph("q2", "Second line", { style: "blockquote" }),
					paragraph("n1", "Third", { listItem: "number", level: 1, listId: "l", listStart: 3 }),
				]),
			]),
		]);

		expect(html.match(/<blockquote\b/g)).toHaveLength(1);
		expect(html).toMatch(/<ol\b[^>]*start="3"/);
	});

	it("renders gap, alignment, wrap and span as classes, and ignores values it does not know", async () => {
		const html = await render([
			columns("cols", [column("a", [paragraph("p1", "Wide")], { span: 2 }), column("b", [])], {
				gap: "lg",
				verticalAlignment: "center",
				wrap: true,
			}),
			columns("odd", [column("c", [paragraph("p2", "Odd")], { span: 9 })], {
				gap: "xl",
				verticalAlignment: "middle",
			}),
		]);
		const [first, second] = html.split('class="emdash-columns').slice(1);

		expect(first).toMatch(
			/^ emdash-columns--gap-lg emdash-columns--align-center emdash-columns--wrap"/,
		);
		expect(columnTags(html)[0]).toContain("emdash-column--span-2");
		expect(second).toMatch(/^"/);
		expect(columnTags(html)[2]).not.toContain("--span-");
	});

	it("needs no inline style, except for a column that sets its own width", async () => {
		const html = await render([
			columns("cols", [
				column("a", [paragraph("p1", "Sized")], { width: "33.33%" }),
				column("b", [paragraph("p2", "Rest")]),
				column("c", [paragraph("p3", "Bad")], { width: "1px; background: red" }),
			]),
		]);
		const [sized, rest, bad] = columnTags(html);

		expect(columnsTag(html)).not.toContain("style=");
		expect(sized).toContain('style="flex-basis: 33.33%"');
		expect(rest).not.toContain("style=");
		expect(bad).not.toContain("style=");
	});
});
