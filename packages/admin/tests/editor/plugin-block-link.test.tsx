/**
 * A plugin block opened from the page's visual editor: its "Edit block" link carries the block's
 * content key (`?block=`), and the content edit route dispatches EDIT_PLUGIN_BLOCK_EVENT on the
 * block with that key, which opens the block's settings as its Edit button would.
 */
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { EDIT_PLUGIN_BLOCK_EVENT } from "../../src/components/editor/PluginBlockNode";
import { PortableTextEditor, type PluginBlockDef } from "../../src/components/PortableTextEditor";
import { pluginBlockKey } from "../../src/plugin-block-key";

import "../../dist/styles.css";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

const tiles: PluginBlockDef = {
	type: "test.tiles",
	pluginId: "test-blocks",
	label: "Tiles",
	fields: [{ type: "text_input", action_id: "heading", label: "Heading" }],
};

describe("plugin block opened from the page's visual editor", () => {
	it("marks each block with its content key and opens the one an event names", async () => {
		const first = { _type: "test.tiles", _key: "a", heading: "First" };
		const second = { _type: "test.tiles", _key: "b", heading: "Second" };
		const screen = await render(
			<PortableTextEditor value={[first, second]} pluginBlocks={[tiles]} />,
		);

		const el = await vi.waitFor(
			() => {
				const found = document.querySelector(`[data-plugin-block-key="${pluginBlockKey(second)}"]`);
				expect(found).toBeTruthy();
				return found!;
			},
			{ timeout: 3000 },
		);
		expect(document.querySelectorAll("[data-plugin-block-key]")).toHaveLength(2);

		await React.act(async () => {
			el.dispatchEvent(new CustomEvent(EDIT_PLUGIN_BLOCK_EVENT));
		});
		await expect.element(screen.getByRole("dialog").getByRole("textbox")).toHaveValue("Second");
	});
});
