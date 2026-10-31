import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

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

/** Not on Block Kit's types: the admin reads it off the field. */
const linksOptIn = { links: true };

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
	{
		type: "test.linked",
		pluginId: "test-blocks",
		label: "Test Linked",
		fields: [
			{ type: "text_input", action_id: "intro", label: "Intro", multiline: true, ...linksOptIn },
			{ type: "text_input", action_id: "name", label: "Name" },
			{
				type: "repeater",
				action_id: "rows",
				label: "Rows",
				item_label: "row",
				fields: [{ type: "text_input", action_id: "note", label: "Note", ...linksOptIn }],
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

async function openLinkedBlock(onChange: NonNullable<PortableTextEditorProps["onChange"]>) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const screen = await render(
		<QueryClientProvider client={queryClient}>
			<PortableTextEditor
				value={[
					{
						_type: "test.linked",
						_key: "linked-1",
						intro: "Plan your journey",
						name: "A name",
						rows: [{ note: "Mind the step" }],
					},
				]}
				onChange={onChange}
				pluginBlocks={pluginBlocks}
			/>
		</QueryClientProvider>,
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
	it("offers a link on a text box that opts in, and only there", async () => {
		const screen = await openLinkedBlock(vi.fn());

		await expect.element(screen.getByLabelText("Name")).toBeVisible();
		screen.getByRole("button", { expanded: false }).element().click();
		await expect.element(screen.getByLabelText("Note")).toBeVisible();
		// The intro and the repeater row's note; not Name.
		expect(screen.getByRole("button", { name: "Add link" }).elements()).toHaveLength(2);
	});

	it("saves a link added to a text box as text in the field", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await openLinkedBlock(onChange);
		const intro = screen.getByLabelText("Intro").element() as HTMLTextAreaElement;
		intro.focus();
		intro.setSelectionRange(10, 17);

		screen.getByRole("button", { name: "Add link" }).first().element().click();
		await screen.getByLabelText("Link to").fill("/journey");
		screen.getByRole("button", { name: "Insert link" }).element().click();
		await expect
			.element(screen.getByLabelText("Intro"))
			.toHaveValue("Plan your [journey](/journey)");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(onChange.mock.lastCall?.[0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						_type: "test.linked",
						intro: "Plan your [journey](/journey)",
						name: "A name",
					}),
				]),
			);
		});
	});

	it("saves a link added to a text box in a repeater row", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await openLinkedBlock(onChange);
		screen.getByRole("button", { expanded: false }).element().click();
		await expect.element(screen.getByLabelText("Note")).toBeVisible();
		const note = screen.getByLabelText("Note").element() as HTMLInputElement;
		note.focus();
		note.setSelectionRange(9, 13);

		screen.getByRole("button", { name: "Add link" }).last().element().click();
		await screen.getByLabelText("Link to").fill("/access");
		screen.getByRole("button", { name: "Insert link" }).element().click();
		await expect.element(screen.getByLabelText("Note")).toHaveValue("Mind the [step](/access)");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(onChange.mock.lastCall?.[0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						_type: "test.linked",
						rows: [expect.objectContaining({ note: "Mind the [step](/access)" })],
					}),
				]),
			);
		});
	});

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
});
