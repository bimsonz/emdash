// @vitest-environment jsdom

/**
 * Plugin blocks in the inline (visual-editing) editor, shown as the page renders them when the
 * page supplies a preview (`BlockPreview`), and as the "edit in admin" placeholder when it does not.
 */

import { pluginBlockKey, pluginBlockKeyFromAttrs } from "@emdash-cms/admin/plugin-block-key";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	InlinePortableTextEditor,
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const tiles = { _type: "featureGrid", _key: "k-tiles", set: "home", heading: "Start here" };
const video = { _type: "youtube", _key: "k-video", id: "dQw4w9WgXcQ", title: "Intro" };
const embed = { _type: "embed", _key: "k-embed", url: "https://example.com/x" };
const loose = { _type: "counter", _key: "k-count", id: 7, label: "Seven" };
const paragraph = {
	_type: "block" as const,
	_key: "k-p",
	style: "normal" as const,
	markDefs: [],
	children: [{ _type: "span" as const, _key: "k-p-1", text: "Some text.", marks: [] }],
};

describe("plugin block content keys", () => {
	it("give a stored block and the editor node it becomes the same key, whatever its identity", () => {
		for (const block of [tiles, video, embed, loose]) {
			const pm = portableTextToPM([block]);
			const node = pm.content?.[0] as { type: string; attrs: Record<string, unknown> };
			expect(node.type).toBe("pluginBlock");
			expect(pluginBlockKeyFromAttrs(node.attrs)).toBe(pluginBlockKey(block));
		}
	});

	it("survive a save, which gives the block a new _key", () => {
		const saved = pmToPortableText(portableTextToPM([tiles]))[0] as Record<string, unknown>;
		expect(saved._key).not.toBe(tiles._key);
		expect(pluginBlockKey(saved)).toBe(pluginBlockKey(tiles));
	});

	it("change when a field changes, and ignore field order", () => {
		expect(pluginBlockKey({ ...tiles, heading: "Other" })).not.toBe(pluginBlockKey(tiles));
		expect(pluginBlockKey({ heading: "Start here", set: "home", _type: "featureGrid" })).toBe(
			pluginBlockKey(tiles),
		);
	});
});

describe("plugin blocks in the inline editor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let puts: unknown[];

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		puts = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				if (init?.method === "PUT") puts.push(init.body);
				return Response.json({ data: {} });
			}),
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		for (const t of document.querySelectorAll("template[data-emdash-block-preview]")) t.remove();
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function supplyPreview(block: Record<string, unknown>, html: string) {
		const template = document.createElement("template");
		template.setAttribute("data-emdash-block-preview", pluginBlockKey(block));
		template.innerHTML = html;
		document.body.append(template);
	}

	async function mount(value: unknown[]) {
		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: structuredClone(value) as never,
					collection: "pages",
					entryId: "entry-1",
					field: "content",
				}),
			);
		});
		await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
	}

	it("shows a block the page previewed as the page renders it, with a link to its settings", async () => {
		supplyPreview(
			tiles,
			'<section class="tiles"><astro-island><ul><li>What is bouldering?</li></ul></astro-island></section>',
		);
		await mount([paragraph, tiles]);

		const block = container.querySelector(".emdash-plugin-block-preview");
		expect(block).not.toBeNull();
		expect(block?.getAttribute("data-block-type")).toBe("featureGrid");
		expect(container.textContent).not.toContain("edit in admin");

		const shadow = block?.querySelector(".emdash-plugin-block-preview-content")?.shadowRoot;
		expect(shadow?.querySelector("section.tiles li")?.textContent).toBe("What is bouldering?");
		// A preview is the island's server markup, not a second running copy of it.
		expect(shadow?.querySelector("astro-island")).toBeNull();

		const link = block?.querySelector<HTMLAnchorElement>("a.emdash-plugin-block-edit");
		expect(link?.getAttribute("href")).toBe(
			`/_emdash/admin/content/pages/entry-1?block=${encodeURIComponent(pluginBlockKey(tiles))}`,
		);
	});

	it("runs no script that came with a preview", async () => {
		const ran = vi.fn();
		(globalThis as { previewScriptRan?: () => void }).previewScriptRan = ran;
		supplyPreview(tiles, "<section>tiles</section><script>globalThis.previewScriptRan()</script>");
		await mount([tiles]);

		const shadow = container.querySelector(".emdash-plugin-block-preview-content")?.shadowRoot;
		expect(shadow?.querySelector("section")?.textContent).toBe("tiles");
		expect(shadow?.querySelector("script")).toBeNull();
		expect(ran).not.toHaveBeenCalled();
		delete (globalThis as { previewScriptRan?: () => void }).previewScriptRan;
	});

	it("keeps the placeholder for a block the page did not preview", async () => {
		supplyPreview(tiles, "<section>tiles</section>");
		await mount([tiles, video]);

		const placeholders = container.querySelectorAll(".emdash-plugin-block-placeholder");
		expect(placeholders).toHaveLength(1);
		expect(placeholders[0]?.textContent).toBe("Plugin block: youtube (edit in admin)");
		expect(container.querySelectorAll(".emdash-plugin-block-preview")).toHaveLength(1);
	});

	it("saves nothing when a body with previews is opened and left alone", async () => {
		supplyPreview(tiles, "<section>tiles</section>");
		await mount([paragraph, tiles]);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
		expect(puts).toHaveLength(0);
	});
});
