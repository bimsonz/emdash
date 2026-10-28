import { Input } from "@cloudflare/kumo";
import { useCallback } from "react";

import type { BlockInteraction, UrlInputElement } from "../types.js";

export function UrlInputElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: UrlInputElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (onChange) {
				onChange(element.action_id, e.target.value);
			}
		},
		[onChange, element.action_id],
	);

	const handleBlur = useCallback(
		(e: React.FocusEvent<HTMLInputElement>) => {
			if (!onChange) {
				onAction({
					type: "block_action",
					action_id: element.action_id,
					value: e.target.value,
				});
			}
		},
		[onChange, onAction, element.action_id],
	);

	// `type="url"` would refuse the site-relative paths this element accepts.
	return (
		<Input
			label={element.label}
			type="text"
			inputMode="url"
			autoComplete="off"
			spellCheck={false}
			dir="ltr"
			placeholder={element.placeholder}
			defaultValue={element.initial_value}
			onChange={handleChange}
			onBlur={handleBlur}
		/>
	);
}
