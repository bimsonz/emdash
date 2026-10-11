/**
 * Node views for the columns block: a header to fold and lay out the whole
 * block, and a menu on each column to add, move, size or delete it. The block
 * itself moves with the editor's own handle, which reaches it from the header.
 * Folding is view state, kept in a plugin rather than the document, so it
 * never reaches a revision.
 */

import { Button, Popover, Select, Switch, Tooltip } from "@cloudflare/kumo";
import { Menu } from "@cloudflare/kumo/primitives/menu";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	ArrowRight,
	ArrowsHorizontal,
	CaretDown,
	DotsThree,
	GearSix,
	Plus,
	Trash,
	type Icon,
	type IconProps,
} from "@phosphor-icons/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
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
import { CaretNext } from "../ArrowIcons.js";
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

export const columnsCollapseKey = new PluginKey<ReadonlySet<string>>("emdashColumnsCollapse");

interface CollapseMeta {
	key: string;
	collapsed: boolean;
}

/**
 * Remembers which columns blocks are folded, by key, so a block stays folded
 * when it is dragged. A selection that lands inside a folded block unfolds it.
 */
function collapsePlugin() {
	return new Plugin<ReadonlySet<string>>({
		key: columnsCollapseKey,
		state: {
			init: () => new Set(),
			apply(tr, collapsed, _oldState, newState) {
				const meta = tr.getMeta(columnsCollapseKey) as CollapseMeta | undefined;
				const opened: string[] = [];
				if (tr.selectionSet) {
					const { $from } = newState.selection;
					for (let depth = $from.depth; depth > 0; depth--) {
						const ancestor = $from.node(depth);
						const key: unknown = ancestor.attrs.emdashKey;
						if (ancestor.type.name === "columns" && typeof key === "string" && collapsed.has(key)) {
							opened.push(key);
						}
					}
				}
				if (!meta && opened.length === 0) return collapsed;
				const next = new Set(collapsed);
				if (meta?.collapsed) next.add(meta.key);
				else if (meta) next.delete(meta.key);
				for (const key of opened) next.delete(key);
				return next;
			},
		},
		props: {
			decorations(state) {
				const collapsed = columnsCollapseKey.getState(state);
				if (!collapsed?.size) return null;
				const decorations: Decoration[] = [];
				state.doc.descendants((node, pos) => {
					if (node.type.name === "columns" && collapsed.has(node.attrs.emdashKey)) {
						decorations.push(
							Decoration.node(pos, pos + node.nodeSize, { class: "emdash-columns-collapsed" }),
						);
					}
				});
				return DecorationSet.create(state.doc, decorations);
			},
		},
	});
}

/** The blocks a columns block holds, leaving out the empty line an empty column keeps. */
function countBlocks(node: ProseMirrorNode): number {
	let count = 0;
	node.forEach((column) =>
		column.forEach((block) => {
			if (block.type.name !== "paragraph" || block.content.size > 0) count++;
		}),
	);
	return count;
}

const GAPS = ["none", "sm", "md", "lg"] as const;
const ALIGNMENTS = ["stretch", "top", "center", "bottom"] as const;

function ColumnsNodeView({ node, editor, getPos }: NodeViewProps) {
	const { i18n, t } = useLingui();
	const [localCollapsed, setLocalCollapsed] = React.useState(false);
	const key = typeof node.attrs.emdashKey === "string" ? node.attrs.emdashKey : null;
	const foldedByKey = useEditorState({
		editor,
		selector: ({ editor: current }) =>
			key !== null && (columnsCollapseKey.getState(current.state)?.has(key) ?? false),
	});
	const collapsed = key ? foldedByKey : localCollapsed;
	const contentId = React.useId();
	const columnCount = node.childCount;
	const blockCount = countBlocks(node);
	const editable = editor.isEditable;

	const position = () => {
		const pos = getPos();
		return typeof pos === "number" ? pos : null;
	};

	const toggle = () => {
		if (!key) {
			setLocalCollapsed(!localCollapsed);
			return;
		}
		const tr = editor.state.tr.setMeta(columnsCollapseKey, {
			key,
			collapsed: !collapsed,
		} satisfies CollapseMeta);
		// A caret left inside a folded block would unfold it on the next selection change.
		const pos = position();
		if (!collapsed && pos !== null) tr.setSelection(NodeSelection.create(tr.doc, pos));
		editor.view.dispatch(tr);
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
	const summary = t`${plural(columnCount, { one: "# column", other: "# columns" })}, ${plural(
		blockCount,
		{ one: "# block", other: "# blocks" },
	)}`;

	return (
		<NodeViewWrapper
			className={cn("emdash-columns-node", !key && localCollapsed && "emdash-columns-collapsed")}
			data-gap={gap}
			data-vertical-alignment={alignment}
			data-wrap={node.attrs.wrap === true ? "" : undefined}
		>
			<div
				className="emdash-columns-header"
				contentEditable={false}
				dir={getLocaleDir(i18n.locale)}
			>
				<button
					type="button"
					className="emdash-columns-toggle flex min-w-0 flex-1 items-center gap-1.5 text-start"
					onClick={toggle}
					aria-expanded={!collapsed}
					aria-controls={contentId}
					aria-label={collapsed ? t`Expand block` : t`Collapse block`}
					data-emdash-disclosure
				>
					{collapsed ? (
						<CaretNext className="size-3.5 flex-none" aria-hidden="true" />
					) : (
						<CaretDown className="size-3.5 flex-none" aria-hidden="true" />
					)}
					<span className="font-medium">{t`Columns`}</span>
					{collapsed && (
						<span className="min-w-0 truncate text-kumo-subtle" dir="auto">
							{summary}
						</span>
					)}
				</button>
				{editable && (
					<>
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
					</>
				)}
			</div>
			<NodeViewContent className="emdash-columns-row" id={contentId} />
		</NodeViewWrapper>
	);
}

const SPANS = [1, 2, 3] as const;

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
			{editor.isEditable && (
				<div
					className="emdash-column-header"
					contentEditable={false}
					dir={getLocaleDir(i18n.locale)}
				>
					<Menu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
						<Menu.Trigger
							render={
								<Button
									type="button"
									variant="ghost"
									shape="square"
									size="sm"
									className="emdash-column-menu-trigger text-kumo-subtle"
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
				</div>
			)}
			<NodeViewContent className="emdash-column-content" />
		</NodeViewWrapper>
	);
}

export const ColumnsBlockWithView = ColumnsBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ColumnsNodeView);
	},
	addProseMirrorPlugins() {
		return [collapsePlugin()];
	},
});

export const ColumnBlockWithView = ColumnBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ColumnNodeView, {
			attrs: ({ node }): Record<string, string> => {
				const span = SPANS.find((value) => value === node.attrs.span);
				return span && span > 1 ? { "data-span": String(span) } : {};
			},
		});
	},
});
