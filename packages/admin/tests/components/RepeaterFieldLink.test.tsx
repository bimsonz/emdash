import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepeaterField } from "../../src/components/RepeaterField";
import { apiFetch, fetchManifest, type AdminManifest } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api")>();
	return { ...actual, apiFetch: vi.fn(), fetchManifest: vi.fn() };
});

const manifest = {
	collections: {
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: [],
			hasSeo: false,
			urlPattern: "/{slug}",
			fields: {},
		},
	},
} as unknown as AdminManifest;

const subFields = [{ slug: "link", type: "url", label: "Link" }];

async function renderLink(value: unknown[]) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onChange = vi.fn();
	const screen = await render(
		<QueryClientProvider client={queryClient}>
			<RepeaterField
				label="Slides"
				id="slides"
				value={value}
				onChange={onChange}
				subFields={subFields}
			/>
		</QueryClientProvider>,
	);
	return { screen, onChange };
}

describe("RepeaterField url sub-field", () => {
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

	it("shows the link already stored", async () => {
		const { screen } = await renderLink([{ link: "/physio" }]);

		await expect.element(screen.getByLabelText("Link")).toHaveValue("/physio");
	});

	it("finds a page by its title and stores its path", async () => {
		const { screen, onChange } = await renderLink([{ link: null }]);

		await screen.getByLabelText("Link").fill("yoga");
		await screen.getByRole("option", { name: /Yoga/ }).click();

		await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith([{ link: "/yoga" }]));
	});

	it("gives a typed domain its https when the field is left", async () => {
		const { screen, onChange } = await renderLink([{ link: null }]);

		const input = screen.getByLabelText("Link");
		await input.fill("example.com");
		(input.element() as HTMLInputElement).blur();

		await vi.waitFor(() =>
			expect(onChange).toHaveBeenLastCalledWith([{ link: "https://example.com" }]),
		);
	});

	it("stores a cleared link as null, which an optional url saves and an empty string doesn't", async () => {
		const { screen, onChange } = await renderLink([{ link: "/physio" }]);

		await screen.getByLabelText("Link").fill("");

		expect(onChange).toHaveBeenLastCalledWith([{ link: null }]);
	});
});
