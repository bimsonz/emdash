/**
 * A plugin block's settings, edited on the page: the admin's Block Kit form, with the same fields,
 * defaults and stored values, drawn with plain CSS in the inline editor's UI root. The blocks and
 * their fields come from the admin manifest, as the admin's do.
 */

import type { Element, RepeaterSubField } from "@emdash-cms/blocks";
import {
	FloatingFocusManager,
	FloatingOverlay,
	FloatingPortal,
	useDismiss,
	useFloating,
	useInteractions,
	useRole,
} from "@floating-ui/react";
import { ArrowDown, ArrowUp, CaretRight, Plus, Trash, X } from "@phosphor-icons/react";
import * as React from "react";

import { normalizeLinkHref } from "./inline-bubble-menu.js";
import { InlineMediaPicker } from "./inline-media-picker.js";

/** A plugin block type, as the admin manifest declares it. */
export interface BlockDefinition {
	type: string;
	pluginId: string;
	label: string;
	description?: string;
	placeholder?: string;
	category?: string;
	/** Block Kit fields. A block that declares none, not even an empty list, is a URL embed. */
	fields?: Element[];
}

type Values = Record<string, unknown>;
type Change = (actionId: string, value: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isElement(value: unknown): value is Element {
	return isRecord(value) && typeof value.type === "string" && typeof value.action_id === "string";
}

/** The plugin blocks the admin offers, by type, from its manifest. */
export async function loadBlockDefinitions(
	signal?: AbortSignal,
): Promise<Map<string, BlockDefinition>> {
	const definitions = new Map<string, BlockDefinition>();
	const res = await fetch("/_emdash/api/manifest", {
		credentials: "same-origin",
		headers: { "X-EmDash-Request": "1" },
		signal,
	});
	if (!res.ok) return definitions;
	const body: unknown = await res.json();
	const plugins = isRecord(body) && isRecord(body.data) ? body.data.plugins : undefined;
	if (!isRecord(plugins)) return definitions;
	for (const [pluginId, plugin] of Object.entries(plugins)) {
		if (!isRecord(plugin) || !Array.isArray(plugin.portableTextBlocks)) continue;
		for (const block of plugin.portableTextBlocks) {
			if (!isRecord(block) || typeof block.type !== "string" || typeof block.label !== "string") {
				continue;
			}
			definitions.set(block.type, {
				type: block.type,
				pluginId,
				label: block.label,
				description: optionalString(block.description),
				placeholder: optionalString(block.placeholder),
				category: optionalString(block.category),
				fields: Array.isArray(block.fields) ? block.fields.filter(isElement) : undefined,
			});
		}
	}
	return definitions;
}

/** What the form starts from: each field's initial value, under what the block stores. */
export function blockFormValues(definition: BlockDefinition, stored: Values = {}): Values {
	const values: Values = {};
	for (const field of definition.fields ?? []) {
		const initial = "initial_value" in field ? field.initial_value : undefined;
		if (initial !== undefined) values[field.action_id] = initial;
	}
	return { ...values, ...stored };
}

/** The dialog that inserts a block or edits one's settings. */
export function InlineBlockSettings({
	uiRoot,
	definition,
	values: initialValues,
	inserting,
	onSubmit,
	onClose,
}: {
	uiRoot: HTMLElement;
	definition: BlockDefinition;
	values: Values;
	/** A new block, which the form inserts, rather than one on the page. */
	inserting: boolean;
	onSubmit: (values: Values) => void;
	onClose: () => void;
}) {
	const [values, setValues] = React.useState(initialValues);
	// Where an image field's picker opens: inside the dialog, so focus stays in it.
	const [layer, setLayer] = React.useState<HTMLElement | null>(null);
	const titleId = React.useId();
	const { refs, context } = useFloating({
		open: true,
		onOpenChange: (open) => {
			if (!open) onClose();
		},
	});
	const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context)]);

	// The picker closes on Escape itself; the dialog under it stays.
	React.useEffect(() => {
		if (!layer) return;
		const keepEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") event.stopPropagation();
		};
		layer.addEventListener("keydown", keepEscape);
		return () => layer.removeEventListener("keydown", keepEscape);
	}, [layer]);

	const change = React.useCallback<Change>((actionId, value) => {
		setValues((prev) => ({ ...prev, [actionId]: value }));
	}, []);

	const fields = definition.fields;
	const url = typeof values.id === "string" ? values.id.trim() : "";
	// Block Kit fields have no required flag, so any form is a block. A URL embed's URL is the block.
	const canSubmit = fields !== undefined || url.length > 0;

	return (
		<FloatingPortal root={uiRoot}>
			<FloatingOverlay className="emdash-inline-ui-dialog-backdrop" lockScroll>
				<FloatingFocusManager context={context} initialFocus={1}>
					<div
						ref={refs.setFloating}
						className="emdash-inline-ui-dialog"
						aria-labelledby={titleId}
						{...getFloatingProps()}
					>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (canSubmit) onSubmit(fields ? values : { ...values, id: url });
							}}
						>
							<div className="emdash-inline-ui-dialog-head">
								<h2 id={titleId}>
									{inserting ? `Insert ${definition.label}` : `Edit ${definition.label}`}
								</h2>
								<button
									type="button"
									className="emdash-inline-ui-dialog-close"
									aria-label="Close"
									onClick={onClose}
								>
									<X aria-hidden="true" />
								</button>
							</div>
							<div className="emdash-inline-ui-dialog-body">
								{fields ? (
									fields.map((field) => (
										<BlockField
											key={field.action_id}
											field={field}
											pluginId={definition.pluginId}
											value={values[field.action_id]}
											onChange={change}
											layer={layer}
										/>
									))
								) : (
									<TextField
										field={{
											type: "text_input",
											action_id: "id",
											label: "URL",
											placeholder: definition.placeholder ?? "Enter URL...",
										}}
										value={values.id}
										onChange={change}
									/>
								)}
							</div>
							<div className="emdash-inline-ui-dialog-foot">
								<button type="button" className="emdash-inline-ui-dialog-button" onClick={onClose}>
									Cancel
								</button>
								<button
									type="submit"
									className="emdash-inline-ui-dialog-button"
									data-primary=""
									disabled={!canSubmit}
								>
									{inserting ? "Insert" : "Save"}
								</button>
							</div>
						</form>
						<div ref={setLayer} />
					</div>
				</FloatingFocusManager>
			</FloatingOverlay>
		</FloatingPortal>
	);
}

/** One Block Kit field, as the admin's form draws each kind. */
function BlockField({
	field,
	pluginId,
	value,
	onChange,
	layer,
}: {
	field: Element;
	pluginId: string;
	value: unknown;
	onChange: Change;
	layer: HTMLElement | null;
}) {
	switch (field.type) {
		case "text_input":
		case "number_input":
		case "select":
		case "toggle":
			return <ScalarField field={field} pluginId={pluginId} value={value} onChange={onChange} />;
		case "url_input":
			return <UrlField field={field} value={value} onChange={onChange} />;
		case "repeater":
			return <RepeaterField field={field} pluginId={pluginId} value={value} onChange={onChange} />;
		case "media_picker":
			return <MediaField field={field} value={value} onChange={onChange} layer={layer} />;
		default:
			return <p className="emdash-inline-ui-field-note">Unknown field type: {field.type}</p>;
	}
}

/** The kinds of field a repeater's rows hold, which the block's own fields share. */
function ScalarField({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: RepeaterSubField;
	pluginId: string;
	value: unknown;
	onChange: Change;
}) {
	switch (field.type) {
		case "text_input":
			return <TextField field={field} value={value} onChange={onChange} />;
		case "number_input":
			return <NumberField field={field} value={value} onChange={onChange} />;
		case "select":
			return <SelectField field={field} pluginId={pluginId} value={value} onChange={onChange} />;
		case "toggle":
			return <ToggleField field={field} value={value} onChange={onChange} />;
	}
}

function TextField({
	field,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "text_input" }>;
	value: unknown;
	onChange: Change;
}) {
	const id = React.useId();
	const text = typeof value === "string" ? value : "";
	return (
		<div className="emdash-inline-ui-field">
			<label htmlFor={id}>{field.label}</label>
			{field.multiline ? (
				<textarea
					id={id}
					rows={3}
					placeholder={field.placeholder}
					value={text}
					onChange={(event) => onChange(field.action_id, event.target.value)}
				/>
			) : (
				<input
					id={id}
					type="text"
					placeholder={field.placeholder}
					value={text}
					onChange={(event) => onChange(field.action_id, event.target.value)}
				/>
			)}
		</div>
	);
}

/** A link destination, tidied when the field loses focus as the editor's own link field reads it. */
function UrlField({
	field,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "url_input" }>;
	value: unknown;
	onChange: Change;
}) {
	const id = React.useId();
	const text = typeof value === "string" ? value : "";
	return (
		<div className="emdash-inline-ui-field">
			<label htmlFor={id}>{field.label}</label>
			<input
				id={id}
				type="text"
				inputMode="url"
				autoComplete="off"
				spellCheck={false}
				dir="ltr"
				placeholder={field.placeholder ?? "Type or paste a URL"}
				value={text}
				onChange={(event) => onChange(field.action_id, event.target.value)}
				onBlur={() => {
					const href = normalizeLinkHref(text);
					if (href !== text) onChange(field.action_id, href);
				}}
			/>
		</div>
	);
}

function NumberField({
	field,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "number_input" }>;
	value: unknown;
	onChange: Change;
}) {
	const id = React.useId();
	return (
		<div className="emdash-inline-ui-field">
			<label htmlFor={id}>{field.label}</label>
			<input
				id={id}
				type="number"
				min={field.min}
				max={field.max}
				value={typeof value === "number" ? String(value) : ""}
				onChange={(event) =>
					onChange(field.action_id, event.target.value ? Number(event.target.value) : undefined)
				}
			/>
		</div>
	);
}

interface Option {
	label: string;
	value: string;
}

/** A select, whose options a plugin route may supply (`optionsRoute`) in place of its own. */
function SelectField({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "select" }>;
	pluginId: string;
	value: unknown;
	onChange: Change;
}) {
	const id = React.useId();
	const route = field.optionsRoute;
	const [loaded, setLoaded] = React.useState<Option[] | null>(null);
	const [loading, setLoading] = React.useState(!!route);

	React.useEffect(() => {
		if (!route) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const res = await fetch(`/_emdash/api/plugins/${pluginId}/${route}`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					body: JSON.stringify({}),
					signal: controller.signal,
				});
				if (!res.ok) return;
				const body: unknown = await res.json();
				const items = isRecord(body) && isRecord(body.data) ? body.data.items : undefined;
				if (!Array.isArray(items)) return;
				setLoaded(
					items.flatMap((item) =>
						isRecord(item) && typeof item.id === "string" && typeof item.name === "string"
							? [{ label: item.name, value: item.id }]
							: [],
					),
				);
			} catch {
				// Unreachable or aborted: the field's own options stand.
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [route, pluginId]);

	const options = loaded ?? field.options ?? [];
	const current = typeof value === "string" ? value : "";
	return (
		<div className="emdash-inline-ui-field">
			<label htmlFor={id}>{field.label}</label>
			<select
				id={id}
				value={current}
				disabled={loading}
				onChange={(event) => onChange(field.action_id, event.target.value)}
			>
				<option value="">{loading ? "Loading..." : "Select..."}</option>
				{/* A stored value the options no longer list stays chosen until it is changed. */}
				{current && !options.some((option) => option.value === current) && (
					<option value={current}>{current}</option>
				)}
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}

function ToggleField({
	field,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "toggle" }>;
	value: unknown;
	onChange: Change;
}) {
	const descriptionId = React.useId();
	return (
		<div className="emdash-inline-ui-field">
			<label className="emdash-inline-ui-switch">
				<input
					type="checkbox"
					role="switch"
					checked={!!value}
					aria-describedby={field.description ? descriptionId : undefined}
					onChange={(event) => onChange(field.action_id, event.target.checked)}
				/>
				<span>{field.label}</span>
			</label>
			{field.description && (
				<p id={descriptionId} className="emdash-inline-ui-field-note">
					{field.description}
				</p>
			)}
		</div>
	);
}

/** A list of rows of fields, added, removed and moved as in the admin; stored without row keys. */
function RepeaterField({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "repeater" }>;
	pluginId: string;
	value: unknown;
	onChange: Change;
}) {
	const labelId = React.useId();
	const items = Array.isArray(value) ? value.map((item) => (isRecord(item) ? item : {})) : [];
	// Each row keeps its identity as rows move, so an open row stays open.
	const counter = React.useRef(0);
	const newRowId = () => `row-${counter.current++}`;
	const rowIds = React.useRef<string[]>([]);
	while (rowIds.current.length < items.length) rowIds.current.push(newRowId());
	rowIds.current.length = items.length;
	const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());

	const canAdd = field.max_items === undefined || items.length < field.max_items;
	const canRemove = items.length > (field.min_items ?? 0);
	const itemLabel = field.item_label ?? "item";

	const emit = (next: Values[], ids: string[]) => {
		rowIds.current = ids;
		onChange(field.action_id, next);
	};
	const add = () => {
		const row: Values = {};
		for (const sub of field.fields) {
			row[sub.action_id] =
				sub.type === "toggle" ? false : sub.type === "number_input" ? undefined : "";
		}
		const id = newRowId();
		setOpen((prev) => new Set(prev).add(id));
		emit([...items, row], [...rowIds.current, id]);
	};
	const remove = (index: number) => {
		emit(
			items.filter((_, i) => i !== index),
			rowIds.current.filter((_, i) => i !== index),
		);
	};
	const move = (index: number, by: -1 | 1) => {
		const to = index + by;
		if (to < 0 || to >= items.length) return;
		const next = [...items];
		const ids = [...rowIds.current];
		[next[index], next[to]] = [next[to]!, next[index]!];
		[ids[index], ids[to]] = [ids[to]!, ids[index]!];
		emit(next, ids);
	};
	const toggle = (id: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const summaryField = field.fields.find((sub) => sub.type === "text_input");
	return (
		<div className="emdash-inline-ui-field" role="group" aria-labelledby={labelId}>
			<div className="emdash-inline-ui-repeater-head">
				<span id={labelId}>
					{field.label}
					{items.length > 0 && <span className="emdash-inline-ui-count"> ({items.length})</span>}
				</span>
				{canAdd && (
					<button type="button" className="emdash-inline-ui-dialog-button" onClick={add}>
						<Plus aria-hidden="true" />
						Add {itemLabel}
					</button>
				)}
			</div>
			{items.length === 0 ? (
				<p className="emdash-inline-ui-field-note">No items yet</p>
			) : (
				<ol className="emdash-inline-ui-repeater">
					{items.map((item, index) => {
						const id = rowIds.current[index]!;
						const isOpen = open.has(id);
						const named = summaryField ? item[summaryField.action_id] : undefined;
						const summary = typeof named === "string" && named.trim() ? named : `Item ${index + 1}`;
						const change: Change = (subId, subValue) =>
							emit(
								items.map((row, i) => (i === index ? { ...row, [subId]: subValue } : row)),
								rowIds.current,
							);
						return (
							<li key={id} className="emdash-inline-ui-repeater-row">
								<div className="emdash-inline-ui-repeater-row-head">
									<button
										type="button"
										className="emdash-inline-ui-repeater-toggle"
										aria-expanded={isOpen}
										onClick={() => toggle(id)}
									>
										<CaretRight aria-hidden="true" />
										<span>{summary}</span>
									</button>
									<button
										type="button"
										className="emdash-inline-ui-icon-button"
										aria-label={`Move item ${index + 1} up`}
										disabled={index === 0}
										onClick={() => move(index, -1)}
									>
										<ArrowUp aria-hidden="true" />
									</button>
									<button
										type="button"
										className="emdash-inline-ui-icon-button"
										aria-label={`Move item ${index + 1} down`}
										disabled={index === items.length - 1}
										onClick={() => move(index, 1)}
									>
										<ArrowDown aria-hidden="true" />
									</button>
									{canRemove && (
										<button
											type="button"
											className="emdash-inline-ui-icon-button"
											data-danger=""
											aria-label={`Remove item ${index + 1}`}
											onClick={() => remove(index)}
										>
											<Trash aria-hidden="true" />
										</button>
									)}
								</div>
								{isOpen && (
									<div className="emdash-inline-ui-repeater-fields">
										{field.fields.map((sub) => (
											<ScalarField
												key={sub.action_id}
												field={sub}
												pluginId={pluginId}
												value={item[sub.action_id]}
												onChange={change}
											/>
										))}
									</div>
								)}
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}

/** An image from the media library, stored as its URL, as the admin's media field stores it. */
function MediaField({
	field,
	value,
	onChange,
	layer,
}: {
	field: Extract<Element, { type: "media_picker" }>;
	value: unknown;
	onChange: Change;
	layer: HTMLElement | null;
}) {
	const labelId = React.useId();
	const [button, setButton] = React.useState<HTMLButtonElement | null>(null);
	const [picking, setPicking] = React.useState(false);
	const url = typeof value === "string" ? value : "";
	return (
		<div className="emdash-inline-ui-field" role="group" aria-labelledby={labelId}>
			<span id={labelId}>{field.label}</span>
			{url && isPreviewable(url) && (
				<img className="emdash-inline-ui-field-image" src={url} alt="" />
			)}
			<div className="emdash-inline-ui-field-row">
				<button
					ref={setButton}
					type="button"
					className="emdash-inline-ui-dialog-button"
					onClick={() => setPicking(true)}
				>
					{url ? "Replace image" : (field.placeholder ?? "Choose image")}
				</button>
				{url && (
					<button
						type="button"
						className="emdash-inline-ui-dialog-button"
						onClick={() => onChange(field.action_id, "")}
					>
						Remove
					</button>
				)}
			</div>
			{picking && layer && button && (
				<InlineMediaPicker
					uiRoot={layer}
					reference={button}
					gap={6}
					label={field.label}
					onChoose={(image) => {
						onChange(field.action_id, image.src);
						setPicking(false);
						button.focus();
					}}
					onClose={(reason) => {
						setPicking(false);
						if (reason !== "blur") button.focus();
					}}
				/>
			)}
		</div>
	);
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const HTTP = /^https?:/i;

/** A URL an `<img>` may load: a same-site path, or http(s). */
function isPreviewable(url: string): boolean {
	if (SCHEME.test(url)) return HTTP.test(url);
	return url.startsWith("/") && !url.startsWith("//");
}

export const INLINE_BLOCK_SETTINGS_STYLES = `
	.emdash-inline-ui-dialog-backdrop {
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.4);
	}
	.emdash-inline-ui-dialog {
		display: flex;
		width: 560px;
		max-width: 100%;
		max-height: calc(100dvh - 32px);
		flex-direction: column;
		border-radius: 12px;
		background: var(--emdash-ui-surface);
		box-shadow: 0 0 0 1px var(--emdash-ui-line), var(--emdash-ui-shadow);
		outline: none;
		animation: emdash-inline-ui-menu-in 120ms cubic-bezier(0, 0, 0.2, 1);
	}
	.emdash-inline-ui-dialog > form {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}
	.emdash-inline-ui-dialog-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 20px 20px 12px;
	}
	.emdash-inline-ui-dialog-head h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		line-height: 24px;
	}
	.emdash-inline-ui-dialog-close,
	.emdash-inline-ui-icon-button {
		display: inline-grid;
		width: 32px;
		height: 32px;
		place-items: center;
		flex: none;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		cursor: pointer;
		outline: none;
	}
	.emdash-inline-ui-dialog-close:hover,
	.emdash-inline-ui-icon-button:hover:not(:disabled) {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-icon-button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.emdash-inline-ui-icon-button[data-danger] {
		color: var(--emdash-ui-danger);
	}
	.emdash-inline-ui-dialog-close svg,
	.emdash-inline-ui-icon-button svg {
		width: 16px;
		height: 16px;
	}
	.emdash-inline-ui-dialog-body {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 16px;
		padding: 4px 20px 16px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.emdash-inline-ui-dialog-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 20px 20px;
		border-block-start: 1px solid var(--emdash-ui-hairline);
	}
	.emdash-inline-ui-dialog-button {
		display: inline-flex;
		height: 32px;
		align-items: center;
		gap: 6px;
		padding: 0 12px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
		font-weight: 500;
		cursor: pointer;
		outline: none;
		white-space: nowrap;
	}
	.emdash-inline-ui-dialog-button:hover:not(:disabled) {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-dialog-button[data-primary] {
		background: var(--emdash-ui-brand);
		box-shadow: none;
		color: #fff;
	}
	.emdash-inline-ui-dialog-button[data-primary]:hover:not(:disabled) {
		background: var(--emdash-ui-brand);
		filter: brightness(1.1);
	}
	.emdash-inline-ui-dialog-button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.emdash-inline-ui-dialog-button svg {
		width: 14px;
		height: 14px;
	}
	.emdash-inline-ui-dialog :is(button, input, select, textarea):focus-visible {
		box-shadow: 0 0 0 2px var(--emdash-ui-brand);
	}
	.emdash-inline-ui-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.emdash-inline-ui-field > label,
	.emdash-inline-ui-field > span,
	.emdash-inline-ui-repeater-head > span {
		font-weight: 500;
	}
	.emdash-inline-ui-field :is(input:not([type="checkbox"]), select, textarea) {
		width: 100%;
		margin: 0;
		padding: 6px 10px;
		border: 0;
		border-radius: 6px;
		background: var(--emdash-ui-raised);
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
		color: var(--emdash-ui-text);
		font: inherit;
		outline: none;
	}
	.emdash-inline-ui-field :is(input:not([type="checkbox"]), select) {
		height: 36px;
	}
	.emdash-inline-ui-field textarea {
		min-height: 80px;
		resize: vertical;
	}
	.emdash-inline-ui-field ::placeholder {
		color: var(--emdash-ui-placeholder);
	}
	.emdash-inline-ui-field-note {
		margin: 0;
		color: var(--emdash-ui-subtle);
	}
	.emdash-inline-ui-field-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.emdash-inline-ui-field-image {
		display: block;
		max-width: 100%;
		max-height: 160px;
		border-radius: 6px;
		object-fit: contain;
		align-self: flex-start;
	}
	.emdash-inline-ui-switch {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-weight: 500;
		cursor: pointer;
	}
	.emdash-inline-ui-switch input {
		width: 36px;
		height: 20px;
		flex: none;
		margin: 0;
		border-radius: 999px;
		background: var(--emdash-ui-fill);
		appearance: none;
		cursor: pointer;
		outline: none;
		transition: background 120ms;
	}
	.emdash-inline-ui-switch input::before {
		display: block;
		width: 16px;
		height: 16px;
		margin: 2px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
		content: "";
		transition: translate 120ms;
	}
	.emdash-inline-ui-switch input:checked {
		background: var(--emdash-ui-brand);
	}
	.emdash-inline-ui-switch input:checked::before {
		translate: 16px 0;
	}
	.emdash-inline-ui-switch input:checked:dir(rtl)::before {
		translate: -16px 0;
	}
	.emdash-inline-ui-repeater-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.emdash-inline-ui-count {
		color: var(--emdash-ui-subtle);
		font-weight: 400;
	}
	.emdash-inline-ui-repeater {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.emdash-inline-ui-repeater-row {
		border-radius: 8px;
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
	}
	.emdash-inline-ui-repeater-row-head {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px;
	}
	.emdash-inline-ui-repeater-toggle {
		display: flex;
		min-width: 0;
		height: 32px;
		flex: 1;
		align-items: center;
		gap: 6px;
		padding: 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		cursor: pointer;
		outline: none;
		text-align: start;
	}
	.emdash-inline-ui-repeater-toggle:hover {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-repeater-toggle span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-inline-ui-repeater-toggle svg {
		width: 14px;
		height: 14px;
		color: var(--emdash-ui-subtle);
		transition: rotate 120ms;
	}
	.emdash-inline-ui-repeater-toggle:dir(rtl) svg {
		rotate: 180deg;
	}
	.emdash-inline-ui-repeater-toggle[aria-expanded="true"] svg {
		rotate: 90deg;
	}
	.emdash-inline-ui-repeater-fields {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 8px 12px 12px;
		border-block-start: 1px solid var(--emdash-ui-hairline);
	}
	@media (prefers-reduced-motion: reduce) {
		.emdash-inline-ui-dialog {
			animation: none;
		}
	}
`;
