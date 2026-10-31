import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { TextLinkControl } from "../../src/components/editor/TextLinkControl";
import { apiFetch, fetchManifest, type AdminManifest } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api")>();
	return { ...actual, apiFetch: vi.fn(), fetchManifest: vi.fn() };
});

const manifest = {
	collections: { pages: { label: "Pages", labelSingular: "Page", urlPattern: "/{slug}" } },
} as unknown as AdminManifest;

const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());

function Harness({ initial, single }: { initial: string; single?: boolean }) {
	const [value, setValue] = React.useState(initial);
	const box = React.useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	const Tag = single ? "input" : "textarea";
	return (
		<form onSubmit={onSubmit}>
			<Tag
				ref={box}
				aria-label="Box"
				value={value}
				onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
					setValue(event.target.value)
				}
			/>
			<TextLinkControl box={box} value={value} onChange={setValue} />
			<output data-testid="stored">{value}</output>
			<button type="submit">Save</button>
		</form>
	);
}

async function renderBox(initial: string, single = false) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<Harness initial={initial} single={single} />
		</QueryClientProvider>,
	);
}

type Screen = Awaited<ReturnType<typeof renderBox>>;

function select(screen: Screen, from: number, to: number) {
	const box = screen.getByLabelText("Box").element() as HTMLTextAreaElement;
	box.focus();
	box.setSelectionRange(from, to);
}

describe("TextLinkControl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchManifest).mockResolvedValue(manifest);
		vi.mocked(apiFetch).mockImplementation(
			async (url) =>
				new Response(
					JSON.stringify({
						data: {
							items: (url as string).includes("status=draft")
								? []
								: [{ collection: "pages", id: "1", slug: "yoga", locale: null, title: "Yoga" }],
						},
					}),
				),
		);
	});

	it("links the selected words to a page found by its title", async () => {
		const screen = await renderBox("Book your yoga class");
		select(screen, 10, 14);

		await screen.getByRole("button", { name: "Add link" }).click();
		await expect.element(screen.getByLabelText("Link text")).toHaveValue("yoga");
		await screen.getByLabelText("Link to").fill("yoga");
		await screen.getByRole("option", { name: /Yoga/ }).click();
		await screen.getByRole("button", { name: "Insert link" }).click();

		await expect
			.element(screen.getByTestId("stored"))
			.toHaveTextContent("Book your [yoga](/yoga) class");
	});

	it("tidies a typed address", async () => {
		const screen = await renderBox("Plan a journey");
		select(screen, 7, 14);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link to").fill("journeyplanner.example");
		// A domain is searched too. Clicking away closes the results and moves the button under the click.
		await expect.element(screen.getByRole("option", { name: /Yoga/ })).toBeVisible();
		await screen.getByRole("button", { name: "Insert link" }).click();

		await expect
			.element(screen.getByTestId("stored"))
			.toHaveTextContent("Plan a [journey](https://journeyplanner.example)");
	});

	it("works in a single line box", async () => {
		const screen = await renderBox("Plan a journey", true);
		select(screen, 7, 14);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link to").fill("/journey");
		await screen.getByRole("button", { name: "Insert link" }).click();

		await expect
			.element(screen.getByTestId("stored"))
			.toHaveTextContent("Plan a [journey](/journey)");
	});

	it("adds to the end of a box that was never clicked into", async () => {
		const screen = await renderBox("See ");

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link text").fill("the map");
		await screen.getByLabelText("Link to").fill("/map");
		await screen.getByRole("button", { name: "Insert link" }).click();

		await expect.element(screen.getByTestId("stored")).toHaveTextContent("See [the map](/map)");
	});

	it("opens on the link at the caret and changes where it goes", async () => {
		const screen = await renderBox("See [the map](/map) here");
		select(screen, 8, 8);

		await screen.getByRole("button", { name: "Add link" }).click();
		await expect.element(screen.getByLabelText("Link text")).toHaveValue("the map");
		await expect.element(screen.getByLabelText("Link to")).toHaveValue("/map");
		await screen.getByLabelText("Link to").fill("/directions");
		await screen.getByRole("button", { name: "Update link" }).click();

		await expect
			.element(screen.getByTestId("stored"))
			.toHaveTextContent("See [the map](/directions) here");
	});

	it("takes a link off, leaving the words", async () => {
		const screen = await renderBox("See [the map](/map) here");
		select(screen, 8, 8);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByRole("button", { name: "Remove link" }).click();

		await expect.element(screen.getByTestId("stored")).toHaveTextContent("See the map here");
	});

	it("refuses an address that isn't safe, changing nothing", async () => {
		const screen = await renderBox("Click me");
		select(screen, 0, 8);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link to").fill("javascript:alert(1)");
		await screen.getByRole("button", { name: "Insert link" }).click();

		await expect.element(screen.getByRole("alert")).toBeInTheDocument();
		await expect.element(screen.getByTestId("stored")).toHaveTextContent("Click me");
	});

	it("needs both the words and an address", async () => {
		const screen = await renderBox("");

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link text").fill("the map");

		await expect.element(screen.getByRole("button", { name: "Insert link" })).toBeDisabled();
	});

	it("leaves the box alone on Cancel", async () => {
		const screen = await renderBox("Plan a journey");
		select(screen, 7, 14);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByRole("button", { name: "Cancel" }).click();

		await expect.element(screen.getByTestId("stored")).toHaveTextContent("Plan a journey");
		await expect.element(screen.getByRole("button", { name: "Add link" })).toBeInTheDocument();
	});

	it("inserts the link on Enter in the link text", async () => {
		const screen = await renderBox("Plan a journey");
		select(screen, 7, 14);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link to").fill("/journey");
		await screen.getByLabelText("Link text").click();
		await userEvent.keyboard("{Enter}");

		await expect
			.element(screen.getByTestId("stored"))
			.toHaveTextContent("Plan a [journey](/journey)");
	});

	it("doesn't save the whole block on Enter before there's an address", async () => {
		const screen = await renderBox("Plan a journey");
		select(screen, 7, 14);

		await screen.getByRole("button", { name: "Add link" }).click();
		await screen.getByLabelText("Link text").click();
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByLabelText("Link to")).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
