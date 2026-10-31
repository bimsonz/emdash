/**
 * Adds a link to a plain text box in the visual editor's block dialog, as `[words](address)`. The
 * admin's block dialog has the same control with search (`TextLinkControl`); this one takes an
 * address, as the visual editor's rich text link box does.
 */

import { isAllowedUri } from "@tiptap/extension-link";
import * as React from "react";

import { normalizeLinkHref } from "./inline-bubble-menu.js";

export interface TextLink {
	start: number;
	end: number;
	words: string;
	href: string;
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** `[words](address)`, with what would end either part early taken out of it. */
function linkSource(words: string, href: string): string {
	const text = words.replace(/\]/g, "").replace(/\s*\n\s*/g, " ");
	const address = href.replace(/\)/g, "%29").replace(/\s/g, "%20");
	return `[${text}](${address})`;
}

/** The link holding the caret or the whole selection. A caret at either edge of a link is in it. */
export function linkAt(text: string, from: number, to: number): TextLink | undefined {
	for (const match of text.matchAll(LINK)) {
		const start = match.index;
		const end = start + match[0].length;
		if (from >= start && to <= end) return { start, end, words: match[1]!, href: match[2]! };
	}
	return undefined;
}

/** The text with `from` to `to` replaced by a link, and where the caret goes after it. */
export function insertLink(text: string, from: number, to: number, words: string, href: string) {
	const link = linkSource(words, href);
	return { text: text.slice(0, from) + link + text.slice(to), caret: from + link.length };
}

/** The text with a link back to its words. */
export function unlink(text: string, link: TextLink) {
	return {
		text: text.slice(0, link.start) + link.words + text.slice(link.end),
		caret: link.start + link.words.length,
	};
}

interface Draft {
	from: number;
	to: number;
	words: string;
	href: string;
	/** The link being changed, if there is one. */
	link?: TextLink;
}

export function TextLinkControl({
	box,
	value,
	onChange,
}: {
	box: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
	value: string;
	onChange: (value: string) => void;
}) {
	const [draft, setDraft] = React.useState<Draft | null>(null);
	const [invalid, setInvalid] = React.useState(false);
	const wordsId = React.useId();
	const hrefId = React.useId();
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
		setInvalid(false);
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
			<div className="emdash-inline-ui-text-link-actions">
				<button type="button" className="emdash-inline-ui-dialog-button" onClick={open}>
					Add link
				</button>
			</div>
		);
	}

	const canApply = draft.words.trim() !== "" && draft.href.trim() !== "";
	const apply = () => {
		if (!canApply) return;
		const href = normalizeLinkHref(draft.href);
		if (isAllowedUri(href))
			finish(insertLink(value, draft.from, draft.to, draft.words.trim(), href));
		else setInvalid(true);
	};
	const onEnter = (event: React.KeyboardEvent) => {
		if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
		event.preventDefault();
		apply();
	};

	return (
		<div className="emdash-inline-ui-text-link">
			<div className="emdash-inline-ui-field">
				<label htmlFor={wordsId}>Link text</label>
				<input
					id={wordsId}
					type="text"
					value={draft.words}
					onChange={(event) => setDraft({ ...draft, words: event.target.value })}
					onKeyDown={onEnter}
				/>
			</div>
			<div className="emdash-inline-ui-field">
				<label htmlFor={hrefId}>Link to</label>
				<input
					id={hrefId}
					type="text"
					inputMode="url"
					autoComplete="off"
					spellCheck={false}
					placeholder="Type or paste a URL"
					aria-invalid={invalid || undefined}
					value={draft.href}
					onChange={(event) => {
						setDraft({ ...draft, href: event.target.value });
						setInvalid(false);
					}}
					onKeyDown={onEnter}
				/>
				{invalid && <p role="alert">That address can't be used for a link.</p>}
			</div>
			<div className="emdash-inline-ui-text-link-actions">
				{draft.link && (
					<button
						type="button"
						className="emdash-inline-ui-dialog-button"
						onClick={() => finish(unlink(value, draft.link!))}
					>
						Remove link
					</button>
				)}
				<button
					type="button"
					className="emdash-inline-ui-dialog-button"
					onClick={() => setDraft(null)}
				>
					Cancel
				</button>
				<button
					type="button"
					className="emdash-inline-ui-dialog-button"
					data-primary=""
					disabled={!canApply}
					onClick={apply}
				>
					{draft.link ? "Update link" : "Insert link"}
				</button>
			</div>
		</div>
	);
}
