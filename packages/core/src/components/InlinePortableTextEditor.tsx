/**
 * Self-contained inline Portable Text editor for visual editing.
 *
 * Uses TipTap directly with content extensions — no admin UI deps.
 * Includes the admin editor's selection toolbar and slash menu, and a
 * toolbar and picker for images, but no fixed toolbar, sidebar, or section
 * picker.
 *
 * Converts between Portable Text and ProseMirror on mount/save.
 * Auto-saves on blur, dispatches custom events for toolbar integration.
 */

import { htmlBlockFields } from "@emdash-cms/admin/html-block";
import { pluginBlockKeyFromAttrs } from "@emdash-cms/admin/plugin-block-key";
import {
	isPortableTextColumnsInput,
	portableTextColumnsToProseMirror,
	proseMirrorColumnsToPortableText,
} from "@emdash-cms/admin/portable-text-columns";
import { Cube } from "@phosphor-icons/react";
import { Node, mergeAttributes, type Editor as TiptapEditor, type JSONContent } from "@tiptap/core";
import Focus from "@tiptap/extension-focus";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, type Transaction } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { exitSuggestion } from "@tiptap/suggestion";
import * as React from "react";

import { resolveImageMedia } from "../content/converters/gallery.js";
import { normalizeImageLink } from "../content/converters/image-link.js";
import {
	assertPortableTextMarksSupported,
	assertProseMirrorMarksSupported,
	UnsupportedPortableTextMarksError,
} from "../content/converters/mark-safety.js";
import {
	deriveLegacyListId,
	normalizeProseMirrorOrderedListJson,
	normalizeListId,
	normalizeListStart,
	readOrderedListMetadata,
} from "../content/converters/numbered-list.js";
import type { ProseMirrorDocument } from "../content/converters/types.js";
import { CodeMarkExtension } from "./code-mark.js";
import {
	INLINE_BLOCK_SETTINGS_STYLES,
	InlineBlockSettings,
	blockFormValues,
	loadBlockDefinitions,
	type BlockDefinition,
} from "./inline-block-settings.js";
import { InlineBubbleMenu } from "./inline-bubble-menu.js";
import { InlineCodeBlockExtension } from "./inline-code-block.js";
import {
	INLINE_COLUMNS_STYLES,
	InlineColumn,
	InlineColumns,
	InlineColumnsLayout,
	InlineDocument,
} from "./inline-columns.js";
import { INLINE_EDITOR_UI_STYLES, useInlineUiRoot } from "./inline-editor-ui.js";
import { INLINE_IMAGE_STYLES, InlineImageExtension, insertImage } from "./inline-image.js";
import { INLINE_MEDIA_PICKER_STYLES, InlineMediaPicker } from "./inline-media-picker.js";
import {
	InlineSlashMenu,
	createSlashCommandsExtension,
	initialSlashMenuState,
	slashCommands,
	type SlashCommandItem,
	type SlashMenuState,
} from "./inline-slash-menu.js";
import { EmDashOrderedList } from "./ordered-list.js";

// ── Portable Text types ────────────────────────────────────────────

interface PTSpan {
	_type: "span";
	_key: string;
	text: string;
	marks?: string[];
}

interface PTMarkDef {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

interface PTTextBlock {
	_type: "block";
	_key: string;
	style?: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
	listItem?: "bullet" | "number";
	level?: number;
	listId?: string;
	listStart?: number;
	children: PTSpan[];
	markDefs?: PTMarkDef[];
	textAlign?: "left" | "center" | "right" | "justify";
}

type PTTableBlock = { _type: "table"; [key: string]: unknown };
type PTBlock = PTTextBlock | PTTableBlock | { _type: string; _key: string; [key: string]: unknown };
const TABLE_BLOCK_PLACEHOLDER_HTML = /<[^>]+\bdata-emdash-table-block(?:\s|=|>)/i;

/** Type guard for PTTextBlock */
function isPTTextBlock(block: PTBlock): block is PTTextBlock {
	return block._type === "block";
}

function isPTTableBlock(value: unknown): value is PTTableBlock {
	return typeof value === "object" && value !== null && "_type" in value && value._type === "table";
}

/** Type guard for a ProseMirror JSON document. */
function isProseMirrorDocument(value: unknown): value is ProseMirrorDocument {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "doc" &&
		"content" in value &&
		Array.isArray(value.content)
	);
}

// ── Helpers ────────────────────────────────────────────────────────

function k(): string {
	return Math.random().toString(36).substring(2, 11);
}

function getUnsupportedFileGuidance(locale: string): string {
	if (locale.toLowerCase().startsWith("ar")) {
		return "لا يمكن إفلات الملفات أو لصقها هنا. اكتب /image لاختيار صورة من مكتبة الوسائط.";
	}
	return "Files can’t be dropped or pasted here. Type /image to choose an image from the media library.";
}

function hasTransferredFiles(transfer: DataTransfer | null): boolean {
	if (!transfer) return false;
	if (transfer.files.length > 0) return true;
	for (let index = 0; index < transfer.items.length; index++) {
		if (transfer.items[index]?.kind === "file") return true;
	}
	return false;
}

function createUnsupportedFileHandlers(showGuidance: () => void) {
	const keepFileDragInEditor = (_view: unknown, event: DragEvent): boolean => {
		if (!hasTransferredFiles(event.dataTransfer)) return false;
		event.preventDefault();
		return true;
	};
	return {
		handleDOMEvents: {
			dragenter: keepFileDragInEditor,
			dragover: keepFileDragInEditor,
			drop: (_view: unknown, event: DragEvent): boolean => {
				if (!hasTransferredFiles(event.dataTransfer)) return false;
				event.preventDefault();
				showGuidance();
				return true;
			},
			paste: (_view: unknown, event: ClipboardEvent): boolean => {
				if (!hasTransferredFiles(event.clipboardData)) return false;
				event.preventDefault();
				showGuidance();
				return true;
			},
		},
	};
}

// ── ProseMirror → Portable Text ────────────────────────────────────

type PMNode = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PMNode[];
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	text?: string;
};

/** Safely extract a string attribute from ProseMirror attrs */
function attrStr(attrs: Record<string, unknown> | undefined, key: string): string {
	const v = attrs?.[key];
	return typeof v === "string" ? v : "";
}

/** Safely extract an optional string attribute from ProseMirror attrs */
function attrStrOpt(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
	const v = attrs?.[key];
	return typeof v === "string" && v ? v : undefined;
}

/** Safely extract a number attribute from ProseMirror attrs */
function attrNum(attrs: Record<string, unknown> | undefined, key: string): number | undefined {
	const v = attrs?.[key];
	return typeof v === "number" ? v : undefined;
}

function attrDimension(
	attrs: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = attrNum(attrs, key);
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

type ImageAlignment = "left" | "center" | "right" | "wide" | "full";

function imageAlignment(value: unknown): ImageAlignment | undefined {
	return value === "left" ||
		value === "center" ||
		value === "right" ||
		value === "wide" ||
		value === "full"
		? value
		: undefined;
}

function canonicalMediaProviderId(provider: string | undefined): string | undefined {
	return provider === "external-url" ? "external" : provider;
}

function pmToPortableText(doc: PMNode): PTBlock[] {
	if (!doc || doc.type !== "doc" || !doc.content) return [];
	return convertPMNodes(doc.content, "root");
}

/**
 * Convert sibling nodes: the document's, or a column's. A key that repeats a
 * sibling's is replaced, since keys only need to be unique among siblings.
 */
function convertPMNodes(nodes: PMNode[], path: string): PTBlock[] {
	const blocks: PTBlock[] = [];
	const usedKeys = new Set<string>();
	for (let i = 0; i < nodes.length; i++) {
		const r = convertPMNode(nodes[i]!, `${path}:${i}`);
		for (const block of r ? (Array.isArray(r) ? r : [r]) : []) {
			let key = typeof block._key === "string" ? block._key : k();
			while (usedKeys.has(key)) key = k();
			usedKeys.add(key);
			blocks.push(key === block._key ? block : { ...block, _type: block._type, _key: key });
		}
	}
	return blocks;
}

function isPMNode(value: unknown): value is PMNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** A column's blocks. An empty column is one empty line in the editor, and no blocks when stored. */
function convertPMColumn(content: unknown[], path: string): PTBlock[] {
	const nodes = content.filter(isPMNode);
	const [only] = nodes;
	if (nodes.length === 1 && only?.type === "paragraph" && !only.content?.length) return [];
	return convertPMNodes(nodes, path);
}

function convertPMNode(node: PMNode, path: string): PTBlock | PTBlock[] | null {
	switch (node.type) {
		case "paragraph": {
			const { children, markDefs } = convertInline(node.content || []);
			if (children.length === 0) return null;
			const ta = node.attrs?.textAlign;
			const textAlign = ta === "center" || ta === "right" || ta === "justify" ? ta : undefined;
			return {
				_type: "block",
				_key: k(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
				...(textAlign ? { textAlign } : {}),
			};
		}
		case "heading": {
			const { children, markDefs } = convertInline(node.content || []);
			const level = attrNum(node.attrs, "level") ?? 1;
			if (children.length === 0) return null;
			const headingStyles: Record<number, PTTextBlock["style"]> = {
				1: "h1",
				2: "h2",
				3: "h3",
				4: "h4",
				5: "h5",
				6: "h6",
			};
			const headingStyle = headingStyles[level] ?? "h1";
			const ta = node.attrs?.textAlign;
			const textAlign = ta === "center" || ta === "right" || ta === "justify" ? ta : undefined;
			return {
				_type: "block",
				_key: k(),
				style: headingStyle,
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
				...(textAlign ? { textAlign } : {}),
			};
		}
		case "bulletList":
			return convertPMList(node.content || [], "bullet", 1, node.attrs, path);
		case "orderedList":
			return convertPMList(node.content || [], "number", 1, node.attrs, path);
		case "blockquote": {
			const blocks: PTTextBlock[] = [];
			for (const child of node.content || []) {
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInline(child.content || []);
					if (children.length > 0) {
						blocks.push({
							_type: "block",
							_key: k(),
							style: "blockquote",
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				}
			}
			if (blocks.length === 1) {
				const first = blocks[0];
				return first ?? null;
			}
			return blocks.length > 0 ? blocks : null;
		}
		case "codeBlock": {
			const code = (node.content || []).map((n) => n.text || "").join("");
			return {
				_type: "code",
				_key: k(),
				code,
				language: attrStrOpt(node.attrs, "language"),
			};
		}
		case "htmlBlock":
			return {
				_type: "htmlBlock",
				_key: k(),
				...htmlBlockFields(node.attrs ?? {}),
			};
		case "image": {
			const provider = attrStrOpt(node.attrs, "provider");
			const blurhash = attrStrOpt(node.attrs, "blurhash");
			const dominantColor = attrStrOpt(node.attrs, "dominantColor");
			const title = attrStrOpt(node.attrs, "title");
			const caption = Object.hasOwn(node.attrs ?? {}, "caption")
				? (attrStrOpt(node.attrs, "caption") ?? (title ? "" : undefined))
				: title;
			// Persist LQIP as first-class block fields (matching the image-field
			// MediaValue path) rather than nesting in `asset.meta`, so read sites
			// and normalize don't need a dual-shape fallback. `asset.meta` is left
			// to carry only provider-specific data — it isn't reconstructed here,
			// so non-LQIP meta keys are never silently dropped on editor round-trip.
			return {
				_type: "image",
				_key: k(),
				asset: {
					_ref: attrStr(node.attrs, "mediaId"),
					url: attrStr(node.attrs, "src"),
					provider: provider && provider !== "local" ? provider : undefined,
				},
				alt: attrStrOpt(node.attrs, "alt"),
				caption,
				title,
				width: attrDimension(node.attrs, "width"),
				height: attrDimension(node.attrs, "height"),
				...(blurhash ? { blurhash } : {}),
				...(dominantColor ? { dominantColor } : {}),
				displayWidth: attrDimension(node.attrs, "displayWidth"),
				displayHeight: attrDimension(node.attrs, "displayHeight"),
				alignment: imageAlignment(node.attrs?.alignment),
				link: normalizeImageLink(node.attrs?.link) ?? undefined,
			};
		}
		case "horizontalRule":
			return { _type: "break", _key: k(), style: "lineBreak" };
		case "table": {
			const rawTable = node.attrs?.rawTable;
			if (isPTTableBlock(rawTable)) return rawTable;
			return null;
		}
		case "columns":
			return proseMirrorColumnsToPortableText(
				node,
				(content, index) => convertPMColumn(content, `${path}:${index}`),
				k,
			);
		case "pluginBlock":
			return pluginBlockToPortableText(node.attrs);
		default:
			return null;
	}
}

function convertPMList(
	items: PMNode[],
	listItem: "bullet" | "number",
	level: number,
	attrs: Record<string, unknown> | undefined,
	path: string,
): PTTextBlock[] {
	const blocks: PTTextBlock[] = [];
	const metadata = listItem === "number" ? readOrderedListMetadata(attrs, path) : undefined;
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex]!;
		if (item.type === "listItem") {
			for (let childIndex = 0; childIndex < (item.content?.length ?? 0); childIndex++) {
				const child = item.content![childIndex]!;
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInline(child.content || []);
					if (children.length > 0) {
						blocks.push({
							_type: "block",
							_key: k(),
							style: "normal",
							listItem,
							level,
							...metadata,
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				} else if (child.type === "bulletList" || child.type === "orderedList") {
					const childListItem = child.type === "bulletList" ? "bullet" : "number";
					blocks.push(
						...convertPMList(
							child.content || [],
							childListItem,
							level + 1,
							child.attrs,
							`${path}:${itemIndex}:${childIndex}`,
						),
					);
				}
			}
		}
	}
	return blocks;
}

function convertInline(nodes: PMNode[]): { children: PTSpan[]; markDefs: PTMarkDef[] } {
	const children: PTSpan[] = [];
	const markDefs: PTMarkDef[] = [];
	const markDefMap = new Map<string, string>();

	for (const node of nodes) {
		if (node.type === "text" && node.text) {
			const marks: string[] = [];
			for (const mark of node.marks || []) {
				const m = convertPMMark(mark, markDefs, markDefMap);
				if (m) marks.push(m);
			}
			children.push({
				_type: "span",
				_key: k(),
				text: node.text,
				marks: marks.length > 0 ? marks : undefined,
			});
		} else if (node.type === "hardBreak") {
			if (children.length > 0) {
				const last = children.at(-1);
				if (last) last.text += "\n";
			} else {
				children.push({ _type: "span", _key: k(), text: "\n" });
			}
		}
	}

	if (children.length === 0) {
		children.push({ _type: "span", _key: k(), text: "" });
	}
	return { children, markDefs };
}

function convertPMMark(
	mark: { type: string; attrs?: Record<string, unknown> },
	markDefs: PTMarkDef[],
	markDefMap: Map<string, string>,
): string | null {
	switch (mark.type) {
		case "bold":
		case "strong":
			return "strong";
		case "italic":
		case "em":
			return "em";
		case "underline":
			return "underline";
		case "strike":
		case "strikethrough":
			return "strike-through";
		case "code":
			return "code";
		case "link": {
			const href = attrStr(mark.attrs, "href");
			if (markDefMap.has(href)) return markDefMap.get(href)!;
			const key = k();
			markDefs.push({
				_type: "link",
				_key: key,
				href,
				blank: mark.attrs?.target === "_blank",
			});
			markDefMap.set(href, key);
			return key;
		}
		default:
			return mark.type;
	}
}

// ── Portable Text → ProseMirror ────────────────────────────────────

function portableTextToPM(blocks: PTBlock[]): JSONContent {
	if (!blocks || blocks.length === 0) return { type: "doc", content: [{ type: "paragraph" }] };
	assertPortableTextMarksSupported(blocks);

	const content = convertPTBlocks(blocks, "root");

	return normalizeProseMirrorOrderedListJson({
		type: "doc",
		content: content.length > 0 ? content : [{ type: "paragraph" }],
	});
}

/** Convert sibling blocks: the document's, or a column's. */
function convertPTBlocks(blocks: PTBlock[], path: string): PMNode[] {
	const content: PMNode[] = [];
	let i = 0;

	while (i < blocks.length) {
		const block = blocks[i];
		if (!block) {
			i++;
			continue;
		}
		if (isPTTextBlock(block) && block.listItem) {
			const listBlocks: PTTextBlock[] = [];
			const listType = block.listItem;
			const runStart = i;
			const rootId = listType === "number" ? normalizeListId(block.listId) : undefined;
			while (i < blocks.length) {
				const cur = blocks[i];
				if (!cur || !isPTTextBlock(cur) || !cur.listItem) break;
				const level = cur.level || 1;
				const currentId = cur.listItem === "number" ? normalizeListId(cur.listId) : undefined;
				const sameIdentity =
					listType !== "number" ||
					level > 1 ||
					(rootId ? currentId === rootId : currentId === undefined);
				if (level > 1 || (cur.listItem === listType && sameIdentity)) {
					listBlocks.push(cur);
					i++;
				} else break;
			}
			content.push(convertPTList(listBlocks, listType, `${path}:${runStart}`));
		} else if (
			isPTTextBlock(block) &&
			block.style === "blockquote" &&
			block.listItem === undefined
		) {
			// Group consecutive blockquote blocks into ONE blockquote node —
			// PT is flat, so a multi-paragraph quote is stored as a run of
			// blockquote-styled blocks. Mirrors the grouping in
			// content/converters/portable-text-to-prosemirror.ts; without it
			// merges revert on reload in the inline editor too.
			const quoteBlocks: PTTextBlock[] = [];
			while (i < blocks.length) {
				const cur = blocks[i];
				if (
					!cur ||
					!isPTTextBlock(cur) ||
					cur.style !== "blockquote" ||
					cur.listItem !== undefined
				) {
					break;
				}
				quoteBlocks.push(cur);
				i++;
			}
			content.push({
				type: "blockquote",
				content: quoteBlocks.map((quoteBlock) => {
					const pmContent = convertPTSpans(quoteBlock.children, quoteBlock.markDefs || []);
					return {
						type: "paragraph",
						content: pmContent.length > 0 ? pmContent : undefined,
					};
				}),
			});
		} else {
			const c = convertPTBlock(block, `${path}:${i}`);
			if (c) content.push(c);
			i++;
		}
	}

	return content;
}

function convertPTBlock(block: PTBlock, path: string): PMNode | null {
	if (isPTTextBlock(block)) {
		const { style = "normal", children, markDefs = [], textAlign } = block;
		const pmContent = convertPTSpans(children, markDefs);

		if (style === "blockquote") {
			return {
				type: "blockquote",
				content: [
					{
						type: "paragraph",
						content: pmContent.length > 0 ? pmContent : undefined,
					},
				],
			};
		}
		if (style?.startsWith("h")) {
			const level = parseInt(style.substring(1), 10);
			return {
				type: "heading",
				attrs: { level, ...(textAlign ? { textAlign } : {}) },
				content: pmContent.length > 0 ? pmContent : undefined,
			};
		}
		return {
			type: "paragraph",
			attrs: textAlign ? { textAlign } : undefined,
			content: pmContent.length > 0 ? pmContent : undefined,
		};
	}
	if (block._type === "code") {
		const cb = block as PTBlock & { code?: string; language?: string };
		const language = typeof cb.language === "string" && cb.language.length > 0 ? cb.language : null;
		return {
			type: "codeBlock",
			attrs: { language },
			content: cb.code ? [{ type: "text", text: cb.code }] : undefined,
		};
	}
	if (block._type === "break") {
		return { type: "horizontalRule" };
	}
	if (block._type === "htmlBlock") {
		return {
			type: "htmlBlock",
			attrs: { ...htmlBlockFields(block) },
		};
	}
	if (block._type === "image") {
		const ib = block as PTBlock & {
			asset?: {
				_ref?: string;
				url?: string;
				provider?: string;
				meta?: Record<string, unknown>;
			};
			url?: string;
			alt?: string;
			caption?: string;
			title?: string;
			width?: number;
			height?: number;
			/** LQIP — first-class field (legacy snapshots keep it in `asset.meta`). */
			blurhash?: string;
			dominantColor?: string;
			displayWidth?: number;
			displayHeight?: number;
			alignment?: unknown;
			/** `{ href, blank? }`, or a bare string on WordPress-imported content */
			link?: unknown;
		};
		const meta = ib.asset?.meta;
		const { asset, alt, width, height } = resolveImageMedia(ib);
		// Prefer first-class LQIP fields; fall back to `asset.meta` for legacy.
		const blurhash =
			typeof ib.blurhash === "string"
				? ib.blurhash
				: typeof meta?.blurhash === "string"
					? meta.blurhash
					: null;
		const dominantColor =
			typeof ib.dominantColor === "string"
				? ib.dominantColor
				: typeof meta?.dominantColor === "string"
					? meta.dominantColor
					: null;
		return {
			type: "image",
			attrs: {
				src: asset.url || ib.url || (asset._ref ? `/_emdash/api/media/file/${asset._ref}` : ""),
				alt: alt || "",
				title: ib.title || "",
				caption: Object.hasOwn(ib, "caption") ? ib.caption || "" : ib.title || "",
				mediaId: asset._ref || undefined,
				provider: canonicalMediaProviderId(asset.provider),
				width,
				height,
				blurhash,
				dominantColor,
				displayWidth: ib.displayWidth,
				displayHeight: ib.displayHeight,
				alignment: imageAlignment(ib.alignment) ?? null,
				link: normalizeImageLink(ib.link),
			},
		};
	}
	if (block._type === "table") {
		return {
			type: "table",
			attrs: { rawTable: block },
		};
	}
	if (isPortableTextColumnsInput(block)) {
		return portableTextColumnsToProseMirror(block, (content, index) =>
			convertPTBlocks(content, `${path}:${index}`),
		);
	}
	// Unknown block types — treat as plugin blocks.
	return { type: "pluginBlock", attrs: pluginBlockAttrs(block) };
}

/**
 * A plugin block's node attributes, from its Portable Text. Every field other than the well-known
 * ones goes into `data`, so the block round-trips losslessly even if no plugin currently registers
 * its type (matches the admin editor's `convertCustomBlock`). The identity stays under whichever of
 * `id` / `url` the block arrived with, so the PM → PT direction writes it back under the same key.
 */
function pluginBlockAttrs(block: Record<string, unknown>): Record<string, unknown> {
	const identityField =
		typeof block.id === "string" ? "id" : typeof block.url === "string" ? "url" : "";
	const identity = identityField ? block[identityField] : undefined;
	// Filter out _-prefixed keys to prevent accumulation across edit cycles.
	const data = Object.fromEntries(
		Object.entries(block).filter(([key]) => !key.startsWith("_") && key !== identityField),
	);
	return {
		blockType: typeof block._type === "string" ? block._type : "embed",
		id: typeof identity === "string" ? identity : "",
		identityField,
		data,
	};
}

/**
 * A plugin block's Portable Text, from its node's attributes: the captured data spread back out.
 * `data` holds every field except _type / _key and the identity field (`id` or `url`, named by
 * `identityField`), which live on dedicated attrs.
 */
function pluginBlockToPortableText(attrs: Record<string, unknown> | undefined): PTBlock {
	const { blockType, id, identityField, data } = attrs ?? {};
	const field = identityField === "url" || identityField === "" ? identityField : "id";
	return {
		...(data && typeof data === "object" ? data : {}),
		_type: typeof blockType === "string" ? blockType : "embed",
		_key: k(),
		...(field ? { [field]: typeof id === "string" ? id : "" } : {}),
	};
}

function convertPTList(
	items: PTTextBlock[],
	listType: "bullet" | "number",
	context: string,
): PMNode {
	const rootItems: PMNode[] = [];
	let index = 0;

	while (index < items.length) {
		const item = items[index]!;
		const level = item.level || 1;
		if (level === 1) {
			const nestedItems: PTTextBlock[] = [];
			index++;
			while (index < items.length && (items[index]!.level || 1) > 1) {
				nestedItems.push(items[index]!);
				index++;
			}
			rootItems.push(
				convertPTListItem(item, nestedItems, listType, `${context}:${rootItems.length}`),
			);
		} else {
			rootItems.push(convertPTListItem(item, [], listType, `${context}:${rootItems.length}`));
			index++;
		}
	}

	const firstItem = items[0]!;
	const listId =
		normalizeListId(firstItem.listId) ?? deriveLegacyListId(`${context}:${firstItem._key}`);
	const listStart = normalizeListStart(firstItem.listStart);
	const metadata =
		listType === "number"
			? {
					listId,
					...(listStart === undefined ? {} : { listStart }),
				}
			: undefined;
	return {
		type: listType === "bullet" ? "bulletList" : "orderedList",
		attrs: metadata ? { ...metadata, start: metadata.listStart ?? 1 } : undefined,
		content: rootItems,
	};
}

function belongsToNestedPTGroup(
	item: PTTextBlock,
	minLevel: number,
	parentListType: "bullet" | "number",
	anchorType: "bullet" | "number",
	anchorId: string | undefined,
): boolean {
	if ((item.level || 2) > minLevel) return true;
	if ((item.listItem || parentListType) !== anchorType) return false;
	if (anchorType !== "number") return true;
	const itemId = normalizeListId(item.listId);
	return anchorId ? itemId === anchorId : itemId === undefined;
}

function convertPTListItem(
	item: PTTextBlock,
	nestedItems: PTTextBlock[],
	parentListType: "bullet" | "number",
	context: string,
): PMNode {
	const content: PMNode[] = [
		{
			type: "paragraph",
			content: convertPTSpans(item.children, item.markDefs || []),
		},
	];

	if (nestedItems.length > 0) {
		let minLevel = Infinity;
		for (const nestedItem of nestedItems) {
			const level = nestedItem.level || 2;
			if (level < minLevel) minLevel = level;
		}

		let index = 0;
		while (index < nestedItems.length) {
			const groupStart = index;
			const anchorType = nestedItems[index]!.listItem || parentListType;
			const anchorId =
				anchorType === "number" ? normalizeListId(nestedItems[index]!.listId) : undefined;
			const nestedGroup: PTTextBlock[] = [];
			do {
				nestedGroup.push(nestedItems[index]!);
				index++;
			} while (
				index < nestedItems.length &&
				belongsToNestedPTGroup(nestedItems[index]!, minLevel, parentListType, anchorType, anchorId)
			);

			content.push(
				convertPTList(
					nestedGroup.map((nestedItem) => ({
						...nestedItem,
						level: (nestedItem.level || 2) - 1,
					})),
					anchorType,
					`${context}:nested:${groupStart}`,
				),
			);
		}
	}

	return { type: "listItem", content };
}

function convertPTSpans(spans: PTSpan[], markDefs: PTMarkDef[]): PMNode[] {
	const nodes: PMNode[] = [];
	const mdMap = new Map(markDefs.map((md) => [md._key, md]));

	for (const span of spans) {
		if (span._type !== "span") continue;
		const parts = span.text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const text = parts[i];
			if (text && text.length > 0) {
				const marks = convertPTMarks(span.marks || [], mdMap);
				const node: PMNode = {
					type: "text",
					text,
				};
				if (marks.length > 0) node.marks = marks;
				nodes.push(node);
			}
			if (i < parts.length - 1) nodes.push({ type: "hardBreak" });
		}
	}
	return nodes;
}

type MarkJSON = { type: string; attrs?: Record<string, unknown>; [key: string]: unknown };

function convertPTMarks(marks: string[], markDefs: Map<string, PTMarkDef>): MarkJSON[] {
	const pm: MarkJSON[] = [];
	for (const mark of marks) {
		switch (mark) {
			case "strong":
				pm.push({ type: "bold" });
				break;
			case "em":
				pm.push({ type: "italic" });
				break;
			case "underline":
				pm.push({ type: "underline" });
				break;
			case "strike-through":
				pm.push({ type: "strike" });
				break;
			case "code":
				pm.push({ type: "code" });
				break;
			case "superscript":
				pm.push({ type: "superscript" });
				break;
			case "subscript":
				pm.push({ type: "subscript" });
				break;
			default: {
				const md = markDefs.get(mark);
				if (md && md._type === "link") {
					pm.push({
						type: "link",
						attrs: { href: md.href, target: md.blank ? "_blank" : null },
					});
				}
				break;
			}
		}
	}
	return pm;
}

/**
 * Minimal `htmlBlock` TipTap node for the inline (visual-editing) editor.
 *
 * Like PluginBlockNode below, this renders as a read-only placeholder so the
 * block's data is preserved across edits in the visual editor. Full editing
 * (textarea + preview) is only available in the admin editor.
 */
const HtmlBlockNode = Node.create({
	name: "htmlBlock",
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addAttributes() {
		const noDom = { rendered: false, parseHTML: () => null };
		return {
			html: { default: "", ...noDom },
			css: { default: "", ...noDom },
			js: { default: "", ...noDom },
			isolated: { default: false, ...noDom },
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-emdash-html-block="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-emdash-html-block": "true",
				class: "emdash-plugin-block-placeholder",
				contenteditable: "false",
			}),
			"HTML block (edit in admin)",
		];
	},
});

const TableBlockNode = Node.create<{ placeholder: string }>({
	name: "table",
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addOptions() {
		return { placeholder: "Table (edit in admin)" };
	},

	addAttributes() {
		return {
			rawTable: { default: null, rendered: false, parseHTML: () => null },
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-emdash-table-block="true"]' }];
	},

	addProseMirrorPlugins() {
		return [
			new Plugin({
				props: {
					handleDOMEvents: {
						cut: (view, event) => {
							let hasTable = false;
							view.state.selection.content().content.descendants((node) => {
								hasTable ||= node.type.name === "table";
							});
							if (!hasTable) return false;
							event.preventDefault();
							return true;
						},
					},
					handlePaste: (_view, event, slice) => {
						const html = event.clipboardData?.getData("text/html") ?? "";
						if (!TABLE_BLOCK_PLACEHOLDER_HTML.test(html)) return false;

						let hasTable = false;
						let hasMissingPayload = false;
						slice.content.descendants((node) => {
							if (node.type.name !== "table") return;
							hasTable = true;
							if (!isPTTableBlock(node.attrs.rawTable)) hasMissingPayload = true;
						});
						if (hasTable && !hasMissingPayload) return false;

						event.preventDefault();
						return true;
					},
				},
			}),
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-emdash-table-block": "true",
				class: "emdash-plugin-block-placeholder",
				contenteditable: "false",
			}),
			this.options.placeholder,
		];
	},
});

/**
 * The `pluginBlock` TipTap node of the inline (visual-editing) editor: a plugin-contributed Portable
 * Text block type (e.g. `marketing.hero`). It shows as the page renders it, running, when the page
 * supplies a preview (`BlockPreview`); otherwise as a slot naming the block and what it is set to.
 * A bar on it opens its settings, which are edited on the page in the admin's Block Kit form
 * (`InlineBlockSettings`), moves it and deletes it.
 *
 * The full block payload is preserved on `data` and round-tripped losslessly
 * through PT ↔ PM conversion (see convertPTBlock/convertPMNode). Without this
 * extension, ProseMirror's schema would silently filter unknown nodes on load
 * and the next save would persist the block's disappearance.
 */
const PluginBlockNode = Node.create<PluginBlockOptions>({
	name: "pluginBlock",
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addAttributes() {
		// These attributes are stored on the ProseMirror node but not
		// rendered as DOM attributes — they're metadata for the round-trip,
		// not styling or behaviour the placeholder DOM needs to expose.
		const noDom = { rendered: false, parseHTML: () => null };
		return {
			blockType: { default: "", ...noDom },
			id: { default: "", ...noDom },
			identityField: { default: "id", ...noDom },
			data: { default: {}, ...noDom },
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-emdash-plugin-block="true"]' }];
	},

	renderHTML({ HTMLAttributes, node }) {
		const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "";
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-emdash-plugin-block": "true",
				"data-block-type": blockType,
				class: "emdash-plugin-block-placeholder",
				contenteditable: "false",
			}),
			blockLabel(blockType),
		];
	},

	addOptions() {
		return { definition: () => undefined, openSettings: null, redrawing: () => false };
	},

	addNodeView() {
		return ({ node, getPos, editor }) => pluginBlockView(node, getPos, editor, this.options);
	},
});

interface PluginBlockOptions {
	/** The block type's definition, once the editor has the admin manifest. */
	definition: (blockType: string) => BlockDefinition | undefined;
	/** Opens the settings of the block at a position. */
	openSettings: ((pos: number) => void) | null;
	/** Whether the editor is fetching the page for the previews of blocks that just changed. */
	redrawing: () => boolean;
}

/** Dispatched on the document when blocks' previews or definitions arrive, for blocks to redraw. */
const BLOCK_PREVIEWS_EVENT = "emdash:block-previews";

function pluginBlockView(
	initial: ProseMirrorNode,
	getPos: () => number | undefined,
	editor: TiptapEditor,
	options: PluginBlockOptions,
): NodeView {
	let node = initial;
	const dom = document.createElement("div");
	dom.setAttribute("data-emdash-plugin-block", "true");
	dom.contentEditable = "false";

	const bar = document.createElement("div");
	bar.className = "emdash-plugin-block-bar";
	// The editor selects the block by its name and drags it from there.
	const handle = document.createElement("span");
	handle.className = "emdash-plugin-block-handle";
	const settings = barButton("Settings", null, () => {
		const pos = getPos();
		if (pos !== undefined) options.openSettings?.(pos);
	});
	const up = barButton("", ICON_UP, () => moveBlock(-1));
	const down = barButton("", ICON_DOWN, () => moveBlock(1));
	const remove = barButton("", ICON_TRASH, () => {
		const pos = getPos();
		if (pos === undefined) return;
		editor
			.chain()
			.focus()
			.deleteRange({ from: pos, to: pos + node.nodeSize })
			.run();
	});
	remove.dataset.danger = "";
	bar.append(handle, settings, up, down, remove);

	const body = document.createElement("div");
	body.className = "emdash-plugin-block-body";
	// The block's own pictures and text drag nowhere: the editor moves the block from its name.
	body.addEventListener("dragstart", (event) => event.preventDefault());
	dom.append(bar, body);

	/** Swaps the block with the one before or after it among its siblings. */
	function moveBlock(by: -1 | 1) {
		const pos = getPos();
		if (pos === undefined) return;
		const { state } = editor;
		const $pos = state.doc.resolve(pos);
		const sibling = $pos.parent.maybeChild($pos.index() + by);
		if (!sibling) return;
		const to = by < 0 ? pos - sibling.nodeSize : pos + sibling.nodeSize;
		const tr = state.tr.delete(pos, pos + node.nodeSize).insert(to, node);
		tr.setSelection(NodeSelection.create(tr.doc, to));
		editor.view.dispatch(tr.scrollIntoView());
	}

	let shown: { key: string; preview: boolean; label: string } | null = null;
	function render() {
		const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "";
		const definition = options.definition(blockType);
		const label = definition?.label ?? blockLabel(blockType);
		dom.setAttribute("data-block-type", blockType);
		handle.textContent = label;
		settings.hidden = !definition || !options.openSettings;
		settings.setAttribute("aria-label", `${label} settings`);
		up.setAttribute("aria-label", `Move ${label} up`);
		down.setAttribute("aria-label", `Move ${label} down`);
		remove.setAttribute("aria-label", `Delete ${label}`);

		const key = pluginBlockKeyFromAttrs(node.attrs);
		const preview = findBlockPreview(key);
		if (!preview && shown && shown.key !== key && options.redrawing()) {
			// What it was stays until the page has drawn what it is.
			dom.setAttribute("data-redrawing", "");
			return;
		}
		dom.removeAttribute("data-redrawing");
		if (shown?.key === key && shown.preview === !!preview && (preview || shown.label === label)) {
			return;
		}
		dom.className = `emdash-plugin-block ${preview ? "emdash-plugin-block-preview" : "emdash-plugin-block-placeholder"}`;
		body.replaceChildren(preview ? renderBlockPreview(preview) : blockSlot(node.attrs, label));
		shown = { key, preview: !!preview, label };
	}
	render();
	document.addEventListener(BLOCK_PREVIEWS_EVENT, render);

	return {
		dom,
		update(next) {
			if (next.type !== node.type) return false;
			node = next;
			render();
			return true;
		},
		// The preview is the page's own markup, running; nothing in it is document content.
		ignoreMutation: () => true,
		// The block's controls and content take their own events. Its name is where the editor
		// selects and drags it from.
		stopEvent(event) {
			const target = event.target;
			if (!(target instanceof Element) || target.closest(".emdash-plugin-block-handle")) {
				return false;
			}
			return target.closest(".emdash-plugin-block-bar, .emdash-plugin-block-body") !== null;
		},
		destroy() {
			document.removeEventListener(BLOCK_PREVIEWS_EVENT, render);
		},
	};
}

const ICON_UP = "M12 19V5m-7 7 7-7 7 7";
const ICON_DOWN = "M12 5v14m7-7-7 7-7-7";
const ICON_TRASH = "M4 7h16m-10 4v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3";

function barButton(text: string, icon: string | null, onClick: () => void): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	if (icon) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", icon);
		svg.append(path);
		button.append(svg);
		button.dataset.icon = "";
	} else {
		button.textContent = text;
	}
	button.addEventListener("click", onClick);
	return button;
}

/** A block type's name when the admin manifest has none for it. */
function blockLabel(blockType: string): string {
	return blockType ? blockType.charAt(0).toUpperCase() + blockType.slice(1) : "Block";
}

/** A block the page drew nothing for: its name and what it is set to, as the admin shows it. */
function blockSlot(attrs: Record<string, unknown>, label: string): HTMLElement {
	const slot = document.createElement("div");
	slot.className = "emdash-plugin-block-slot";
	const name = document.createElement("strong");
	name.textContent = label;
	const detail = document.createElement("span");
	const id = typeof attrs.id === "string" ? attrs.id : "";
	const data = attrs.data && typeof attrs.data === "object" ? Object.values(attrs.data) : [];
	detail.textContent =
		id ||
		data
			.filter(
				(value): value is string | number =>
					(typeof value === "string" && value.length > 0) ||
					(typeof value === "number" && Number.isFinite(value)),
			)
			.map(String)
			.join(", ") ||
		"Nothing set yet";
	slot.append(name, detail);
	return slot;
}

/** The page's preview for a block, if it rendered one (`BlockPreview`). */
function findBlockPreview(key: string): HTMLTemplateElement | null {
	if (typeof document === "undefined") return null;
	return document.querySelector<HTMLTemplateElement>(
		`template[data-emdash-block-preview="${key.replace(/["\\]/g, "\\$&")}"]`,
	);
}

/**
 * A block as the page renders it, running as it runs there: its islands hydrate and its scripts
 * run. The markup goes into a shadow root carrying the page's stylesheets, so it looks as it does
 * on the page and the editor's own text styles (a `.prose h2` rule, say) cannot restyle it. A part
 * marked `data-emdash-in-document` stays in the document, drawn in its place through a slot, for a
 * script that looks for it there. Its links and forms stay put while editing, as links in the
 * text do.
 */
function renderBlockPreview(preview: HTMLTemplateElement): HTMLElement {
	const host = document.createElement("div");
	host.className = "emdash-plugin-block-content";
	const shadow = host.attachShadow({ mode: "open" });
	for (const sheet of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
		shadow.append(sheet.cloneNode(true));
	}
	const content = document.importNode(preview.content, true);
	// A script DOMParser read, as a redrawn block's are, is marked as already run, and so is a copy
	// of it. A new script element runs, as the page's did.
	for (const parsed of content.querySelectorAll("script")) {
		const script = document.createElement("script");
		for (const { name, value } of parsed.attributes) script.setAttribute(name, value);
		script.textContent = parsed.textContent;
		parsed.replaceWith(script);
	}
	// A third-party embed's script finds its element or its frame through `document`, which does
	// not reach into a shadow root.
	let parts = 0;
	for (const part of content.querySelectorAll("[data-emdash-in-document]")) {
		const slot = document.createElement("slot");
		slot.name = `in-document-${++parts}`;
		part.replaceWith(slot);
		part.slot = slot.name;
		host.append(part);
	}
	shadow.append(content);
	shadow.addEventListener("click", (event) => {
		if (event.target instanceof Element && event.target.closest("a[href]")) event.preventDefault();
	});
	shadow.addEventListener("submit", (event) => event.preventDefault());
	return host;
}

/**
 * Fetches the page as the editor's last save left it, which edit mode renders from the draft, for
 * the previews of blocks that changed, and keeps them beside the page's own.
 */
async function fetchBlockPreviews(): Promise<void> {
	const res = await fetch(location.href, {
		credentials: "same-origin",
		cache: "no-store",
		headers: { Accept: "text/html" },
	});
	if (!res.ok) return;
	const page = new DOMParser().parseFromString(await res.text(), "text/html");
	for (const template of page.querySelectorAll<HTMLTemplateElement>(
		"template[data-emdash-block-preview]",
	)) {
		const key = template.getAttribute("data-emdash-block-preview");
		if (key && !findBlockPreview(key)) document.body.append(document.importNode(template, true));
	}
}

/**
 * Puts a new plugin block where its slash command was typed: in place of the line, when the
 * command left it empty, or after it.
 */
function insertPluginBlock(
	editor: TiptapEditor,
	at: number,
	attrs: Record<string, unknown>,
): boolean {
	const content = { type: "pluginBlock", attrs };
	const $at = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size));
	if ($at.depth === 0) return editor.chain().insertContentAt(at, content).run();
	const line = $at.parent;
	const where =
		line.isTextblock && line.content.size === 0
			? { from: $at.before(), to: $at.after() }
			: $at.after();
	return editor.chain().insertContentAt(where, content).run();
}

// ── Component ──────────────────────────────────────────────────────

export interface InlinePortableTextEditorProps {
	value: PTBlock[];
	collection: string;
	entryId: string;
	field: string;
	tablePlaceholder?: string;
}

export function InlinePortableTextEditor({
	value,
	collection,
	entryId,
	field,
	tablePlaceholder = TableBlockNode.options.placeholder,
}: InlinePortableTextEditorProps) {
	const initialRef = React.useRef(value);
	// The editor document last known to be stored: the one the loaded content
	// produced, then the one each successful save sent. `save()` does nothing
	// while the current document is structurally equal to it (`Node.eq`).
	const savedDocRef = React.useRef<Editor["state"]["doc"] | null>(null);
	const savingRef = React.useRef(false);
	// The save in flight, which a save that must not be skipped waits for.
	const pendingSaveRef = React.useRef<Promise<void>>(Promise.resolve());
	const editorRef = React.useRef<ReturnType<typeof useEditor>>(null);

	// Where the image picker that `/image` opened will put the image.
	const [imagePickerAt, setImagePickerAt] = React.useState<number | null>(null);
	const [unsupportedFileGuidance, setUnsupportedFileGuidance] = React.useState<{
		message: string;
		version: number;
	} | null>(null);
	const showUnsupportedFileGuidance = React.useCallback(() => {
		const locale = document.documentElement.lang || navigator.language;
		setUnsupportedFileGuidance((current) => ({
			message: getUnsupportedFileGuidance(locale),
			version: (current?.version ?? 0) + 1,
		}));
	}, []);
	const unsupportedFileHandlers = React.useMemo(
		() => createUnsupportedFileHandlers(showUnsupportedFileGuidance),
		[showUnsupportedFileGuidance],
	);

	const uiRoot = useInlineUiRoot();

	// The Suggestion plugin's key handlers read the slash menu's state as soon
	// as it changes, before React commits it, so the ref takes each change
	// synchronously and the extension, created once, reads the ref.
	const [slashMenuState, setSlashMenuStateRaw] =
		React.useState<SlashMenuState>(initialSlashMenuState);
	const slashMenuStateRef = React.useRef(slashMenuState);
	const setSlashMenuState: React.Dispatch<React.SetStateAction<SlashMenuState>> = React.useCallback(
		(action) => {
			const next = typeof action === "function" ? action(slashMenuStateRef.current) : action;
			slashMenuStateRef.current = next;
			setSlashMenuStateRaw(next);
		},
		[],
	);
	const slashMenuActionsRef = React.useRef({
		run: (_item: SlashCommandItem) => {},
		dismiss: () => {},
	});

	const [loadState] = React.useState<{
		content: JSONContent;
		error: UnsupportedPortableTextMarksError | null;
	}>(() => {
		try {
			return { content: portableTextToPM(value || []), error: null };
		} catch (error) {
			if (error instanceof UnsupportedPortableTextMarksError) {
				return {
					content: { type: "doc", content: [{ type: "paragraph" }] },
					error,
				};
			}
			throw error;
		}
	});

	const initialContent = loadState.content;
	const loadError = loadState.error;
	const [saveError, setSaveError] = React.useState<string | null>(null);

	const getBlocks = React.useCallback((): PTBlock[] => {
		const editor = editorRef.current;
		if (!editor) return initialRef.current;
		const json: unknown = editor.getJSON();
		if (!isProseMirrorDocument(json)) return initialRef.current;
		assertProseMirrorMarksSupported(json);
		return pmToPortableText(json);
	}, []);

	const save = React.useCallback(
		async (options?: { keepalive?: boolean }) => {
			// A pagehide flush must not be skipped: an in-flight blur save is
			// cancelled by the navigation, so the keepalive request is the only
			// one that can still land.
			if (loadError) return;
			if (savingRef.current && !options?.keepalive) return;

			const doc = editorRef.current?.state.doc;
			if (!doc || !savedDocRef.current || doc.eq(savedDocRef.current)) return;

			savingRef.current = true;
			let settle = () => {};
			const done = new Promise<void>((resolve) => {
				settle = () => resolve();
			});
			pendingSaveRef.current = done;
			// The visual-editing toolbar holds Publish until `done` settles.
			document.dispatchEvent(new CustomEvent("emdash:save-pending", { detail: { done } }));
			try {
				const blocks = getBlocks();
				const res = await fetch(
					`/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}`,
					{
						method: "PUT",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
						body: JSON.stringify({ data: { [field]: blocks }, skipRevision: true }),
						keepalive: options?.keepalive ?? false,
					},
				);

				if (res.ok) {
					setSaveError(null);
					initialRef.current = blocks;
					savedDocRef.current = doc;
					document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "saved" } }));
					document.dispatchEvent(
						new CustomEvent("emdash:content-changed", {
							detail: { collection, id: entryId },
						}),
					);
				} else {
					setSaveError(`Save failed: ${res.status}`);
					document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
					console.error("Save failed:", res.status);
				}
			} catch (err) {
				setSaveError(
					err instanceof UnsupportedPortableTextMarksError
						? `Save failed: unsupported formatting (${err.marks.join(", ")}).`
						: "Save failed. Please try again.",
				);
				document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
				console.error("Save failed:", err);
			} finally {
				savingRef.current = false;
				settle();
			}
		},
		[collection, entryId, field, getBlocks, loadError],
	);

	/** Saves now, after any save in flight, which may have started before the latest change. */
	const saveNow = React.useCallback(async () => {
		while (savingRef.current) await pendingSaveRef.current;
		await save();
	}, [save]);

	// Flush unsaved edits when the page goes away (browser back/forward,
	// link click, tab close). The blur handler doesn't cover this: unload
	// doesn't reliably fire React blur, and a plain fetch started during
	// unload is cancelled by the navigation — edits were silently lost.
	// `keepalive` lets the PUT outlive the page.
	// Caveat: keepalive caps the body at 64KB — a very long document
	// can still be lost on unload. Upgrade path: debounced autosave
	// while typing (like the admin editor) so unload flushes are rare.
	React.useEffect(() => {
		const flush = () => void save({ keepalive: true });
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [save]);

	// Plugin block types, from the admin manifest: the blocks' names and settings, and the slash
	// menu's commands to insert them.
	const [definitions, setDefinitions] = React.useState<Map<string, BlockDefinition> | null>(null);
	const definitionsRef = React.useRef(definitions);
	definitionsRef.current = definitions;
	React.useEffect(() => {
		const controller = new AbortController();
		loadBlockDefinitions(controller.signal).then(setDefinitions, () => {});
		return () => controller.abort();
	}, []);
	React.useEffect(() => {
		if (definitions) document.dispatchEvent(new Event(BLOCK_PREVIEWS_EVENT));
	}, [definitions]);

	const commandsRef = React.useRef(slashCommands);
	commandsRef.current = React.useMemo(
		() => [
			...slashCommands,
			...Array.from(
				definitions?.values() ?? [],
				(definition): SlashCommandItem => ({
					id: `plugin-${definition.pluginId}-${definition.type}`,
					title: definition.label,
					description: definition.description ?? `Embed a ${definition.label}`,
					icon: Cube,
					aliases: [definition.type],
					category: definition.category ?? "Embeds",
					command: ({ editor, range, openBlockSettings }) => {
						editor.chain().deleteRange(range).run();
						openBlockSettings(definition.type);
					},
				}),
			),
		],
		[definitions],
	);

	// The block whose settings are open, or the block a slash command is inserting.
	const [blockSettings, setBlockSettings] = React.useState<{
		definition: BlockDefinition;
		values: Record<string, unknown>;
		/** The block's position, or where the new block goes. */
		at: number;
		inserting: boolean;
	} | null>(null);
	const redrawingRef = React.useRef(false);
	const openSettingsRef = React.useRef((_pos: number) => {});
	openSettingsRef.current = (pos) => {
		const node = editorRef.current?.state.doc.nodeAt(pos);
		if (node?.type.name !== "pluginBlock") return;
		const definition = definitionsRef.current?.get(String(node.attrs.blockType));
		if (!definition) return;
		const { _type, _key, ...stored } = pluginBlockToPortableText(node.attrs);
		setBlockSettings({
			definition,
			values: blockFormValues(definition, stored),
			at: pos,
			inserting: false,
		});
	};

	// Create slash commands extension once — uses refs to avoid re-render loop
	const slashCommandsExtension = React.useMemo(
		() =>
			createSlashCommandsExtension({
				getCommands: () => commandsRef.current,
				onStateChange: setSlashMenuState,
				getState: () => slashMenuStateRef.current,
				onCommand: (item) => slashMenuActionsRef.current.run(item),
				onDismiss: () => slashMenuActionsRef.current.dismiss(),
			}),
		[setSlashMenuState],
	);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				// Replaced with InlineDocument below, which also holds columns blocks.
				document: false,
				dropcursor: { color: "#3b82f6", width: 2 },
				// Replaced with InlineCodeBlockExtension below (adds language picker).
				codeBlock: false,
				// Replaced with CodeMarkExtension so inline code can combine with link/etc.
				code: false,
				orderedList: false,
				// Registered on their own below, so links don't open when clicked.
				link: false,
				underline: false,
			}),
			EmDashOrderedList,
			CodeMarkExtension,
			InlineCodeBlockExtension,
			InlineImageExtension,
			Underline,
			Subscript,
			Superscript,
			Link.configure({
				openOnClick: false,
				// TipTap's Link extension defaults target to "_blank". Without an
				// explicit override it would deep-merge that default in, causing every
				// link created via setLink to serialize as blank: true.
				HTMLAttributes: { target: null, class: "underline text-blue-600 dark:text-blue-400" },
			}),
			Placeholder.configure({
				includeChildren: true,
				placeholder: ({ node }) => {
					if (node.type.name === "paragraph") return "Type / for commands...";
					return "";
				},
			}),
			TextAlign.configure({
				types: ["heading", "paragraph"],
			}),
			Focus.configure({
				className: "has-focus",
				mode: "all",
			}),
			Typography,
			InlineDocument,
			InlineColumns,
			InlineColumn,
			InlineColumnsLayout,
			HtmlBlockNode,
			TableBlockNode.configure({ placeholder: tablePlaceholder }),
			PluginBlockNode.configure({
				definition: (blockType) => definitionsRef.current?.get(blockType),
				openSettings: (pos) => openSettingsRef.current(pos),
				redrawing: () => redrawingRef.current,
			}),
			slashCommandsExtension,
		],
		content: initialContent,
		immediatelyRender: false,
		editorProps: {
			attributes: {
				class: "prose prose-sm sm:prose-base dark:prose-invert max-w-none emdash-inline-editor",
				dir: "auto",
			},
			...unsupportedFileHandlers,
		},
		onUpdate: () => {
			document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "unsaved" } }));
		},
	});

	// Store editor ref for getBlocks, and record the loaded document as saved.
	React.useEffect(() => {
		editorRef.current = editor;
		if (editor && !savedDocRef.current) {
			// TrailingNode adds an empty line after a body that ends in a block,
			// but only on the editor's first transaction, so the first click would
			// count as an edit. Let it add the line before recording the document,
			// without reporting it as an unsaved change or making it undoable.
			editor.view.dispatch(
				editor.state.tr.setMeta("addToHistory", false).setMeta("preventUpdate", true),
			);
			savedDocRef.current = editor.state.doc;
		}
	}, [editor]);

	const runSlashCommand = React.useCallback(
		(item: SlashCommandItem) => {
			const { range } = slashMenuStateRef.current;
			if (!editor || !range) return;
			item.command({
				editor,
				range,
				openImagePicker: () => setImagePickerAt(editor.state.selection.from),
				openBlockSettings: (type) => {
					const definition = definitionsRef.current?.get(type);
					if (!definition) return;
					setBlockSettings({
						definition,
						values: blockFormValues(definition),
						at: editor.state.selection.from,
						inserting: true,
					});
				},
			});
			setSlashMenuState((prev) => ({ ...prev, isOpen: false }));
		},
		[editor, setSlashMenuState],
	);
	/** Closes the slash menu without a command, keeping what was typed. */
	const closeSlashMenu = React.useCallback(() => {
		const { range } = slashMenuStateRef.current;
		setSlashMenuState((prev) => ({
			...prev,
			isOpen: false,
			dismissedSlashFrom: range ? range.from : prev.dismissedSlashFrom,
		}));
		if (editor && range) exitSuggestion(editor.view);
	}, [editor, setSlashMenuState]);
	slashMenuActionsRef.current = { run: runSlashCommand, dismiss: closeSlashMenu };

	// Edits made while the picker is open, as when focus stays in the editor, move the spot it inserts at.
	const pickerOpen = imagePickerAt !== null;
	React.useEffect(() => {
		if (!editor || !pickerOpen) return;
		const onTransaction = ({ transaction }: { transaction: Transaction }) => {
			if (!transaction.docChanged) return;
			setImagePickerAt((at) => (at === null ? at : transaction.mapping.map(at)));
		};
		editor.on("transaction", onTransaction);
		return () => {
			editor.off("transaction", onTransaction);
		};
	}, [editor, pickerOpen]);

	// The image picker opens at the caret the `/image` command left.
	const caretReference = React.useMemo(
		() =>
			editor && imagePickerAt !== null
				? {
						getBoundingClientRect: () => {
							if (editor.isDestroyed) return new DOMRect();
							const { view } = editor;
							const caret = view.coordsAtPos(Math.min(imagePickerAt, view.state.doc.content.size));
							return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
						},
						contextElement: editor.view.dom,
					}
				: null,
		[editor, imagePickerAt],
	);

	// Edits made while a block's settings are open move the block, or where the new one goes.
	const settingsOpen = blockSettings !== null;
	React.useEffect(() => {
		if (!editor || !settingsOpen) return;
		const onTransaction = ({ transaction }: { transaction: Transaction }) => {
			if (!transaction.docChanged) return;
			setBlockSettings((open) => open && { ...open, at: transaction.mapping.map(open.at) });
		};
		editor.on("transaction", onTransaction);
		return () => {
			editor.off("transaction", onTransaction);
		};
	}, [editor, settingsOpen]);

	/**
	 * Puts a block's settings into the document, saves, and fetches the page as it now renders for
	 * the block's new preview. Until it arrives the block shows as it was.
	 */
	const applyBlockSettings = React.useCallback(
		async (values: Record<string, unknown>) => {
			if (!editor || !blockSettings) return;
			const { definition, at, inserting } = blockSettings;
			const attrs = pluginBlockAttrs({ ...values, _type: definition.type });
			setBlockSettings(null);
			redrawingRef.current = true;
			const applied = inserting
				? insertPluginBlock(editor, at, attrs)
				: editor
						.chain()
						.command(({ tr }) => {
							if (tr.doc.nodeAt(at)?.type.name !== "pluginBlock") return false;
							tr.setNodeMarkup(at, undefined, attrs);
							return true;
						})
						.run();
			try {
				if (applied) {
					await saveNow();
					await fetchBlockPreviews();
				}
			} catch (error) {
				console.error("Couldn't redraw the block:", error);
			} finally {
				redrawingRef.current = false;
				document.dispatchEvent(new Event(BLOCK_PREVIEWS_EVENT));
			}
		},
		[editor, blockSettings, saveNow],
	);

	// Save on blur — but not when interacting with slash menu or image picker
	const handleBlur = React.useCallback(
		(e: React.FocusEvent<HTMLDivElement>) => {
			const related = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
			if (related && e.currentTarget.contains(related)) return;
			// The copy fallback briefly moves focus to its textarea before restoring the editor.
			if (related?.hasAttribute("data-emdash-clipboard-fallback")) return;
			// The toolbars, menus, and image picker live in a root of their own at the end of the page.
			if (related && uiRoot?.contains(related)) return;
			// A toolbar button keeps focus in the editor, so the toolbars skip
			// the editor's next blur; telling them again lets them hide. It waits
			// for this blur to finish, which may be a toolbar removing itself.
			const event = e.nativeEvent;
			queueMicrotask(() => {
				if (!editor || editor.isDestroyed || editor.view.hasFocus()) return;
				if (uiRoot?.contains(document.activeElement)) return;
				editor.view.dispatch(editor.state.tr.setMeta("blur", { event }));
			});
			void save();
		},
		[editor, save, uiRoot],
	);

	if (!editor || !uiRoot) return null;

	return (
		<div onBlur={handleBlur}>
			{loadError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					This field can’t be edited here because it contains unsupported Portable Text marks:{" "}
					{loadError.marks.join(", ")}.
				</div>
			) : (
				<>
					<InlineBubbleMenu editor={editor} uiRoot={uiRoot} onImageReplaced={() => void save()} />
					<EditorContent editor={editor} />
				</>
			)}
			{saveError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					{saveError}
				</div>
			) : null}
			{unsupportedFileGuidance ? (
				<div
					key={unsupportedFileGuidance.version}
					className="emdash-inline-editor-guidance"
					role="status"
					aria-live="polite"
					dir="auto"
				>
					{unsupportedFileGuidance.message}
				</div>
			) : null}
			<InlineSlashMenu
				editor={editor}
				uiRoot={uiRoot}
				state={slashMenuState}
				onCommand={runSlashCommand}
				onClose={closeSlashMenu}
				setSelectedIndex={(index) =>
					setSlashMenuState((prev) => ({ ...prev, selectedIndex: index }))
				}
			/>
			{imagePickerAt !== null && caretReference && (
				<InlineMediaPicker
					uiRoot={uiRoot}
					reference={caretReference}
					gap={6}
					label="Insert image"
					onChoose={(image) => {
						insertImage(editor, imagePickerAt, image);
						editor.view.focus();
						setImagePickerAt(null);
						void save();
					}}
					onClose={(reason) => {
						if (reason !== "blur") editor.view.focus();
						setImagePickerAt(null);
					}}
				/>
			)}
			{blockSettings && (
				<InlineBlockSettings
					uiRoot={uiRoot}
					definition={blockSettings.definition}
					values={blockSettings.values}
					inserting={blockSettings.inserting}
					onSubmit={(values) => void applyBlockSettings(values)}
					onClose={() => setBlockSettings(null)}
				/>
			)}
			<style>{`
				.emdash-inline-code-block {
					position: relative;
					margin-block: 1rem;
					--emdash-code-background: var(--emdash-inline-code-background, #f7f7f5);
					--emdash-code-foreground: var(--emdash-inline-code-foreground, #24292f);
					--emdash-code-muted: var(--emdash-inline-code-muted, #57606a);
					--emdash-code-keyword: var(--emdash-inline-code-keyword, #b8172a);
					--emdash-code-string: var(--emdash-inline-code-string, #0a3069);
					--emdash-code-number: var(--emdash-inline-code-number, #0550ae);
					--emdash-code-title: var(--emdash-inline-code-title, #7545c7);
					--emdash-code-border: var(--emdash-inline-code-border, #7d8590);
					--emdash-code-control-background: var(
						--emdash-inline-code-control-background,
						var(--emdash-inline-bg, #ffffff)
					);
					--emdash-code-control-foreground: var(
						--emdash-inline-code-control-foreground,
						#24292f
					);
					--emdash-code-focus: var(--emdash-inline-code-focus, #0550ae);
				}
				.emdash-inline-code-block .emdash-code-block {
					margin: 0;
					padding: 1rem;
					padding-block: 30px !important;
					border: 0 !important;
					border-radius: 0.5rem;
					background: var(--emdash-code-background) !important;
					color: var(--emdash-code-foreground) !important;
					caret-color: var(--emdash-code-foreground) !important;
					overflow-x: auto;
				}
				.emdash-inline-code-block .emdash-code-block code {
					background: transparent !important;
					color: inherit !important;
					font-size: 13px !important;
				}
				.emdash-inline-code-block :is(.hljs-comment, .hljs-quote) {
					color: var(--emdash-code-muted);
				}
				.emdash-inline-code-block
					:is(.hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-section, .hljs-link, .hljs-deletion) {
					color: var(--emdash-code-keyword);
				}
				.emdash-inline-code-block
					:is(.hljs-string, .hljs-attr, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition) {
					color: var(--emdash-code-string);
				}
				.emdash-inline-code-block :is(.hljs-number, .hljs-meta) {
					color: var(--emdash-code-number);
				}
				.emdash-inline-code-block
					:is(.hljs-title, .hljs-name, .hljs-type, .hljs-built_in, .hljs-selector-id, .hljs-selector-class) {
					color: var(--emdash-code-title);
				}
				.emdash-inline-code-block-popover,
				.emdash-inline-code-block-chip {
					box-sizing: border-box;
					border: 1px solid var(--emdash-code-border);
					background: var(--emdash-code-control-background);
					color: var(--emdash-code-control-foreground);
				}
				.emdash-inline-code-block-controls-wrap {
					position: absolute;
					inset-block-start: 0;
					inset-inline-end: 0.25rem;
					z-index: 100;
					max-inline-size: min(calc(100% - 0.25rem), calc(100vw - 1rem));
					opacity: 0;
					pointer-events: none;
					user-select: none;
					transition: opacity 120ms ease-out;
				}
				.emdash-inline-code-block:hover .emdash-inline-code-block-controls-wrap,
				.emdash-inline-code-block:focus-within .emdash-inline-code-block-controls-wrap,
				.emdash-inline-code-block-controls-wrap[data-persistent="true"] {
					opacity: 1;
					pointer-events: auto;
				}
				.emdash-inline-code-block-popover {
					inline-size: min(14rem, 100%, calc(100vw - 1rem));
				}
				.emdash-inline-code-block-language-input {
					min-inline-size: 0;
					flex: 1;
					border: 1px solid var(--emdash-code-border);
					background: transparent;
					color: inherit;
				}
				.emdash-inline-code-block-controls-wrap button:focus-visible,
				.emdash-inline-code-block-language-input:focus-visible {
					outline: 2px solid var(--emdash-code-focus);
					outline-offset: 2px;
				}
				@media (hover: none), (pointer: coarse) {
					.emdash-inline-code-block-controls-wrap {
						opacity: 1;
						pointer-events: auto;
					}
				}
				@media (prefers-reduced-motion: reduce) {
					.emdash-inline-code-block-controls-wrap {
						transition: none;
					}
				}
				@media (prefers-color-scheme: dark) {
					.emdash-inline-code-block {
						--emdash-code-background: var(--emdash-inline-code-background, #202020);
						--emdash-code-foreground: var(--emdash-inline-code-foreground, #f0f3f6);
						--emdash-code-muted: var(--emdash-inline-code-muted, #c9d1d9);
						--emdash-code-keyword: var(--emdash-inline-code-keyword, #ffc1bb);
						--emdash-code-string: var(--emdash-inline-code-string, #b9ddff);
						--emdash-code-number: var(--emdash-inline-code-number, #a8d5ff);
						--emdash-code-title: var(--emdash-inline-code-title, #e5ccff);
						--emdash-code-border: var(--emdash-inline-code-border, #6e7681);
						--emdash-code-control-background: var(
							--emdash-inline-code-control-background,
							var(--emdash-inline-bg, #161b22)
						);
						--emdash-code-control-foreground: var(
							--emdash-inline-code-control-foreground,
							#f0f3f6
						);
						--emdash-code-focus: var(--emdash-inline-code-focus, #a8d5ff);
					}
				}
				.emdash-inline-editor .emdash-slash-query {
					margin-inline: -0.25em;
					padding: 0.125em 0.25em;
					border-radius: 0.375rem;
					background: color-mix(in srgb, currentColor 8%, transparent);
				}
				.emdash-inline-editor .emdash-slash-query.is-empty::after {
					content: "Type to search";
					color: color-mix(in srgb, currentColor 45%, transparent);
					pointer-events: none;
				}
				${INLINE_EDITOR_UI_STYLES}
				${INLINE_MEDIA_PICKER_STYLES}
				${INLINE_BLOCK_SETTINGS_STYLES}
				${INLINE_IMAGE_STYLES}
				${INLINE_COLUMNS_STYLES}
				.emdash-inline-editor:focus {
					outline: none;
				}
				.emdash-inline-editor:focus p.is-editor-empty {
					display: flow-root;
				}
				.emdash-inline-editor:focus p.is-editor-empty::before {
					content: attr(data-placeholder);
					float: inline-start;
					width: 100%;
					margin-inline-end: -100%;
					opacity: 0.5;
					pointer-events: none;
				}
				.emdash-inline-editor-guidance {
					margin-block-start: 0.75rem;
					padding-block: 0.625rem;
					padding-inline: 0.875rem;
					border: 1px solid #bfdbfe;
					border-radius: 0.5rem;
					background: #eff6ff;
					color: #1e3a8a;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					text-align: start;
				}
				.emdash-inline-editor-error {
					margin-block-start: 0.75rem;
					padding-block: 0.625rem;
					padding-inline: 0.875rem;
					border: 1px solid #fecaca;
					border-radius: 0.5rem;
					background: #fef2f2;
					color: #991b1b;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					text-align: start;
				}
				.emdash-plugin-block {
					position: relative;
					user-select: none;
				}
				.emdash-plugin-block.ProseMirror-selectednode {
					outline: 2px solid #2563eb;
					outline-offset: 2px;
				}
				.emdash-plugin-block[data-redrawing] .emdash-plugin-block-body {
					opacity: 0.5;
					transition: opacity 150ms;
				}
				.emdash-plugin-block-placeholder {
					margin: 0.75rem 0;
				}
				.emdash-plugin-block-slot {
					display: flex;
					flex-direction: column;
					gap: 0.125rem;
					padding: 0.75rem 0.875rem;
					padding-inline-end: 16rem;
					border: 1px dashed #d1d5db;
					border-radius: 0.5rem;
					background: #f9fafb;
					color: #4b5563;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					overflow-wrap: anywhere;
				}
				.emdash-plugin-block-slot strong {
					color: #111827;
					font-weight: 600;
				}
				@media (max-width: 40rem) {
					.emdash-plugin-block-slot {
						padding-block-start: 3rem;
						padding-inline-end: 0.875rem;
					}
				}
				.emdash-plugin-block-bar {
					position: absolute;
					top: 0.5rem;
					inset-inline-end: 0.5rem;
					z-index: 2;
					display: flex;
					align-items: center;
					gap: 2px;
					padding: 3px;
					border-radius: 8px;
					background: #ffffff;
					color: #1d2327;
					box-shadow: 0 0 0 1px rgb(0 0 0 / 0.1), 0 4px 6px -1px rgb(0 0 0 / 0.1);
					font: 500 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					opacity: 0;
					transition: opacity 120ms;
				}
				.emdash-plugin-block:hover > .emdash-plugin-block-bar,
				.emdash-plugin-block:focus-within > .emdash-plugin-block-bar,
				.emdash-plugin-block.ProseMirror-selectednode > .emdash-plugin-block-bar {
					opacity: 1;
				}
				@media (hover: none) {
					.emdash-plugin-block-bar {
						opacity: 1;
					}
				}
				.emdash-plugin-block-handle {
					max-width: 16ch;
					padding: 0 8px;
					overflow: hidden;
					color: #646970;
					text-overflow: ellipsis;
					white-space: nowrap;
					cursor: grab;
				}
				.emdash-plugin-block-bar button {
					display: inline-flex;
					height: 28px;
					align-items: center;
					justify-content: center;
					margin: 0;
					padding: 0 8px;
					border: 0;
					border-radius: 6px;
					background: transparent;
					color: inherit;
					font: inherit;
					cursor: pointer;
				}
				.emdash-plugin-block-bar button[hidden] {
					display: none;
				}
				.emdash-plugin-block-bar button[data-icon] {
					width: 28px;
					padding: 0;
				}
				.emdash-plugin-block-bar button[data-danger] {
					color: #b32d2e;
				}
				.emdash-plugin-block-bar button:hover {
					background: #f0f0f1;
				}
				.emdash-plugin-block-bar button:focus-visible {
					outline: 2px solid #2563eb;
					outline-offset: -2px;
				}
				.emdash-plugin-block-bar svg {
					width: 16px;
					height: 16px;
					fill: none;
					stroke: currentColor;
					stroke-width: 2;
					stroke-linecap: round;
					stroke-linejoin: round;
				}
				@media (prefers-color-scheme: dark) {
					.emdash-inline-editor-guidance {
						border-color: #1e40af;
						background: #172554;
						color: #dbeafe;
					}
					.emdash-inline-editor-error {
						border-color: #991b1b;
						background: #450a0a;
						color: #fee2e2;
					}
					.emdash-plugin-block-slot {
						border-color: #374151;
						background: #111827;
						color: #9ca3af;
					}
					.emdash-plugin-block-slot strong {
						color: #f3f4f6;
					}
					.emdash-plugin-block-bar {
						background: #1f2937;
						color: #f3f4f6;
						box-shadow: 0 0 0 1px #374151, 0 4px 6px -1px rgb(0 0 0 / 0.3);
					}
					.emdash-plugin-block-handle {
						color: #9ca3af;
					}
					.emdash-plugin-block-bar button:hover {
						background: #374151;
					}
					.emdash-plugin-block-bar button[data-danger] {
						color: #f87171;
					}
				}
			`}</style>
		</div>
	);
}

// Test-only exports for unit tests.
export { pmToPortableText as _pmToPortableText };
export { portableTextToPM as _portableTextToPM };
export { createUnsupportedFileHandlers as _createUnsupportedFileHandlers };
export { TableBlockNode as _InlineTableBlockNode };
