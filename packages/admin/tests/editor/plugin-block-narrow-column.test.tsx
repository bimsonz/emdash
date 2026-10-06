import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

const pluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.video",
		pluginId: "test-blocks",
		label: "Test Video",
		fields: [],
	},
];

/** The card's icon: the first item in the row that holds the label. */
async function iconInColumn(width: number): Promise<HTMLElement> {
	const screen = await render(
		<div style={{ width }}>
			<PortableTextEditor
				value={[{ _type: "test.video", _key: "video-1" }]}
				onChange={vi.fn()}
				pluginBlocks={pluginBlocks}
			/>
		</div>,
	);
	await expect.element(screen.getByText("Test Video")).toBeVisible();
	const row = screen.getByText("Test Video").element().closest(".flex-wrap");
	const icon = row?.firstElementChild;
	if (!(icon instanceof HTMLElement)) throw new Error("plugin block card has no icon");
	return icon;
}

describe("plugin block in a narrow column", () => {
	it("drops its icon in a 102px sidebar column, leaving the width to the label", async () => {
		const icon = await iconInColumn(102);
		expect(getComputedStyle(icon).display).toBe("none");
	});

	it("keeps its icon in a wide column", async () => {
		const icon = await iconInColumn(400);
		expect(getComputedStyle(icon).display).toBe("flex");
	});
});
