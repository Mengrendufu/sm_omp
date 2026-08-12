import { getSegmenter, replaceTabs, sliceByColumn, visibleWidth } from "./utils";

export type PaneFocus = "conversation" | "input" | "sidebar";
export type SidebarMode = "visible" | "hidden" | "overlay";

export interface PaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PanesViewportOptions {
	sidebarWidth: number;
	minLeftWidth: number;
	narrowWidth: number;
	inputMaxHeight?: number;
	focusIndicator?: string;
	borderStyle?: (text: string, pane: PaneFocus, focused: boolean) => string;
	focusIndicatorStyle?: (text: string, pane: PaneFocus, focused: boolean) => string;
	contentStyle?: (text: string, pane: PaneFocus, focused: boolean) => string;
	selectionStyle?: (text: string) => string;
	onFocusChange?: (focus: PaneFocus) => void;
}

export interface PanesContent {
	conversation: readonly string[];
	input: readonly string[];
	sidebar: readonly string[];
}

export interface PanesFrame {
	lines: string[];
	regions: Record<PaneFocus, PaneRect | undefined>;
	sidebarMode: SidebarMode;
}

export interface PaneContentWidths {
	conversation: number;
	input: number;
	sidebar: number;
}

export interface PaneScrollInfo {
	following: boolean;
	linesBelow: number;
	linesAbove: number;
}

interface PanePoint {
	col: number;
	row: number;
}

interface PaneSelection {
	pane: PaneFocus;
	anchor: PanePoint;
	focus: PanePoint;
	dragged: boolean;
}

class RowViewport {
	#scrollTop = 0;
	#following = true;
	#maxScroll = 0;
	#height = 0;

	compose(rows: readonly string[], height: number): string[] {
		this.#height = Math.max(0, height);
		this.#maxScroll = Math.max(0, rows.length - this.#height);
		if (this.#following) this.#scrollTop = this.#maxScroll;
		else this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, this.#maxScroll));
		const visible = rows.slice(this.#scrollTop, this.#scrollTop + this.#height);
		while (visible.length < this.#height) visible.push("");
		return visible;
	}

	scrollBy(delta: number): void {
		const base = this.#following ? this.#maxScroll : this.#scrollTop;
		this.#scrollTop = Math.max(0, Math.min(base + delta, this.#maxScroll));
		this.#following = this.#scrollTop >= this.#maxScroll;
	}

	scrollToTop(): void {
		this.#scrollTop = 0;
		this.#following = this.#maxScroll === 0;
	}

	scrollToBottom(): void {
		this.#scrollTop = this.#maxScroll;
		this.#following = true;
	}

	pageSize(): number {
		return Math.max(1, this.#height - 1);
	}

	halfPageSize(): number {
		return Math.max(1, Math.floor(this.#height / 2));
	}

	info(): PaneScrollInfo {
		return {
			following: this.#following,
			linesBelow: Math.max(0, this.#maxScroll - this.#scrollTop),
			linesAbove: this.#scrollTop,
		};
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function sameRect(left: PaneRect | undefined, right: PaneRect | undefined): boolean {
	return (
		left?.x === right?.x && left?.y === right?.y && left?.width === right?.width && left?.height === right?.height
	);
}

function fitRow(line: string, width: number): string {
	if (width <= 0) return "";
	const fitted = sliceByColumn(replaceTabs(line), 0, width, true);
	const row = fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	// Pane slices are concatenated before the TUI's whole-row terminator. Bound
	// any SGR carried by clipped tool output so its background cannot leak into
	// the adjoining pane or survive there until a later repaint overwrites it.
	return line.includes("\x1b") ? `\x1b[0m${row}\x1b[0m` : row;
}

const SGR_SEQUENCE = /\x1b\[[0-?]*[ -/]*m/g;
// Apply the overlay after each embedded SGR so source resets and background
// colors cannot cancel the selection before its visible text is painted.

function styleTextRuns(text: string, style: (text: string) => string): string {
	let result = "";
	let start = 0;
	for (const match of text.matchAll(SGR_SEQUENCE)) {
		const index = match.index;
		if (index > start) result += style(text.slice(start, index));
		result += match[0];
		start = index + match[0].length;
	}
	return start < text.length ? result + style(text.slice(start)) : result;
}

export class PanesViewport {
	readonly #options: PanesViewportOptions;
	readonly #conversation = new RowViewport();
	readonly #sidebar = new RowViewport();
	#focus: PaneFocus = "input";
	#sidebarHidden = false;
	#sidebarOverlayOpen = false;
	#overlayPreviousFocus: PaneFocus = "input";
	#lastNarrow = false;
	#lastSidebarMode: SidebarMode = "visible";
	#regions: Record<PaneFocus, PaneRect | undefined> = {
		conversation: undefined,
		input: undefined,
		sidebar: undefined,
	};
	#selection: PaneSelection | undefined;
	#selectionFrame: readonly string[] = [];
	#sidebarStatus: string | undefined;

	constructor(options: PanesViewportOptions) {
		this.#options = options;
		options.onFocusChange?.(this.#focus);
	}

	contentWidths(width: number): PaneContentWidths {
		const { frameWidth, leftWidth, sidebarWidth, sidebarMode } = this.#horizontalLayout(width);
		this.#lastSidebarMode = sidebarMode;
		return {
			conversation: Math.max(1, leftWidth),
			input: Math.max(1, frameWidth),
			sidebar: Math.max(1, sidebarWidth - 2),
		};
	}

	#horizontalLayout(width: number): {
		frameWidth: number;
		leftWidth: number;
		sidebarWidth: number;
		sidebarMode: SidebarMode;
	} {
		const frameWidth = Math.max(1, Math.trunc(width));
		const minimumLeftWidth = Math.max(1, Math.trunc(this.#options.minLeftWidth));
		this.#lastNarrow = frameWidth < Math.max(Math.trunc(this.#options.narrowWidth), minimumLeftWidth + 3);
		const sidebarMode: SidebarMode = this.#lastNarrow
			? this.#sidebarOverlayOpen
				? "overlay"
				: "hidden"
			: this.#sidebarHidden
				? "hidden"
				: "visible";
		const minimumSidebarWidth = Math.min(3, frameWidth);
		const sidebarWidth = Math.min(
			frameWidth,
			clamp(
				Math.trunc(this.#options.sidebarWidth),
				minimumSidebarWidth,
				Math.max(minimumSidebarWidth, frameWidth - minimumLeftWidth),
			),
		);
		const leftWidth = sidebarMode === "visible" ? frameWidth - sidebarWidth : frameWidth;
		return { frameWidth, leftWidth, sidebarWidth, sidebarMode };
	}

	composeFrame(content: PanesContent, width: number, height: number): PanesFrame {
		const { frameWidth, leftWidth, sidebarWidth, sidebarMode } = this.#horizontalLayout(width);
		this.#lastSidebarMode = sidebarMode;
		const frameHeight = Math.max(0, Math.trunc(height));
		const inputMaxHeight = Math.max(3, Math.trunc(this.#options.inputMaxHeight ?? 12));
		const minimumInputHeight = Math.min(3, frameHeight);
		const maximumInputHeight = Math.min(
			frameHeight,
			Math.max(minimumInputHeight, Math.min(inputMaxHeight, frameHeight - 3)),
		);
		const inputHeight = clamp(content.input.length, minimumInputHeight, maximumInputHeight);
		const conversationHeight = Math.max(0, frameHeight - inputHeight);
		const conversationRect: PaneRect = { x: 0, y: 0, width: leftWidth, height: conversationHeight };
		const inputRect: PaneRect = { x: 0, y: conversationHeight, width: frameWidth, height: inputHeight };
		const sidebarRect: PaneRect | undefined =
			sidebarMode === "hidden"
				? undefined
				: { x: frameWidth - sidebarWidth, y: 0, width: sidebarWidth, height: conversationHeight };
		const nextRegions = { conversation: conversationRect, input: inputRect, sidebar: sidebarRect };
		if (this.#selection && !sameRect(this.#regions[this.#selection.pane], nextRegions[this.#selection.pane])) {
			this.#selection = undefined;
		}
		this.#regions = nextRegions;

		let conversationLines = this.#renderConversation(content.conversation, conversationRect).map(line =>
			fitRow(line, leftWidth),
		);
		if (sidebarRect) {
			const sidebarLines = this.#renderSidebar(content.sidebar, sidebarRect);
			if (sidebarMode === "visible") {
				conversationLines = conversationLines.map(
					(line, index) => fitRow(line, leftWidth) + fitRow(sidebarLines[index] ?? "", sidebarWidth),
				);
			} else {
				conversationLines = conversationLines.map((line, index) => {
					const left = sliceByColumn(fitRow(line, frameWidth), 0, sidebarRect.x, true);
					return fitRow(left, sidebarRect.x) + fitRow(sidebarLines[index] ?? "", sidebarWidth);
				});
			}
		}

		const inputLines = this.#renderInputPane(content.input, inputRect);
		const lines = [...conversationLines, ...inputLines].slice(0, frameHeight).map(line => fitRow(line, frameWidth));
		while (lines.length < frameHeight) lines.push(" ".repeat(frameWidth));

		return {
			lines,
			regions: { conversation: conversationRect, input: inputRect, sidebar: sidebarRect },
			sidebarMode,
		};
	}

	beginSelection(col: number, row: number): boolean {
		const pane = this.#paneAt(col, row);
		if (!pane) {
			this.#selection = undefined;
			return false;
		}
		const anchor = this.#clampToPane(pane, col, row);
		this.#selection = { pane, anchor, focus: anchor, dragged: false };
		return true;
	}

	updateSelection(col: number, row: number): boolean {
		const selection = this.#selection;
		if (!selection) return false;
		const focus = this.#clampToPane(selection.pane, col, row);
		selection.focus = focus;
		selection.dragged ||= focus.col !== selection.anchor.col || focus.row !== selection.anchor.row;
		return true;
	}

	finishSelection(col: number, row: number): string | undefined {
		const selection = this.#selection;
		if (!selection) return undefined;
		this.updateSelection(col, row);
		const text = selection.dragged ? this.#selectedText(selection) : "";
		this.#selection = undefined;
		return text.length > 0 ? text : undefined;
	}

	renderSelection(lines: readonly string[]): string[] {
		const selection = this.#selection;
		const previousText = selection && this.#selectionFrame.length > 0 ? this.#selectedText(selection) : undefined;
		this.#selectionFrame = [...lines];
		if (selection && previousText !== undefined && this.#selectedText(selection) !== previousText) {
			this.#selection = undefined;
			return [...lines];
		}
		if (!selection || !this.#regions[selection.pane]) return [...lines];
		const [start, end] = this.#orderedSelection(selection);
		const style = this.#options.selectionStyle ?? (text => `\x1b[7m${text}\x1b[27m`);
		return lines.map((line, row) => {
			if (row < start.row || row > end.row) return line;
			const rect = this.#regions[selection.pane]!;
			const requestedStart = row === start.row ? start.col : rect.x;
			const requestedEnd = row === end.row ? end.col + 1 : rect.x + rect.width;
			const plain = Bun.stripANSI(line);
			const range = this.#snapRangeToGraphemes(plain, requestedStart, requestedEnd);
			if (!range) return line;
			const totalWidth = visibleWidth(line);
			const before = sliceByColumn(line, 0, range.start, true);
			const selected = sliceByColumn(line, range.start, range.end - range.start, true);
			const after = sliceByColumn(line, range.end, Math.max(0, totalWidth - range.end), true);
			return before + styleTextRuns(selected, style) + after;
		});
	}

	clearSelection(): boolean {
		if (!this.#selection) return false;
		this.#selection = undefined;
		return true;
	}

	setSidebarStatus(status: string | undefined): boolean {
		const next = status?.replace(/[\r\n]+/g, " ") || undefined;
		if (this.#sidebarStatus === next) return false;
		this.#sidebarStatus = next;
		return true;
	}

	#paneAt(col: number, row: number): PaneFocus | undefined {
		for (const pane of ["input", "sidebar", "conversation"] as const) {
			const rect = this.#regions[pane];
			if (
				rect &&
				rect.width > 0 &&
				rect.height > 0 &&
				col >= rect.x &&
				col < rect.x + rect.width &&
				row >= rect.y &&
				row < rect.y + rect.height
			) {
				return pane;
			}
		}
		return undefined;
	}

	#clampToPane(pane: PaneFocus, col: number, row: number): PanePoint {
		const rect = this.#regions[pane];
		if (!rect || rect.width <= 0 || rect.height <= 0) return { col, row };
		return {
			col: clamp(col, rect.x, rect.x + rect.width - 1),
			row: clamp(row, rect.y, rect.y + rect.height - 1),
		};
	}

	#orderedSelection(selection: PaneSelection): [PanePoint, PanePoint] {
		const anchorFirst =
			selection.anchor.row < selection.focus.row ||
			(selection.anchor.row === selection.focus.row && selection.anchor.col <= selection.focus.col);
		return anchorFirst ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor];
	}

	#selectedText(selection: PaneSelection): string {
		const rect = this.#regions[selection.pane];
		if (!rect) return "";
		const [start, end] = this.#orderedSelection(selection);
		const rows: string[] = [];
		for (let row = start.row; row <= end.row; row++) {
			const requestedStart = row === start.row ? start.col : rect.x;
			const requestedEnd = row === end.row ? end.col + 1 : rect.x + rect.width;
			const plain = Bun.stripANSI(this.#selectionFrame[row] ?? "");
			const range = this.#snapRangeToGraphemes(plain, requestedStart, requestedEnd);
			rows.push(range ? sliceByColumn(plain, range.start, range.end - range.start, true).trimEnd() : "");
		}
		return rows.join("\n");
	}

	#snapRangeToGraphemes(line: string, start: number, end: number): { start: number; end: number } | undefined {
		let col = 0;
		let snappedStart: number | undefined;
		let snappedEnd: number | undefined;
		for (const { segment } of getSegmenter().segment(line)) {
			const width = visibleWidth(segment);
			const next = col + width;
			if (next > start && col < end) {
				snappedStart ??= col;
				snappedEnd = next;
			} else if (col >= end) {
				break;
			}
			col = next;
		}
		return snappedStart === undefined || snappedEnd === undefined
			? undefined
			: { start: snappedStart, end: snappedEnd };
	}

	#renderConversation(rows: readonly string[], rect: PaneRect): string[] {
		if (rect.height <= 0) return [];
		const contentHeight = Math.max(0, rect.height - 1);
		const visible = this.#conversation.compose(rows, contentHeight);
		const focused = this.#focus === "conversation";
		const styleContent = (text: string) => this.#options.contentStyle?.(text, "conversation", focused) ?? text;
		const result = visible.map(row => fitRow(styleContent(row), rect.width));
		result.push(this.#bottomBorder("conversation", rect.width));
		return result.slice(0, rect.height);
	}

	#renderSidebar(rows: readonly string[], rect: PaneRect): string[] {
		if (rect.height <= 0) return [];
		const innerWidth = Math.max(0, rect.width - 2);
		const innerHeight = Math.max(0, rect.height - 2);
		const visible = this.#sidebar.compose(rows, innerHeight);
		const focused = this.#focus === "sidebar";
		const styleBorder = (text: string) => this.#options.borderStyle?.(text, "sidebar", focused) ?? text;
		const styleContent = (text: string) => this.#options.contentStyle?.(text, "sidebar", focused) ?? text;
		if (rect.width < 2) return visible.slice(0, rect.height).map(row => fitRow(styleContent(row), rect.width));
		const result = [styleBorder(`╭${"─".repeat(innerWidth)}╮`)];
		const status = this.#sidebarStatus;
		const statusRow =
			status === undefined
				? undefined
				: `${" ".repeat(Math.max(0, Math.floor((innerWidth - visibleWidth(status)) / 2)))}${status}`;
		for (let index = 0; index < Math.max(0, rect.height - 2); index++) {
			const row =
				statusRow !== undefined && index === innerHeight - 1 ? statusRow : styleContent(visible[index] ?? "");
			result.push(`${styleBorder("│")}${fitRow(row, innerWidth)}${styleBorder("│")}`);
		}
		if (rect.height > 1) result.push(this.#bottomBorder("sidebar", rect.width));
		return result.slice(0, rect.height);
	}

	#renderInputPane(rows: readonly string[], rect: PaneRect): string[] {
		const visible = rows.slice(Math.max(0, rows.length - rect.height));
		while (visible.length < rect.height) visible.push("");
		const focused = this.#focus === "input";
		const styleContent = (text: string) => this.#options.contentStyle?.(text, "input", focused) ?? text;
		return visible.map(row => fitRow(styleContent(row), rect.width));
	}

	#bottomBorder(pane: "conversation" | "sidebar", width: number): string {
		if (width <= 0) return "";
		const focused = this.#focus === pane;
		const styleBorder = (text: string) => this.#options.borderStyle?.(text, pane, focused) ?? text;
		if (width === 1) return styleBorder("─");
		const innerWidth = width - 2;
		const indicator = this.#options.focusIndicator ?? "";
		const indicatorWidth = visibleWidth(indicator);
		if (!indicator || indicatorWidth > innerWidth) return styleBorder(`╰${"─".repeat(innerWidth)}╯`);
		const styledIndicator = this.#options.focusIndicatorStyle?.(indicator, pane, focused) ?? indicator;
		const labelWidth = indicatorWidth;
		const styledLabel = styledIndicator;
		if (innerWidth >= labelWidth + 4) {
			const rightRuleWidth = innerWidth - labelWidth - 3;
			return styleBorder("╰─ ") + styledLabel + styleBorder(` ${"─".repeat(rightRuleWidth)}╯`);
		}
		if (innerWidth >= labelWidth + 2) {
			const rightRuleWidth = innerWidth - labelWidth - 2;
			return styleBorder("╰ ") + styledLabel + styleBorder(` ${"─".repeat(rightRuleWidth)}╯`);
		}
		return styleBorder("╰") + styledLabel + styleBorder(`${"─".repeat(innerWidth - labelWidth)}╯`);
	}

	#changeFocus(focus: PaneFocus): void {
		if (this.#focus === focus) return;
		this.#focus = focus;
		this.#options.onFocusChange?.(focus);
	}

	setFocus(focus: PaneFocus): void {
		if (focus === "sidebar" && this.#lastNarrow && !this.#sidebarOverlayOpen) return;
		this.#changeFocus(focus);
	}

	focus(): PaneFocus {
		return this.#focus;
	}

	sidebarMode(): SidebarMode {
		return this.#lastSidebarMode;
	}

	scrollBy(pane: "conversation" | "sidebar", delta: number): void {
		this.clearSelection();
		(pane === "conversation" ? this.#conversation : this.#sidebar).scrollBy(delta);
	}

	scrollPage(pane: "conversation" | "sidebar", direction: -1 | 1): void {
		this.clearSelection();
		const viewport = pane === "conversation" ? this.#conversation : this.#sidebar;
		viewport.scrollBy(direction * viewport.pageSize());
	}

	scrollHalfPage(pane: "conversation" | "sidebar", direction: -1 | 1): void {
		this.clearSelection();
		const viewport = pane === "conversation" ? this.#conversation : this.#sidebar;
		viewport.scrollBy(direction * viewport.halfPageSize());
	}

	scrollToTop(pane: "conversation" | "sidebar"): void {
		this.clearSelection();
		(pane === "conversation" ? this.#conversation : this.#sidebar).scrollToTop();
	}

	scrollToBottom(pane: "conversation" | "sidebar"): void {
		this.clearSelection();
		(pane === "conversation" ? this.#conversation : this.#sidebar).scrollToBottom();
	}

	scrollInfo(pane: "conversation" | "sidebar"): PaneScrollInfo {
		return (pane === "conversation" ? this.#conversation : this.#sidebar).info();
	}

	toggleSidebar(): void {
		this.clearSelection();
		if (this.#lastNarrow) {
			if (this.#sidebarOverlayOpen) {
				this.closeSidebarOverlay();
				return;
			}
			this.#overlayPreviousFocus = this.#focus;
			this.#sidebarOverlayOpen = true;
			this.#changeFocus("sidebar");
			return;
		}
		this.#sidebarHidden = !this.#sidebarHidden;
		if (this.#sidebarHidden && this.#focus === "sidebar") this.#changeFocus("input");
		else if (!this.#sidebarHidden) this.#changeFocus("sidebar");
	}

	closeSidebarOverlay(): boolean {
		if (!this.#sidebarOverlayOpen) return false;
		this.clearSelection();
		this.#sidebarOverlayOpen = false;
		this.#changeFocus(this.#overlayPreviousFocus);
		return true;
	}
}
