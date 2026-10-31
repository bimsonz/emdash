/**
 * Adds a link to a plain text box without typing `[words](address)`. It sits under the box and opens
 * on the selected words, or on the link at the caret, with the rich text editor's link control.
 */

import { Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Link as LinkIcon } from "@phosphor-icons/react";
import { isAllowedUri } from "@tiptap/extension-link";
import * as React from "react";

import { insertLink, linkAt, unlink, type TextLink } from "../../lib/text-links.js";
import { LinkDestinationField, normalizeLinkHref } from "./LinkDestinationInput.js";

interface Draft {
	from: number;
	to: number;
	words: string;
	href: string;
	/** The link being changed, if there is one. */
	link?: TextLink;
}

export interface TextLinkControlProps {
	box: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
	value: string;
	onChange: (value: string) => void;
}

export function TextLinkControl({ box, value, onChange }: TextLinkControlProps) {
	const { t } = useLingui();
	const [draft, setDraft] = React.useState<Draft | null>(null);
	const [refused, setRefused] = React.useState(false);
	// A box nobody has clicked into has no caret to go by, so a link goes at the end of it.
	const touched = React.useRef(false);

	React.useEffect(() => {
		const element = box.current;
		const onFocus = () => {
			touched.current = true;
		};
		element?.addEventListener("focus", onFocus);
		return () => element?.removeEventListener("focus", onFocus);
	}, [box]);

	const open = () => {
		const from = touched.current ? (box.current?.selectionStart ?? value.length) : value.length;
		const to = touched.current ? (box.current?.selectionEnd ?? value.length) : value.length;
		const link = linkAt(value, from, to);
		setRefused(false);
		setDraft(
			link
				? { from: link.start, to: link.end, words: link.words, href: link.href, link }
				: { from, to, words: value.slice(from, to), href: "" },
		);
	};

	const finish = (next: { text: string; caret: number }) => {
		onChange(next.text);
		setDraft(null);
		requestAnimationFrame(() => {
			box.current?.focus();
			box.current?.setSelectionRange(next.caret, next.caret);
		});
	};

	if (!draft) {
		return (
			<div className="mt-1.5 flex justify-end">
				<Button type="button" variant="ghost" size="sm" icon={<LinkIcon />} onClick={open}>
					{t`Add link`}
				</Button>
			</div>
		);
	}

	const canApply = draft.words.trim() !== "" && draft.href.trim() !== "";
	const apply = () => {
		if (!canApply) return;
		const href = normalizeLinkHref(draft.href);
		if (isAllowedUri(href))
			finish(insertLink(value, draft.from, draft.to, draft.words.trim(), href));
		else setRefused(true);
	};

	return (
		<div className="mt-2 space-y-2 rounded-md border border-kumo-line p-3">
			<Input
				label={t`Link text`}
				value={draft.words}
				onChange={(event) => setDraft({ ...draft, words: event.target.value })}
				onKeyDown={(event) => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					apply();
				}}
			/>
			<LinkDestinationField
				label={t`Link to`}
				value={draft.href}
				refused={refused}
				onChange={(href) => {
					setRefused(false);
					setDraft({ ...draft, href });
				}}
			/>
			{/* Leaving the link field closes its results, which would pull a button out from under the click. */}
			<div className="flex items-center gap-2" onMouseDown={(event) => event.preventDefault()}>
				<Button type="button" size="sm" disabled={!canApply} onClick={apply}>
					{draft.link ? t`Update link` : t`Insert link`}
				</Button>
				{draft.link && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => finish(unlink(value, draft.link!))}
					>
						{t`Remove link`}
					</Button>
				)}
				<Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
					{t`Cancel`}
				</Button>
			</div>
		</div>
	);
}
