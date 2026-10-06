import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";
import SiteCta from "./SiteCta.astro";

function column(key: string, children: unknown[]) {
	return { _type: "nestingColumn", _key: key, children };
}

function nesting(key: string, columns: unknown[]) {
	return {
		_type: "nestingBlock",
		_key: key,
		layout: "grid",
		columns: columns.length,
		children: columns,
	};
}

const cta = (key: string, label: string) => ({ _type: "cta", _key: key, label });

async function render(value: unknown[]) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, {
		props: { value, components: { type: { cta: SiteCta } } },
	});
}

describe("nestingBlock columns", () => {
	it("render a site component for a block inside a column", async () => {
		const html = await render([nesting("n1", [column("c1", [cta("k1", "In a column")])])]);

		expect(html).toContain("<aside data-site-cta>In a column</aside>");
		expect(html).not.toContain("data-portabletext-unknown");
	});

	it("carry the components into a container nested in a column", async () => {
		const inner = nesting("n2", [column("c2", [cta("k2", "Two deep")])]);
		const html = await render([nesting("n1", [column("c1", [inner])])]);

		expect(html).toContain("<aside data-site-cta>Two deep</aside>");
	});
});
