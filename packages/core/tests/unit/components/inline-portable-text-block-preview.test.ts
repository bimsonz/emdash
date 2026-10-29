// @vitest-environment jsdom

/**
 * Plugin blocks in the inline (visual-editing) editor: shown as the page renders them, running,
 * when the page supplies a preview (`BlockPreview`), and as a slot naming the block when it does
 * not; their settings edited on the page in the admin's Block Kit form, inserted from the slash
 * menu, moved and deleted, and redrawn from the page once saved.
 */

import { pluginBlockKey, pluginBlockKeyFromAttrs } from "@emdash-cms/admin/plugin-block-key";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

function paragraph(key: string, text: string) {
	return {
		_type: "block" as const,
		_key: key,
		style: "normal" as const,
		markDefs: [],
		children: [{ _type: "span" as const, _key: `${key}-1`, text, marks: [] }],
	};
}

/** The site's blocks, as the admin manifest lists them. */
const manifest = {
	data: {
		plugins: {
			"bb-blocks": {
				portableTextBlocks: [
					{
						type: "featureGrid",
						label: "Tiles",
						description: "A grid of picture tiles",
						category: "Sections",
						fields: [
							{
								type: "select",
								action_id: "set",
								label: "Tile set",
								options: [{ label: "Home", value: "home" }],
								optionsRoute: "options/tile-sets",
							},
							{ type: "text_input", action_id: "heading", label: "Heading" },
							{ type: "toggle", action_id: "wide", label: "Full width", initial_value: false },
						],
					},
					{
						type: "steps",
						label: "Steps",
						fields: [
							{
								type: "repeater",
								action_id: "steps",
								label: "Steps",
								item_label: "step",
								fields: [{ type: "text_input", action_id: "title", label: "Title" }],
							},
						],
					},
				],
			},
		},
	},
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

type Saved = Array<Record<string, unknown>>;

/**
 * The saved blocks' types, without the empty line the editor keeps after a body that ends in a
 * block, which saves as a block with one empty span.
 */
function types(blocks: Saved): string[] {
	const last = blocks.at(-1);
	const empty =
		last?._type === "block" &&
		Array.isArray(last.children) &&
		last.children.every((span: { text?: string }) => !span.text);
	return (empty ? blocks.slice(0, -1) : blocks).map((block) => String(block._type));
}

type TestEditor = {
	state: { doc: { content: { size: number } } };
	commands: {
		focus: () => boolean;
		setTextSelection: (position: number) => boolean;
		insertContent: (value: string) => boolean;
		splitBlock: () => boolean;
	};
};

function setValue(field: HTMLInputElement | HTMLSelectElement, value: string) {
	const prototype =
		field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
	field.dispatchEvent(
		new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
	);
}

describe("plugin blocks in the inline editor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let puts: Saved[];
	let pageRequests: number;
	/** What the page renders now, for the editor's redraw. */
	let page: string;

	beforeAll(() => {
		// ProseMirror measures ranges to place the menus; jsdom has no layout.
		Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
		Range.prototype.getBoundingClientRect ??= () => new DOMRect();
	});

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		puts = [];
		pageRequests = 0;
		page = "<!doctype html><title>Page</title>";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === "PUT" && typeof init.body === "string") {
					puts.push((JSON.parse(init.body) as { data: { content: Saved } }).data.content);
					return Response.json({ data: {} });
				}
				if (url === "/_emdash/api/manifest") return Response.json(manifest);
				if (url === "/_emdash/api/plugins/bb-blocks/options/tile-sets") {
					return Response.json({
						data: {
							items: [
								{ id: "home", name: "Home" },
								{ id: "climbing", name: "Climbing" },
							],
						},
					});
				}
				if (url === location.href) {
					pageRequests++;
					return new Response(page, { headers: { "Content-Type": "text/html" } });
				}
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

	function previewTemplate(block: Record<string, unknown>, html: string) {
		return `<template data-emdash-block-preview="${pluginBlockKey(block)}">${html}</template>`;
	}

	function supplyPreview(block: Record<string, unknown>, html: string) {
		document.body.insertAdjacentHTML("beforeend", previewTemplate(block, html));
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
		const editable = container.querySelector<HTMLElement>(".ProseMirror");
		expect(editable).not.toBeNull();
		return editable!;
	}

	function blockOf(type: string) {
		return container.querySelector<HTMLElement>(`[data-block-type="${type}"]`);
	}

	function barButton(block: HTMLElement, name: string) {
		return [...block.querySelectorAll<HTMLButtonElement>(".emdash-plugin-block-bar button")].find(
			(button) => button.getAttribute("aria-label") === name,
		);
	}

	/** The block's settings button, once the editor has the manifest. */
	function settingsButton(block: HTMLElement) {
		return vi.waitFor(() => {
			const button = barButton(
				block,
				`${block.querySelector(".emdash-plugin-block-handle")?.textContent} settings`,
			);
			expect(button?.hidden).toBe(false);
			return button!;
		});
	}

	function dialog() {
		return vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>(".emdash-inline-ui-dialog");
			expect(element).not.toBeNull();
			return element!;
		});
	}

	function field<T extends HTMLElement>(within: HTMLElement, label: string): T {
		const match = [...within.querySelectorAll("label")].find((l) => l.textContent === label);
		expect(match).toBeDefined();
		return document.getElementById(match!.htmlFor) as T;
	}

	function withText(within: HTMLElement, text: string) {
		const match = [...within.querySelectorAll("button")].find((b) => b.textContent === text);
		expect(match).toBeDefined();
		return match!;
	}

	async function click(element: HTMLElement) {
		await act(async () => element.click());
	}

	async function saved(editable: HTMLElement): Promise<Saved> {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
		await vi.waitFor(() => expect(puts).toHaveLength(1));
		return puts[0]!;
	}

	it("shows a block the page previewed as the page renders it, running", async () => {
		supplyPreview(
			tiles,
			'<section class="tiles"><astro-island component-url="/tiles.js"><ul><li>What is bouldering?</li></ul></astro-island></section><script type="module" src="/tiles-loader.js"></script>',
		);
		await mount([paragraph("p", "Intro."), tiles]);

		const block = blockOf("featureGrid");
		expect(block?.classList.contains("emdash-plugin-block-preview")).toBe(true);
		const shadow = block?.querySelector(".emdash-plugin-block-content")?.shadowRoot;
		expect(shadow?.querySelector("section.tiles li")?.textContent).toBe("What is bouldering?");
		// The island stays, to hydrate as it does on the page, and the page's script comes along.
		expect(shadow?.querySelector("astro-island")?.getAttribute("component-url")).toBe("/tiles.js");
		expect(shadow?.querySelector("script")?.getAttribute("src")).toBe("/tiles-loader.js");
	});

	it("keeps a previewed block's links and forms from leaving the page", async () => {
		supplyPreview(
			tiles,
			'<a href="/news">News</a><form action="/search"><button>Go</button></form>',
		);
		await mount([tiles]);

		const shadow = blockOf("featureGrid")?.querySelector(
			".emdash-plugin-block-content",
		)?.shadowRoot;
		const followed = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
		shadow!.querySelector("a")!.dispatchEvent(followed);
		expect(followed.defaultPrevented).toBe(true);
		const submitted = new Event("submit", { bubbles: true, cancelable: true });
		shadow!.querySelector("form")!.dispatchEvent(submitted);
		expect(submitted.defaultPrevented).toBe(true);
	});

	it("keeps a part a script finds through the document in the document, drawn in its place", async () => {
		supplyPreview(
			tiles,
			'<section class="booking"><h2>Book</h2><div class="frame"><iframe class="js-embed" data-emdash-in-document></iframe></div></section>',
		);
		await mount([tiles]);

		const host = blockOf("featureGrid")!.querySelector(".emdash-plugin-block-content")!;
		// A third-party embed script looks for its frame in the document, and finds it.
		const frame = document.querySelector("iframe.js-embed");
		expect(frame?.parentElement).toBe(host);
		// The rest of the block stays in the shadow root, and the frame is drawn where it was.
		expect(document.querySelector("section.booking")).toBeNull();
		const slot = host.shadowRoot!.querySelector<HTMLSlotElement>("section.booking .frame > slot");
		expect(slot?.assignedElements()).toEqual([frame]);
	});

	it("shows a block the page drew nothing for as a slot naming it and what it is set to", async () => {
		supplyPreview(tiles, "<section>tiles</section>");
		await mount([tiles, video]);

		const slot = blockOf("youtube")?.querySelector(".emdash-plugin-block-slot");
		expect(slot?.textContent).toBe("YoutubedQw4w9WgXcQ");
		expect(container.querySelectorAll(".emdash-plugin-block-preview")).toHaveLength(1);
		// The manifest names the site's blocks.
		await vi.waitFor(() =>
			expect(
				blockOf("featureGrid")?.querySelector(".emdash-plugin-block-handle")?.textContent,
			).toBe("Tiles"),
		);
	});

	it("edits a block's settings on the page, saves them, and redraws the block from the page", async () => {
		supplyPreview(tiles, "<h2>Start here</h2>");
		const editable = await mount([paragraph("p", "Intro."), tiles]);
		const block = blockOf("featureGrid")!;

		await click(await settingsButton(block));
		const form = await dialog();
		expect(form.querySelector("h2")?.textContent).toBe("Edit Tiles");
		const heading = field<HTMLInputElement>(form, "Heading");
		expect(heading.value).toBe("Start here");
		// The tile sets come from the plugin's route.
		await vi.waitFor(() =>
			expect(Array.from(field<HTMLSelectElement>(form, "Tile set").options, (o) => o.text)).toEqual(
				["Select...", "Home", "Climbing"],
			),
		);

		const changed = { ...tiles, heading: "Find your way", set: "climbing", wide: false };
		page = `<!doctype html><title>Page</title>${previewTemplate(changed, "<h2>Find your way</h2>")}`;
		await act(async () => {
			setValue(heading, "Find your way");
			setValue(field<HTMLSelectElement>(form, "Tile set"), "climbing");
		});
		await click(withText(form, "Save"));

		await vi.waitFor(() => expect(puts).toHaveLength(1));
		expect(puts[0]![1]).toMatchObject({
			_type: "featureGrid",
			set: "climbing",
			heading: "Find your way",
			wide: false,
		});
		expect(document.querySelector(".emdash-inline-ui-dialog")).toBeNull();
		await vi.waitFor(() =>
			expect(
				blockOf("featureGrid")
					?.querySelector(".emdash-plugin-block-content")
					?.shadowRoot?.querySelector("h2")?.textContent,
			).toBe("Find your way"),
		);
		expect(pageRequests).toBe(1);
		expect(blockOf("featureGrid")?.hasAttribute("data-redrawing")).toBe(false);
		// Saved once: leaving the editor afterwards finds nothing new to save.
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
		expect(puts).toHaveLength(1);
	});

	it("leaves the block as it was when its settings are closed", async () => {
		supplyPreview(tiles, "<h2>Start here</h2>");
		await mount([tiles]);

		await click(await settingsButton(blockOf("featureGrid")!));
		const form = await dialog();
		await act(async () => setValue(field<HTMLInputElement>(form, "Heading"), "Changed"));
		await click(withText(form, "Cancel"));

		expect(document.querySelector(".emdash-inline-ui-dialog")).toBeNull();
		expect(puts).toHaveLength(0);
		expect(pageRequests).toBe(0);
	});

	it("inserts one of the site's blocks from the slash menu", async () => {
		const editable = await mount([paragraph("p", "Intro.")]);
		const editor = (editable as HTMLElement & { editor?: TestEditor }).editor!;
		await vi.waitFor(() =>
			expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain("/_emdash/api/manifest"),
		);
		await act(async () => {
			editor.commands.focus();
			editor.commands.setTextSelection(editor.state.doc.content.size - 1);
			editor.commands.splitBlock();
			editor.commands.insertContent("/tiles");
		});
		await vi.waitFor(() =>
			expect(
				document.querySelector('.emdash-slash-menu [aria-current="true"]')?.textContent,
			).toContain("Tiles"),
		);
		await act(async () => {
			editable.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});

		const form = await dialog();
		expect(form.querySelector("h2")?.textContent).toBe("Insert Tiles");
		await act(async () => setValue(field<HTMLInputElement>(form, "Heading"), "New tiles"));
		await click(withText(form, "Insert"));

		await vi.waitFor(() => expect(puts).toHaveLength(1));
		expect(types(puts[0]!)).toEqual(["block", "featureGrid"]);
		expect(puts[0]![1]).toMatchObject({ heading: "New tiles", wide: false });
		expect(blockOf("featureGrid")?.querySelector(".emdash-plugin-block-slot")?.textContent).toBe(
			"TilesNew tiles",
		);
	});

	it("adds, moves and removes a repeater's rows, stored without row keys", async () => {
		const steps = { _type: "steps", _key: "k-steps", steps: [{ title: "Warm up" }] };
		await mount([steps]);

		await click(await settingsButton(blockOf("steps")!));
		const form = await dialog();
		await click(withText(form, "Add step"));
		await act(async () => setValue(field<HTMLInputElement>(form, "Title"), "Climb"));
		await click(form.querySelector<HTMLButtonElement>('[aria-label="Move item 2 up"]')!);
		expect(
			Array.from(form.querySelectorAll(".emdash-inline-ui-repeater-toggle"), (b) => b.textContent),
		).toEqual(["Climb", "Warm up"]);
		await click(withText(form, "Save"));

		await vi.waitFor(() => expect(puts).toHaveLength(1));
		expect(puts[0]![0]).toMatchObject({ steps: [{ title: "Climb" }, { title: "Warm up" }] });
		expect((puts[0]![0]!.steps as object[]).every((row) => !("_key" in row))).toBe(true);
	});

	it("moves a block and deletes it from its bar", async () => {
		const editable = await mount([paragraph("a", "First."), paragraph("b", "Second."), tiles]);
		// Named from the manifest.
		await settingsButton(blockOf("featureGrid")!);

		await click(barButton(blockOf("featureGrid")!, "Move Tiles up")!);
		const moved = await saved(editable);
		expect(types(moved)).toEqual(["block", "featureGrid", "block"]);

		puts.length = 0;
		await click(barButton(blockOf("featureGrid")!, "Delete Tiles")!);
		expect(blockOf("featureGrid")).toBeNull();
		expect((await saved(editable)).some((b) => b._type === "featureGrid")).toBe(false);
	});

	it("saves nothing when a body with previews is opened and left alone", async () => {
		supplyPreview(tiles, "<section>tiles</section>");
		await mount([paragraph("p", "Intro."), tiles]);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
		expect(puts).toHaveLength(0);
	});
});
