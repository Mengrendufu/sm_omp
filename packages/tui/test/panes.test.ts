import { describe, expect, it, vi } from "bun:test";
import { PanesViewport } from "../src/panes";
import { type Component, Container, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class PaneTestComponent implements Component {
	inputs: string[] = [];

	constructor(readonly lines: string[]) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}
describe("PanesViewport", () => {
	it("places open conversation chrome and a rounded sidebar above the native full-width input", () => {
		const viewport = new PanesViewport({
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
			focusIndicator: "π",
			focusIndicatorStyle: (_text, pane, focused) => (focused ? pane[0]!.toUpperCase() : pane[0]!),
		});
		expect(viewport.contentWidths(30)).toEqual({ conversation: 18, input: 30, sidebar: 10 });
		const frame = viewport.composeFrame(
			{
				conversation: ["one", "two", "three", "four", "five"],
				input: ["prompt"],
				sidebar: ["todo", "agent"],
			},
			30,
			8,
		);

		expect(frame.sidebarMode).toBe("visible");
		expect(frame.regions.conversation).toEqual({ x: 0, y: 0, width: 18, height: 5 });
		expect(frame.regions.input).toEqual({ x: 0, y: 5, width: 30, height: 3 });
		expect(frame.regions.sidebar).toEqual({ x: 18, y: 0, width: 12, height: 5 });
		expect(frame.lines).toHaveLength(8);
		expect(frame.lines.every(line => Bun.stringWidth(line) === 30)).toBe(true);
		expect(frame.lines[0]).toContain("two");
		expect(frame.lines[0]?.slice(0, 18)).not.toContain("┌");
		expect(frame.lines[0]?.slice(18)).toBe("╭──────────╮");
		expect(frame.lines[4]?.slice(0, 18)).toMatch(/^╰─ c ─+╯$/);
		expect(frame.lines[4]?.slice(18)).toMatch(/^╰─ s ─+╯$/);
		expect(frame.lines[5]).toBe(`prompt${" ".repeat(24)}`);
		expect(frame.lines.slice(5).join("")).not.toContain("┌");
	});

	it("contains truncated SGR backgrounds inside their owning pane", async () => {
		const viewport = new PanesViewport({ sidebarWidth: 12, minLeftWidth: 12, narrowWidth: 24 });
		const frame = viewport.composeFrame(
			{
				conversation: [`\x1b[48;2;40;50;60m${"x".repeat(18)}`],
				input: ["prompt"],
				sidebar: ["todo"],
			},
			30,
			8,
		);
		const terminal = new VirtualTerminal(30, 8);
		terminal.write(`\x1b[H${frame.lines.join("\r\n")}`);
		await terminal.flush();

		expect(terminal.getViewportRowBackgroundColumns(0)).toEqual(Array.from({ length: 18 }, (_, index) => index));

		const scrolled = viewport.composeFrame(
			{ conversation: ["replacement"], input: ["prompt"], sidebar: ["todo"] },
			30,
			8,
		);
		terminal.write(`\x1b[H${scrolled.lines.join("\r\n")}`);
		await terminal.flush();
		for (let row = 0; row < 8; row++) {
			expect(terminal.getViewportRowBackgroundColumns(row)).toEqual([]);
		}
	});

	it("reports effective focus changes and highlights only the active pane indicator", () => {
		const focusChanges: string[] = [];
		const viewport = new PanesViewport({
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
			focusIndicator: "π",
			focusIndicatorStyle: (_text, pane, focused) => (focused ? pane[0]!.toUpperCase() : pane[0]!),
			onFocusChange: focus => focusChanges.push(focus),
		});
		const content = { conversation: ["chat"], input: ["prompt"], sidebar: ["todo"] };

		viewport.setFocus("conversation");
		let frame = viewport.composeFrame(content, 30, 8);
		expect(frame.lines[4]?.slice(0, 18)).toMatch(/^╰─ C ─+╯$/);
		expect(frame.lines[4]?.slice(18)).toMatch(/^╰─ s ─+╯$/);

		viewport.setFocus("sidebar");
		frame = viewport.composeFrame(content, 30, 8);
		expect(frame.lines[4]?.slice(0, 18)).toMatch(/^╰─ c ─+╯$/);
		expect(frame.lines[4]?.slice(18)).toMatch(/^╰─ S ─+╯$/);
		expect(focusChanges).toEqual(["input", "conversation", "sidebar"]);
	});

	it("centers transient Sidebar status above the bottom border without moving its scroll position", () => {
		const viewport = new PanesViewport({
			sidebarWidth: 16,
			minLeftWidth: 12,
			narrowWidth: 24,
			focusIndicator: "π",
		});
		const content = {
			conversation: ["chat"],
			input: ["prompt"],
			sidebar: Array.from({ length: 20 }, (_, index) => `side-${index}`),
		};
		viewport.composeFrame(content, 40, 8);
		viewport.scrollBy("sidebar", -3);
		const before = viewport.scrollInfo("sidebar");

		expect(viewport.setSidebarStatus("Copied")).toBe(true);
		const frame = viewport.composeFrame(content, 40, 8);

		expect(Bun.stripANSI(frame.lines[3]!.slice(24))).toBe("│    Copied    │");
		expect(Bun.stripANSI(frame.lines[4]!.slice(24))).not.toContain("Copied");
		expect(viewport.scrollInfo("sidebar")).toEqual(before);
		expect(viewport.setSidebarStatus(undefined)).toBe(true);
	});

	it("keeps conversation and sidebar scroll positions independent", () => {
		const viewport = new PanesViewport({ sidebarWidth: 12, minLeftWidth: 12, narrowWidth: 24 });
		const content = {
			conversation: Array.from({ length: 20 }, (_, index) => `chat-${index}`),
			input: ["prompt"],
			sidebar: Array.from({ length: 20 }, (_, index) => `side-${index}`),
		};

		viewport.composeFrame(content, 30, 8);
		viewport.scrollBy("conversation", -2);
		viewport.composeFrame(content, 30, 8);
		expect(viewport.scrollInfo("conversation").linesBelow).toBe(2);
		expect(viewport.scrollInfo("sidebar").linesBelow).toBe(0);

		viewport.scrollBy("sidebar", -3);
		viewport.composeFrame(content, 30, 8);
		expect(viewport.scrollInfo("conversation").linesBelow).toBe(2);
		expect(viewport.scrollInfo("sidebar").linesBelow).toBe(3);
	});

	it("hides the sidebar when narrow and opens it as a focused overlay", () => {
		const viewport = new PanesViewport({ sidebarWidth: 12, minLeftWidth: 12, narrowWidth: 32 });
		const content = { conversation: ["chat"], input: ["prompt"], sidebar: ["todo"] };

		let frame = viewport.composeFrame(content, 30, 8);
		expect(frame.sidebarMode).toBe("hidden");
		expect(frame.regions.conversation?.width).toBe(30);

		viewport.toggleSidebar();
		frame = viewport.composeFrame(content, 30, 8);
		expect(frame.sidebarMode).toBe("overlay");
		expect(viewport.focus()).toBe("sidebar");
		expect(frame.regions.sidebar).toEqual({ x: 18, y: 0, width: 12, height: 5 });

		expect(viewport.closeSidebarOverlay()).toBe(true);
		expect(viewport.focus()).toBe("input");
	});

	it("keeps compact overlay geometry inside a tiny terminal", () => {
		const viewport = new PanesViewport({ sidebarWidth: 12, minLeftWidth: 12, narrowWidth: 32 });
		const content = { conversation: ["chat"], input: ["prompt"], sidebar: ["todo"] };

		viewport.composeFrame(content, 2, 2);
		viewport.toggleSidebar();
		const frame = viewport.composeFrame(content, 2, 2);

		expect(frame.lines).toHaveLength(2);
		expect(frame.lines.every(line => Bun.stringWidth(line) === 2)).toBe(true);
		expect(frame.regions.input).toEqual({ x: 0, y: 0, width: 2, height: 2 });
		expect(frame.regions.sidebar).toEqual({ x: 0, y: 0, width: 2, height: 0 });
	});

	it("locks a drag selection to its starting pane and preserves wide graphemes", () => {
		const viewport = new PanesViewport({
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
			selectionStyle: text => `\x1b[7m${text}\x1b[27m`,
		});
		const frame = viewport.composeFrame(
			{
				conversation: ["A中B", "chat"],
				input: ["prompt"],
				sidebar: ["todo"],
			},
			30,
			8,
		);

		expect(viewport.beginSelection(2, 0)).toBe(true);
		expect(viewport.updateSelection(25, 0)).toBe(true);
		const selected = viewport.renderSelection(frame.lines);
		expect(selected[0]).toContain("\x1b[7m中B");
		expect(viewport.finishSelection(25, 0)).toBe("中B");
		expect(viewport.renderSelection(frame.lines)[0]).not.toContain("\x1b[7m");
	});

	it("clamps multi-line selection to the starting pane", () => {
		const viewport = new PanesViewport({ sidebarWidth: 12, minLeftWidth: 12, narrowWidth: 24 });
		const frame = viewport.composeFrame(
			{
				conversation: ["first", "second", "third", "fourth"],
				input: ["prompt"],
				sidebar: ["todo"],
			},
			30,
			8,
		);
		viewport.renderSelection(frame.lines);

		expect(viewport.beginSelection(0, 1)).toBe(true);
		expect(viewport.updateSelection(29, 7)).toBe(true);
		expect(viewport.finishSelection(29, 7)).toBe("second\nthird\nfourth\n╰────────────────╯");
	});

	it("drops empty clicks and clears retained selection when selected cells change", () => {
		const viewport = new PanesViewport({
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
			selectionStyle: text => `\x1b[7m${text}\x1b[27m`,
		});
		let frame = viewport.composeFrame({ conversation: ["before"], input: ["prompt"], sidebar: ["todo"] }, 30, 8);
		viewport.renderSelection(frame.lines);

		expect(viewport.beginSelection(0, 0)).toBe(true);
		expect(viewport.finishSelection(0, 0)).toBeUndefined();
		expect(viewport.renderSelection(frame.lines)[0]).not.toContain("\x1b[7m");

		expect(viewport.beginSelection(0, 0)).toBe(true);
		expect(viewport.finishSelection(5, 0)).toBe("before");
		frame = viewport.composeFrame({ conversation: ["after"], input: ["prompt"], sidebar: ["todo"] }, 30, 8);
		expect(viewport.renderSelection(frame.lines)[0]).not.toContain("\x1b[7m");

		viewport.renderSelection(frame.lines);
		expect(viewport.beginSelection(0, 0)).toBe(true);
		expect(viewport.updateSelection(4, 0)).toBe(true);
		frame = viewport.composeFrame({ conversation: ["newer"], input: ["prompt"], sidebar: ["todo"] }, 30, 8);
		expect(viewport.renderSelection(frame.lines)[0]).not.toContain("\x1b[7m");
		expect(viewport.finishSelection(4, 0)).toBeUndefined();
	});

	it("gives the compact Sidebar overlay selection ownership over Conversation", () => {
		const viewport = new PanesViewport({ sidebarWidth: 12, minLeftWidth: 12, narrowWidth: 50 });
		const content = { conversation: ["chat"], input: ["prompt"], sidebar: ["todo"] };
		viewport.composeFrame(content, 30, 8);
		viewport.toggleSidebar();
		const frame = viewport.composeFrame(content, 30, 8);
		viewport.renderSelection(frame.lines);

		expect(frame.sidebarMode).toBe("overlay");
		expect(viewport.beginSelection(25, 1)).toBe(true);
		const selected = viewport.finishSelection(0, 1);
		expect(selected).toContain("todo");
		expect(selected).not.toContain("chat");
	});
});

describe("TUI panes layout", () => {
	it("keeps the Sidebar boundary fixed when Conversation output contains tabs", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const conversation = new PaneTestComponent(["\talpha", "\t\tbeta", "plain"]);
		const input = new PaneTestComponent(["prompt"]);
		const inputRoot = new Container();
		inputRoot.addChild(input);
		const sidebar = new PaneTestComponent(["side"]);
		tui.addChild(conversation);
		tui.addChild(inputRoot);
		tui.addChild(sidebar);
		tui.enterPanes({
			conversation,
			input: inputRoot,
			inputFocus: input,
			sidebar,
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
		});
		tui.setFocus(input);

		try {
			tui.start();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			expect(viewport[0]?.[28]).toBe("╭");
			expect(viewport[1]?.[28]).toBe("│");
			expect(viewport[2]?.[28]).toBe("│");
		} finally {
			tui.stop();
		}
	});

	it("enforces input, conversation, and sidebar focus navigation", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const conversation = new PaneTestComponent(Array.from({ length: 20 }, (_, index) => `chat-${index}`));
		const input = new PaneTestComponent(["prompt"]);
		const inputRoot = new Container();
		inputRoot.addChild(input);
		const sidebar = new PaneTestComponent(Array.from({ length: 20 }, (_, index) => `side-${index}`));
		let inputEmpty = false;
		tui.addChild(conversation);
		tui.addChild(inputRoot);
		tui.addChild(sidebar);
		tui.enterPanes({
			conversation,
			input: inputRoot,
			inputFocus: input,
			canLeaveInput: () => inputEmpty,
			sidebar,
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
		});
		tui.setFocus(input);

		try {
			tui.start();
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");

			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(3);
			expect(input.inputs).toEqual([]);

			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(0);

			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			expect(input.inputs).toEqual(["\t"]);

			inputEmpty = true;
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("conversation");
			terminal.sendInput("k");
			await terminal.waitForRender();
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(1);
			expect(conversation.inputs).toEqual([]);

			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("conversation");

			terminal.sendInput("l");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("sidebar");
			terminal.sendInput("k");
			await terminal.waitForRender();
			expect(tui.getPaneScrollInfo("sidebar")?.linesBelow).toBe(1);
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(1);

			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("conversation");
			terminal.sendInput("l");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("sidebar");
			terminal.sendInput("h");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("conversation");
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");

			terminal.sendInput("\t");
			await terminal.waitForRender();
			terminal.sendInput("l");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("sidebar");

			terminal.resize(20, 8);
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			expect(tui.getFocused()).toBe(input);

			const transientInput = new PaneTestComponent(["selector"]);
			inputRoot.clear();
			inputRoot.addChild(transientInput);
			tui.setFocus(transientInput);
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			expect(transientInput.inputs).toEqual(["\t"]);
		} finally {
			tui.stop();
		}
	});

	it("routes OpenCode message shortcuts from Input to Conversation", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const conversation = new PaneTestComponent(Array.from({ length: 50 }, (_, index) => `chat-${index}`));
		const input = new PaneTestComponent(["prompt"]);
		const inputRoot = new Container();
		inputRoot.addChild(input);
		const sidebar = new PaneTestComponent(["todo"]);
		tui.addChild(conversation);
		tui.addChild(inputRoot);
		tui.addChild(sidebar);
		tui.enterPanes({
			conversation,
			input: inputRoot,
			inputFocus: input,
			sidebar,
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
		});
		tui.setFocus(input);

		const send = async (data: string) => {
			terminal.sendInput(data);
			await terminal.waitForRender();
		};

		try {
			tui.start();
			await terminal.waitForRender();

			await send("\x1b[121;7u"); // Ctrl+Alt+Y: line up
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(1);
			await send("\x1b[101;7u"); // Ctrl+Alt+E: line down
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(0);

			await send("\x1b[117;7u"); // Ctrl+Alt+U: half page up
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(2);
			await send("\x1b[100;7u"); // Ctrl+Alt+D: half page down
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(0);

			await send("\x1b[98;7u"); // Ctrl+Alt+B: page up
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(3);
			await send("\x1b[102;7u"); // Ctrl+Alt+F: page down
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(0);

			await send("\x1b[103;5u"); // Ctrl+G: first
			expect(tui.getPaneScrollInfo("conversation")?.linesAbove).toBe(0);
			await send("\x1b[103;7u"); // Ctrl+Alt+G: last
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(0);

			expect(tui.getPaneFocus()).toBe("input");
			expect(input.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("routes wheel input to conversation without moving pane focus", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(terminal);
		const conversation = new PaneTestComponent(Array.from({ length: 20 }, (_, index) => `chat-${index}`));
		const input = new PaneTestComponent(["prompt"]);
		const inputRoot = new Container();
		inputRoot.addChild(input);
		const sidebar = new PaneTestComponent(Array.from({ length: 20 }, (_, index) => `side-${index}`));
		tui.addChild(conversation);
		tui.addChild(inputRoot);
		tui.addChild(sidebar);
		tui.enterPanes({
			conversation,
			input: inputRoot,
			inputFocus: input,
			canLeaveInput: () => true,
			sidebar,
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
		});
		tui.setFocus(input);

		try {
			tui.start();
			await terminal.waitForRender();
			expect(writes.join("")).toContain("\x1b[?1006h");
			expect(writes.join("")).not.toContain("\x1b[?1003h");
			expect(writes.join("")).toContain("\x1b[?1002h");

			writes.length = 0;

			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("input");
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(3);
			expect(input.inputs).toEqual([]);
			const scrollPaint = writes.join("");
			expect(scrollPaint.match(/\x1b\[0m\x1b\[2K/g)).toHaveLength(8);

			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("conversation");
			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("conversation");
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(6);

			terminal.sendInput("l");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("sidebar");
			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("sidebar");
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(9);
			expect(tui.getPaneScrollInfo("sidebar")?.linesBelow).toBe(0);

			terminal.sendInput("\x1b[<65;1;1M");
			await terminal.waitForRender();
			expect(tui.getPaneFocus()).toBe("sidebar");
			expect(tui.getPaneScrollInfo("conversation")?.linesBelow).toBe(6);
			expect(tui.getPaneScrollInfo("sidebar")?.linesBelow).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("copies only the pane where a mouse drag starts", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const conversation = new PaneTestComponent(["chat-0", "chat-1", "chat-2", "chat-3"]);
		const input = new PaneTestComponent(["prompt"]);
		const inputRoot = new Container();
		inputRoot.addChild(input);
		const sidebar = new PaneTestComponent(["side-0", "side-1", "side-2"]);
		const copied: string[] = [];
		tui.addChild(conversation);
		tui.addChild(inputRoot);
		tui.addChild(sidebar);
		tui.enterPanes({
			conversation,
			input: inputRoot,
			inputFocus: input,
			sidebar,
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
			onCopySelection: text => copied.push(text),
		});
		tui.setFocus(input);

		try {
			tui.start();
			await terminal.waitForRender();

			// Conversation owns the drag even though release lands in Sidebar.
			terminal.sendInput("\x1b[<0;1;2M");
			terminal.sendInput("\x1b[<32;36;2M");
			terminal.sendInput("\x1b[<0;36;2m");
			await terminal.waitForRender();
			expect(copied[0]).toBe("chat-1");

			// Input owns the drag even though release lands above it.
			terminal.sendInput("\x1b[<0;1;6M");
			terminal.sendInput("\x1b[<32;40;1M");
			terminal.sendInput("\x1b[<0;40;1m");
			await terminal.waitForRender();
			expect(copied[1]).toBe("prompt");

			// Sidebar selection never includes Conversation or Input content.
			terminal.sendInput("\x1b[<0;30;2M");
			terminal.sendInput("\x1b[<32;1;8M");
			terminal.sendInput("\x1b[<0;1;8m");
			await terminal.waitForRender();
			expect(copied[2]).toContain("side-0");
			expect(copied[2]).not.toContain("chat");
			expect(copied[2]).not.toContain("prompt");
		} finally {
			tui.stop();
		}
	});

	it("paints and clears a live drag selection over ANSI-styled pane text", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const conversation = new PaneTestComponent(["chat-0", "\x1b[38;2;200;100;50mchat-1\x1b[39m", "chat-2", "chat-3"]);
		const input = new PaneTestComponent(["prompt"]);
		const inputRoot = new Container();
		inputRoot.addChild(input);
		const sidebar = new PaneTestComponent(["side-0"]);
		const copied: string[] = [];
		tui.addChild(conversation);
		tui.addChild(inputRoot);
		tui.addChild(sidebar);
		tui.enterPanes({
			conversation,
			input: inputRoot,
			inputFocus: input,
			sidebar,
			sidebarWidth: 12,
			minLeftWidth: 12,
			narrowWidth: 24,
			selectionStyle: text => `\x1b[48;2;1;2;3m${text}\x1b[49m`,
			onCopySelection: text => copied.push(text),
		});
		tui.setFocus(input);

		try {
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;2M");
			terminal.sendInput("\x1b[<32;6;2M");
			await terminal.waitForRender();
			expect(terminal.getViewportRowBackgroundColumns(1)).toEqual([0, 1, 2, 3, 4, 5]);

			terminal.sendInput("\x1b[<0;6;2m");
			await terminal.waitForRender();
			expect(copied).toEqual(["chat-1"]);
			expect(terminal.getViewportRowBackgroundColumns(1)).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});
