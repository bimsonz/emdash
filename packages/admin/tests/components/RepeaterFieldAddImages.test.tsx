import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepeaterField } from "../../src/components/RepeaterField";
import type { MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.tsx";

const apiMocks = vi.hoisted(() => ({ fetchMediaList: vi.fn() }));

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return {
		...actual,
		fetchMediaList: apiMocks.fetchMediaList,
		fetchMediaFolders: vi.fn().mockResolvedValue({ items: [] }),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
	};
});

function mediaItem(id: string, filename: string): MediaItem {
	return {
		id,
		filename,
		mimeType: "image/jpeg",
		url: `/_emdash/api/media/file/${filename}`,
		storageKey: filename,
		size: 1024,
		width: 800,
		height: 600,
		createdAt: "2026-10-31T00:00:00.000Z",
	};
}

/** A slide, as the image collection this was built for defines one. */
const slideFields = [
	{ slug: "image", type: "image", label: "Image" },
	{ slug: "alt_text", type: "string", label: "Alt text" },
	{ slug: "link", type: "url", label: "Link" },
	{ slug: "label", type: "string", label: "Label" },
];

async function renderSlides(props: Partial<React.ComponentProps<typeof RepeaterField>> = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onChange = vi.fn();
	const screen = await render(
		<QueryClientProvider client={queryClient}>
			<RepeaterField
				label="Slides"
				id="slides"
				value={[]}
				onChange={onChange}
				subFields={slideFields}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { screen, onChange };
}

type Screen = Awaited<ReturnType<typeof renderSlides>>["screen"];

async function pick(screen: Screen, filenames: string[]) {
	screen.getByRole("button", { name: "Add Images" }).first().element().click();
	for (const filename of filenames) {
		await expect.element(screen.getByText(filename, { exact: true }).first()).toBeInTheDocument();
		screen
			.getByRole("button", { name: new RegExp(filename.replace(".", "\\.")) })
			.first()
			.element()
			.click();
		await expect
			.element(screen.getByText(`${filenames.indexOf(filename) + 1} of`, { exact: false }).first())
			.toBeInTheDocument();
	}
	screen
		.getByRole("button", { name: /^Add \d+ images?$/ })
		.element()
		.click();
}

describe("RepeaterField Add Images", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		apiMocks.fetchMediaList.mockResolvedValue({
			items: [
				mediaItem("m1", "first.jpg"),
				mediaItem("m2", "second.jpg"),
				mediaItem("m3", "third.jpg"),
			],
			totalCount: 3,
		});
	});

	it("adds one row per picked image in the order they were picked, in a single change", async () => {
		const { screen, onChange } = await renderSlides();

		await pick(screen, ["second.jpg", "first.jpg", "third.jpg"]);

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(onChange).toHaveBeenCalledTimes(1);
		const rows = onChange.mock.calls[0]![0] as Array<{ image: { id: string } }>;
		expect(rows.map((row) => row.image.id)).toEqual(["m2", "m1", "m3"]);
	});

	it("stores each image as an image field does and leaves the row's other fields empty", async () => {
		const { screen, onChange } = await renderSlides();

		await pick(screen, ["first.jpg", "second.jpg"]);

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(onChange.mock.calls[0]![0]).toEqual([
			{
				image: expect.objectContaining({
					id: "m1",
					provider: "local",
					width: 800,
					height: 600,
					filename: "first.jpg",
					mimeType: "image/jpeg",
					meta: { storageKey: "first.jpg" },
				}),
				// `""` here is what made these rows unsaveable: a url sub-field must start empty as null.
				link: null,
				alt_text: "",
				label: "",
			},
			expect.objectContaining({ link: null, image: expect.objectContaining({ id: "m2" }) }),
		]);
	});

	it("adds after the rows already there", async () => {
		const existing = { image: null, alt_text: "kept", link: null, label: "" };
		const { screen, onChange } = await renderSlides({ value: [existing] });

		await pick(screen, ["first.jpg"]);

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		const rows = onChange.mock.calls[0]![0] as Array<{ alt_text: string; image: unknown }>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual(existing);
		expect(rows[1]!.image).toEqual(expect.objectContaining({ id: "m1" }));
	});

	it("stops at maxItems, keeping the first ones picked", async () => {
		const existing = { image: null, alt_text: "", link: null, label: "" };
		const { screen, onChange } = await renderSlides({ value: [existing], maxItems: 3 });

		await pick(screen, ["first.jpg", "second.jpg", "third.jpg"]);

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		const rows = onChange.mock.calls[0]![0] as Array<{ image: { id: string } | null }>;
		expect(rows.map((row) => row.image?.id ?? null)).toEqual([null, "m1", "m2"]);
	});

	it("gives rows added in one go different keys, so each stays editable", async () => {
		const { screen, onChange } = await renderSlides();

		await pick(screen, ["first.jpg", "second.jpg"]);

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		const alts = screen.getByRole("textbox", { name: "Alt text" });
		await expect.element(alts.nth(1)).toBeInTheDocument();
		await alts.nth(1).fill("the second one");

		const latest = onChange.mock.lastCall![0] as Array<{ alt_text: string }>;
		expect(latest.map((row) => row.alt_text)).toEqual(["", "the second one"]);
	});

	it("isn't offered once the repeater is full", async () => {
		const row = { image: null, alt_text: "", link: null, label: "" };
		const { screen } = await renderSlides({ value: [row], maxItems: 1 });

		await expect.element(screen.getByText("(1 item)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Images" }).elements()).toHaveLength(0);
	});

	it("isn't offered without an image sub-field", async () => {
		const { screen } = await renderSlides({
			subFields: [{ slug: "label", type: "string", label: "Label" }],
		});

		await expect.element(screen.getByText("No items yet")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Images" }).elements()).toHaveLength(0);
	});

	it("isn't offered when two image sub-fields leave it unclear which to fill", async () => {
		const { screen } = await renderSlides({
			subFields: [
				{ slug: "desktop", type: "image", label: "Desktop" },
				{ slug: "phone", type: "image", label: "Phone" },
			],
		});

		await expect.element(screen.getByText("No items yet")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Images" }).elements()).toHaveLength(0);
	});
});
