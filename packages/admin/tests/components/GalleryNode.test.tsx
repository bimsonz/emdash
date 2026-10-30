import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { GalleryExtension } from "../../src/components/editor/GalleryNode";
import { render } from "../utils/render.tsx";

i18n.loadAndActivate({ locale: "en", messages: {} });

function Gallery({ caption }: { caption: string }) {
	const editor = useEditor({
		extensions: [StarterKit, GalleryExtension],
		content: {
			type: "doc",
			content: [
				{
					type: "gallery",
					attrs: {
						columns: 4,
						images: [1, 2, 3, 4].map((n) => ({
							_type: "image",
							_key: `image-${n}`,
							asset: { _ref: `media-${n}`, url: "/image.jpg", provider: "local" },
							alt: `Image ${n}`,
							caption,
						})),
					},
				},
			],
		},
	});
	return (
		<I18nProvider i18n={i18n}>
			{/* Tailwind's `grid` and `truncate`, which the test page doesn't load. */}
			<style>
				{`.grid { display: grid; }
				figure { margin: 0; }
				figcaption { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`}
			</style>
			<div data-testid="host" style={{ width: 600 }}>
				<EditorContent editor={editor} />
			</div>
		</I18nProvider>
	);
}

describe("GalleryNode", () => {
	it("keeps its columns inside the editor when a caption is long", async () => {
		const screen = await render(
			<Gallery caption="Duty Manager, Instructor, Safeguarding Lead, and a good deal more besides" />,
		);
		const thumbnail = screen.getByRole("button", { name: "Edit image 1" });
		await expect.element(thumbnail).toBeInTheDocument();

		const grid = thumbnail.element().closest("figure")!.parentElement!;
		expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
	});
});
