import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { apiFetch, fetchManifest, type AdminManifest } from "../../src/lib/api";
import { render } from "../utils/render";

vi.mock("../../src/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api")>();
	return { ...actual, apiFetch: vi.fn(), fetchManifest: vi.fn() };
});

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
		type: "test.hero",
		pluginId: "test-blocks",
		label: "Test Hero",
		fields: [
			{
				type: "text_input",
				action_id: "heading",
				label: "Heading",
			},
		],
	},
	{
		type: "test.cta",
		pluginId: "test-blocks",
		label: "Test CTA",
		fields: [{ type: "url_input", action_id: "href", label: "Button link" }],
	},
	{
		type: "test.cards",
		pluginId: "test-blocks",
		label: "Test Cards",
		fields: [
			{
				type: "text_input",
				action_id: "heading",
				label: "Heading",
			},
			{
				type: "repeater",
				action_id: "cards",
				label: "Cards",
				item_label: "card",
				fields: [{ type: "text_input", action_id: "title", label: "Title" }],
			},
		],
	},
];

async function openCardsBlockWithStoredString(
	onChange: NonNullable<PortableTextEditorProps["onChange"]>,
) {
	const screen = await render(
		<PortableTextEditor
			value={[
				{
					_type: "test.cards",
					_key: "cards-1",
					heading: "Before",
					cards: "First card\nSecond card",
				},
			]}
			onChange={onChange}
			pluginBlocks={pluginBlocks}
		/>,
	);
	await screen.getByRole("button", { name: "Edit" }).click();
	await expect.element(screen.getByRole("dialog")).toBeVisible();
	return screen;
}

function lastSavedCardsBlock(onChange: ReturnType<typeof vi.fn>) {
	const blocks = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
	return blocks?.find((block) => block._type === "test.cards");
}

describe("plugin block modal", () => {
	it("saves an edited block without submitting the surrounding content form", async () => {
		const onPageSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await render(
			<form onSubmit={onPageSubmit}>
				<PortableTextEditor
					value={[
						{
							_type: "test.hero",
							_key: "hero-1",
							heading: "Before",
						},
					]}
					onChange={onChange}
					pluginBlocks={pluginBlocks}
				/>
			</form>,
		);

		const editButton = screen.getByRole("button", { name: "Edit" });
		await expect.element(editButton).toBeVisible();
		await editButton.click();

		const heading = screen.getByRole("textbox");
		await expect.element(heading).toHaveValue("Before");
		await heading.fill("After");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		expect(onPageSubmit).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			const savedBlocks = onChange.mock.lastCall?.[0];
			expect(savedBlocks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						_type: "test.hero",
						heading: "After",
					}),
				]),
			);
		});
	});

	it("keeps a repeater's stored non-list value through an unrelated edit and save", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await openCardsBlockWithStoredString(onChange);

		await expect
			.element(screen.getByLabelText("Cards", { exact: true }))
			.toHaveValue("First card\nSecond card");
		await expect.element(screen.getByRole("alert")).toBeVisible();
		expect(screen.getByRole("button", { name: "Add card" }).query()).toBeNull();

		const heading = screen.getByRole("textbox").first();
		await expect.element(heading).toHaveValue("Before");
		await heading.fill("After");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(lastSavedCardsBlock(onChange)).toMatchObject({
				heading: "After",
				cards: "First card\nSecond card",
			});
		});
	});

	it("replaces a repeater's stored non-list value only through the replace action", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await openCardsBlockWithStoredString(onChange);

		screen.getByRole("button", { name: "Replace with empty list" }).element().click();

		await expect.element(screen.getByText("No items yet")).toBeVisible();
		expect(screen.getByRole("alert").query()).toBeNull();
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(lastSavedCardsBlock(onChange)).toMatchObject({ heading: "Before", cards: [] });
		});
	});

	describe("url_input", () => {
		async function editCtaBlock(onChange: NonNullable<PortableTextEditorProps["onChange"]>) {
			vi.mocked(fetchManifest).mockResolvedValue({
				collections: { news: { label: "News", urlPattern: "/news/{slug}" } },
			} as unknown as AdminManifest);
			vi.mocked(apiFetch).mockImplementation((input) => {
				const target =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const url = new URL(target, "http://localhost");
				const items =
					url.searchParams.get("status") === "draft"
						? []
						: [
								{
									collection: "news",
									id: "n1",
									slug: "recent-improvements",
									locale: "en",
									title: "Recent improvements",
								},
							];
				return Promise.resolve(Response.json({ data: { items } }));
			});
			const screen = await render(
				<PortableTextEditor
					value={[{ _type: "test.cta", _key: "cta-1", href: "/book" }]}
					onChange={onChange}
					pluginBlocks={pluginBlocks}
				/>,
			);
			await screen.getByRole("button", { name: "Edit" }).click();
			const field = screen.getByRole("combobox", { name: "Button link" });
			await expect.element(field).toHaveValue("/book");
			return { screen, field };
		}

		function savedHref(onChange: ReturnType<typeof vi.fn>) {
			const blocks = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
			return blocks?.find((block) => block._type === "test.cta")?.href;
		}

		it("stores the URL of an entry picked by its title", async () => {
			const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
			const { screen, field } = await editCtaBlock(onChange);

			await field.fill("recent");
			const option = screen.getByRole("option", { name: /Recent improvements/ });
			await expect.element(option).toBeVisible();
			(option.element() as HTMLElement).click();
			await expect.element(field).toHaveValue("/news/recent-improvements");
			expect(screen.getByRole("option").query()).toBeNull();

			screen.getByRole("button", { name: "Save", exact: true }).element().click();
			await vi.waitFor(() => expect(savedHref(onChange)).toBe("/news/recent-improvements"));
		});

		it("keeps a typed URL, giving a bare domain https when the field is left", async () => {
			const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
			const { screen, field } = await editCtaBlock(onChange);

			await field.fill("example.com/courses");
			(field.element() as HTMLInputElement).blur();
			await expect.element(field).toHaveValue("https://example.com/courses");

			screen.getByRole("button", { name: "Save", exact: true }).element().click();
			await vi.waitFor(() => expect(savedHref(onChange)).toBe("https://example.com/courses"));
		});

		// A click on Save blurs the field first; results vanishing then would move Save from under it.
		it("keeps search results showing when the field loses focus", async () => {
			const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
			const { screen, field } = await editCtaBlock(onChange);

			await field.fill("recent");
			const option = screen.getByRole("option", { name: /Recent improvements/ });
			await expect.element(option).toBeVisible();
			(field.element() as HTMLInputElement).blur();

			await expect.element(field).toHaveAttribute("aria-expanded", "true");
		});
	});
});
