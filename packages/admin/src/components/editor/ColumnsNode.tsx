/**
 * Node views for the columns block. A columns block is edited as a map of its
 * layout: one box per column, at its relative width, saying what the column
 * holds. Columns are too narrow to write in side by side, so a column's blocks
 * show only while it is open, below the map at the editor's full width.
 *
 * The open column is the one holding the selection, so the keyboard, undo and
 * search open the column they move into. It is kept in a plugin rather than
 * the document, so it never reaches a revision.
 */

import { Button, Popover, Select, Switch, Tooltip } from "@cloudflare/kumo";
import { Menu } from "@cloudflare/kumo/primitives/menu";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	ArrowRight,
	ArrowsHorizontal,
	DotsThree,
	GearSix,
	Plus,
	Trash,
	type Icon,
	type IconProps,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
	NodeViewContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditorState,
	type NodeViewProps,
} from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { MAX_EDITOR_COLUMNS } from "../../portable-text-columns.js";
import { blockLabel } from "./blockTypes.js";
import {
	addColumn,
	deleteColumn,
	moveColumn,
	setColumnSpan,
	setColumnsLayout,
} from "./columnsCommands.js";
import { ColumnBlock, ColumnsBlock } from "./ColumnsExtension";
import {
	EditorMenuItem,
	EditorMenuRadioItem,
	EditorMenuSeparator,
	EditorSubmenu,
	editorMenuPopupClassName,
	tabToEditor,
} from "./EditorMenu.js";
import { getEmbedMeta, getRegistry } from "./PluginBlockNode.js";

/**
 * The positions of the open columns, outermost first. Positions rather than
 * keys: keys are only unique among a column's siblings, so a duplicated
 * columns block would open in both places.
 */
export const openColumnsKey = new PluginKey<readonly number[]>("emdashOpenColumns");

/** The columns holding the selection, outermost first. */
function columnsAroundSelection({ selection }: EditorState): number[] {
	const { $head } = selection;
	const open: number[] = [];
	for (let depth = 1; depth <= $head.depth; depth++) {
		if ($head.node(depth).type.name === "column") open.push($head.before(depth));
	}
	return open;
}

/** The end of the content of the column at `index` in the columns block at `pos`. */
function columnContentEnd(doc: ProseMirrorNode, pos: number, index: number): number | null {
	const columns = doc.nodeAt(pos);
	if (columns?.type.name !== "columns" || index >= columns.childCount) return null;
	let end = pos + 1;
	for (let i = 0; i <= index; i++) end += columns.child(i).nodeSize;
	return end - 1;
}

/**
 * Opens the column the selection moves into and closes the rest; a document
 * that has just loaded has none open. A block dropped on a column's box in
 * the map goes to the end of that column.
 */
function openColumnsPlugin() {
	return new Plugin<readonly number[]>({
		key: openColumnsKey,
		state: {
			init: () => [],
			apply(tr, open, _oldState, newState) {
				if (tr.selectionSet) {
					const next = columnsAroundSelection(newState);
					const unchanged = next.length === open.length && next.every((pos, i) => pos === open[i]);
					return unchanged ? open : next;
				}
				if (!tr.docChanged || open.length === 0) return open;
				return open
					.map((pos) => tr.mapping.map(pos))
					.filter((pos) => newState.doc.nodeAt(pos)?.type.name === "column");
			},
		},
		props: {
			decorations(state) {
				const open = openColumnsKey.getState(state);
				if (!open?.length) return null;
				return DecorationSet.create(
					state.doc,
					open.map((pos) =>
						Decoration.node(pos, pos + state.doc.nodeAt(pos)!.nodeSize, {
							class: "emdash-column-open",
						}),
					),
				);
			},
			handleDrop(view, event, slice, moved) {
				const box =
					event.target instanceof Element
						? event.target.closest<HTMLElement>("[data-emdash-column-index]")
						: null;
				if (!box) return false;
				// The map comes before the columns' content, so its DOM position is the content's start.
				const columnsPos = view.posAtDOM(box, 0) - 1;
				const index = Number(box.dataset.emdashColumnIndex);
				const end = columnContentEnd(view.state.doc, columnsPos, index);
				if (end === null) return true;
				const { tr } = view.state;
				if (moved) {
					const { from, to } = tr.selection;
					// A columns block can't be dropped into one of its own columns.
					if (from <= end && end <= to) return true;
					tr.deleteSelection();
				}
				const at = tr.mapping.map(end);
				tr.replaceRange(at, at, slice);
				view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(at))).scrollIntoView());
				view.focus();
				return true;
			},
		},
	});
}

/** Moves the selection into the column at `pos`, which opens it. */
function openColumn(editor: Editor, pos: number) {
	const { state } = editor;
	editor.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos + 1))));
	editor.view.focus();
}

/** Selects the columns block at `pos`, which closes its open column. */
function closeColumns(editor: Editor, pos: number) {
	editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
	editor.view.focus();
}

const GAPS = ["none", "sm", "md", "lg"] as const;
const ALIGNMENTS = ["stretch", "top", "center", "bottom"] as const;
const SPANS = [1, 2, 3] as const;

function ColumnsNodeView({ node, editor, getPos }: NodeViewProps) {
	const { i18n, t } = useLingui();
	const open = useEditorState({
		editor,
		selector: ({ editor: current }) => openColumnsKey.getState(current.state),
	});
	const [dropIndex, setDropIndex] = React.useState<number | null>(null);
	const summaryId = React.useId();
	const editable = editor.isEditable;
	const columnCount = node.childCount;
	const registry = getRegistry(
		editor as unknown as { storage: Record<string, Record<string, unknown>> },
	);

	const position = () => {
		const pos = getPos();
		return typeof pos === "number" ? pos : null;
	};

	const label = (block: ProseMirrorNode) => {
		if (block.type.name === "pluginBlock") {
			const blockType = typeof block.attrs.blockType === "string" ? block.attrs.blockType : "";
			return getEmbedMeta(blockType, registry).label;
		}
		const name = blockLabel(block);
		return name ? t(name) : t`Block`;
	};

	/** The column's first heading, or failing that its first line of text, and the kinds of block in it. */
	const summarize = (column: ProseMirrorNode) => {
		let heading = "";
		let text = "";
		const kinds = new Set<string>();
		column.forEach((block) => {
			if (block.type.name === "paragraph" && block.content.size === 0) return;
			kinds.add(label(block));
			if (!heading && block.type.name === "heading") heading = block.textContent.trim();
			if (!text && block.isTextblock) text = block.textContent.trim();
		});
		return { title: heading || text, kinds: [...kinds].join(", ") };
	};

	const addLast = () => {
		const pos = position();
		if (pos === null || !node.lastChild) return;
		addColumn(editor, pos + node.nodeSize - 1 - node.lastChild.nodeSize, "after");
	};

	const layout = (attrs: Parameters<typeof setColumnsLayout>[2]) => {
		const pos = position();
		if (pos !== null) setColumnsLayout(editor, pos, attrs);
	};

	const gapLabels: Record<(typeof GAPS)[number], string> = {
		none: t`None`,
		sm: t`Small`,
		md: t`Medium`,
		lg: t`Large`,
	};
	const alignmentLabels: Record<(typeof ALIGNMENTS)[number], string> = {
		stretch: t`Stretch`,
		top: t`Top`,
		center: t`Center`,
		bottom: t`Bottom`,
	};
	const gap = GAPS.find((value) => value === node.attrs.gap) ?? "md";
	const alignment = ALIGNMENTS.find((value) => value === node.attrs.verticalAlignment) ?? "stretch";

	const pos = position();
	const boxes: React.ReactNode[] = [];
	node.forEach((column, offset, index) => {
		const columnPos = pos === null ? null : pos + 1 + offset;
		const isOpen = columnPos !== null && (open?.includes(columnPos) ?? false);
		const span = SPANS.find((value) => value === column.attrs.span) ?? 1;
		const { title, kinds } = summarize(column);
		boxes.push(
			<button
				key={index}
				type="button"
				className="emdash-columns-map-box"
				data-span={span > 1 ? span : undefined}
				data-emdash-column-index={index}
				data-drop-target={dropIndex === index ? "" : undefined}
				aria-expanded={isOpen}
				aria-label={t`Column ${index + 1} of ${columnCount}`}
				aria-describedby={`${summaryId}-${index}`}
				data-emdash-disclosure
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					if (pos === null || columnPos === null) return;
					if (isOpen) closeColumns(editor, pos);
					else openColumn(editor, columnPos);
				}}
				onDragOver={(event) => {
					if (!editable || !editor.view.dragging) return;
					event.preventDefault();
					setDropIndex(index);
				}}
				onDragLeave={() => setDropIndex(null)}
				onDrop={() => setDropIndex(null)}
			>
				<span id={`${summaryId}-${index}`} className="contents">
					{title && (
						<span className="emdash-columns-map-title" dir="auto">
							{title}
						</span>
					)}
					<span className="emdash-columns-map-kinds" dir="auto">
						{kinds || t`Empty`}
					</span>
				</span>
			</button>,
		);
	});

	return (
		<NodeViewWrapper className="emdash-columns-node">
			<div
				className="emdash-columns-map"
				contentEditable={false}
				dir={getLocaleDir(i18n.locale)}
				role="group"
				aria-label={t`Columns`}
			>
				{boxes}
				{editable && (
					<div className="emdash-columns-map-actions">
						<Tooltip
							content={t`Add column`}
							render={
								<Button
									type="button"
									variant="ghost"
									shape="square"
									size="sm"
									disabled={columnCount >= MAX_EDITOR_COLUMNS}
									onClick={addLast}
									aria-label={t`Add column`}
								>
									<Plus className="size-4" aria-hidden="true" />
								</Button>
							}
						/>
						<Popover>
							<Popover.Trigger
								render={
									<Button
										type="button"
										variant="ghost"
										shape="square"
										size="sm"
										aria-label={t`Settings`}
									>
										<GearSix className="size-4" aria-hidden="true" />
									</Button>
								}
							/>
							<Popover.Content side="bottom" className="z-[100] grid w-64 gap-3 p-3">
								<Select
									label={t`Gap`}
									value={gap}
									onValueChange={(value) => layout({ gap: value === "md" ? null : value })}
									items={gapLabels}
								/>
								<Select
									label={t`Alignment`}
									value={alignment}
									onValueChange={(value) =>
										layout({ verticalAlignment: value === "stretch" ? null : value })
									}
									items={alignmentLabels}
								/>
								<Switch.Item
									checked={node.attrs.wrap === true}
									onCheckedChange={(checked) => layout({ wrap: checked ? true : null })}
									label={t`Wrap columns`}
								/>
							</Popover.Content>
						</Popover>
					</div>
				)}
			</div>
			<NodeViewContent className="emdash-columns-row" />
		</NodeViewWrapper>
	);
}

// Reading-order arrows: left points earlier in left-to-right text and later in right-to-left text.
const ArrowEarlier: Icon = React.forwardRef<SVGSVGElement, IconProps>(
	({ className, ...props }, ref) => (
		<ArrowLeft ref={ref} className={cn("rtl:-scale-x-100", className)} {...props} />
	),
);
const ArrowLater: Icon = React.forwardRef<SVGSVGElement, IconProps>(
	({ className, ...props }, ref) => (
		<ArrowRight ref={ref} className={cn("rtl:-scale-x-100", className)} {...props} />
	),
);

function ColumnNodeView({ node, editor, getPos }: NodeViewProps) {
	const { i18n, t } = useLingui();
	const [menuOpen, setMenuOpen] = React.useState(false);
	const span = SPANS.find((value) => value === node.attrs.span) ?? 1;
	const pos = getPos();
	const $pos = typeof pos === "number" ? editor.state.doc.resolve(pos) : null;
	const index = $pos?.index() ?? 0;
	const siblings = $pos?.parent.childCount ?? 1;

	const run = (command: (columnPos: number) => boolean) => () => {
		const columnPos = getPos();
		if (typeof columnPos === "number") command(columnPos);
	};
	const spanLabels: Record<(typeof SPANS)[number], string> = {
		1: t`Normal`,
		2: t`Wide`,
		3: t`Wider`,
	};

	return (
		<NodeViewWrapper className="emdash-column-node">
			<div className="emdash-column-header" contentEditable={false} dir={getLocaleDir(i18n.locale)}>
				<span className="min-w-0 flex-1 truncate">{t`Column ${index + 1} of ${siblings}`}</span>
				{editor.isEditable && (
					<Menu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
						<Menu.Trigger
							render={
								<Button
									type="button"
									variant="ghost"
									shape="square"
									size="sm"
									className="text-kumo-subtle"
									aria-label={t`Column actions`}
								>
									<DotsThree className="size-4" weight="bold" aria-hidden="true" />
								</Button>
							}
						/>
						<Menu.Portal>
							<Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-[100]">
								<Menu.Popup
									aria-label={t`Column actions`}
									finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
									onKeyDown={tabToEditor(editor, () => setMenuOpen(false))}
									className={cn(editorMenuPopupClassName, "w-56")}
								>
									<EditorMenuItem
										icon={Plus}
										label={t`Add column before`}
										disabled={siblings >= MAX_EDITOR_COLUMNS}
										onClick={run((columnPos) => addColumn(editor, columnPos, "before"))}
									/>
									<EditorMenuItem
										icon={Plus}
										label={t`Add column after`}
										disabled={siblings >= MAX_EDITOR_COLUMNS}
										onClick={run((columnPos) => addColumn(editor, columnPos, "after"))}
									/>
									<EditorMenuItem
										icon={ArrowEarlier}
										label={t`Move earlier`}
										disabled={index === 0}
										onClick={run((columnPos) => moveColumn(editor, columnPos, -1))}
									/>
									<EditorMenuItem
										icon={ArrowLater}
										label={t`Move later`}
										disabled={index >= siblings - 1}
										onClick={run((columnPos) => moveColumn(editor, columnPos, 1))}
									/>
									<EditorSubmenu icon={ArrowsHorizontal} label={t`Width`}>
										<Menu.RadioGroup
											value={String(span)}
											onValueChange={(value: string) => {
												const columnPos = getPos();
												if (typeof columnPos === "number") {
													setColumnSpan(editor, columnPos, Number(value));
												}
											}}
										>
											{SPANS.map((value) => (
												<EditorMenuRadioItem
													key={value}
													value={String(value)}
													label={spanLabels[value]}
												/>
											))}
										</Menu.RadioGroup>
									</EditorSubmenu>
									<EditorMenuSeparator />
									<EditorMenuItem
										icon={Trash}
										label={t`Delete column`}
										danger
										disabled={siblings <= 1}
										onClick={run((columnPos) => deleteColumn(editor, columnPos))}
									/>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				)}
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => {
						const columnPos = getPos();
						if (typeof columnPos === "number") {
							closeColumns(editor, editor.state.doc.resolve(columnPos).before());
						}
					}}
				>
					{t`Done`}
				</Button>
			</div>
			<NodeViewContent className="emdash-column-content" />
		</NodeViewWrapper>
	);
}

export const ColumnsBlockWithView = ColumnsBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ColumnsNodeView);
	},
	addProseMirrorPlugins() {
		return [openColumnsPlugin()];
	},
});

export const ColumnBlockWithView = ColumnBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ColumnNodeView);
	},
});
