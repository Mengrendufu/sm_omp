import { describe, expect, it, vi } from "bun:test";
import { clippedFullscreenDockHeight, FullscreenViewport } from "../src/fullscreen";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class TestComponent implements Component {
	inputs: string[] = [];
	renderCount = 0;

	constructor(public lines: string[]) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(_width: number): readonly string[] {
		this.renderCount++;
		return this.lines;
	}
}

describe("FullscreenViewport", () => {
	it("pins the dock below an independently scrollable transcript", () => {
		const viewport = new FullscreenViewport();
		const frame = viewport.composeFrame(["one", "two", "three", "four", "five", "prompt", "status"], 5, 5);

		expect(frame).toEqual(["three", "four", "five", "prompt", "status"]);
		expect(viewport.scrollInfo()).toEqual({ following: true, linesAbove: 2, linesBelow: 0 });

		viewport.scrollBy(-viewport.pageSize());
		const scrolled = viewport.composeFrame(["one", "two", "three", "four", "five", "six", "prompt", "status"], 6, 5);

		expect(scrolled).toEqual(["one", "two", "three", "prompt", "status"]);
		expect(viewport.scrollInfo()).toEqual({ following: false, linesAbove: 0, linesBelow: 3 });

		viewport.scrollToBottom();
		expect(viewport.composeFrame(["one", "two", "three", "four", "five", "six", "prompt", "status"], 6, 5)).toEqual([
			"four",
			"five",
			"six",
			"prompt",
			"status",
		]);
	});

	it("keeps transcript rows visible when the dock is taller than the terminal", () => {
		expect(clippedFullscreenDockHeight(10, 5)).toBe(2);

		const viewport = new FullscreenViewport();
		expect(viewport.composeFrame(["one", "two", "three", "a", "b", "c", "d"], 3, 5)).toEqual([
			"one",
			"two",
			"three",
			"c",
			"d",
		]);
	});

	it("keeps the focused dock row visible when auxiliary rows overflow", () => {
		const viewport = new FullscreenViewport();
		expect(viewport.composeFrame(["one", "two", "three", "prompt", "a", "b", "c"], 3, 5, 3)).toEqual([
			"one",
			"two",
			"three",
			"prompt",
			"a",
		]);
	});
});

describe("TUI fixed layout", () => {
	it("keeps the dock fixed and consumes viewport navigation before editor input", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const transcript = new TestComponent(Array.from({ length: 20 }, (_, index) => `line-${index}`));
		const dock = new TestComponent(["prompt", "status"]);
		tui.addChild(transcript);
		tui.addChild(dock);
		tui.enterFullscreen({ scroll: [transcript], dock, viewportControls: true });
		tui.setFocus(dock);

		try {
			tui.start();
			await terminal.waitForRender();

			expect(tui.isFullscreen()).toBe(true);
			expect(terminal.getViewport().map(line => line.trimEnd())).toEqual([
				"line-16",
				"line-17",
				"line-18",
				"line-19",
				"prompt",
				"status",
			]);

			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();

			expect(terminal.getViewport().map(line => line.trimEnd())).toEqual([
				"line-13",
				"line-14",
				"line-15",
				"line-16",
				"prompt",
				"status",
			]);
			expect(tui.getScrollInfo()).toEqual({ following: false, linesAbove: 13, linesBelow: 3 });
			expect(dock.inputs).toEqual([]);

			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			expect(tui.getScrollInfo()).toEqual({ following: true, linesAbove: 16, linesBelow: 0 });
			expect(dock.inputs).toEqual([]);

			terminal.resize(40, 8);
			await terminal.waitForRender();
			expect(terminal.getViewport().map(line => line.trimEnd())).toEqual([
				"line-14",
				"line-15",
				"line-16",
				"line-17",
				"line-18",
				"line-19",
				"prompt",
				"status",
			]);
		} finally {
			tui.stop();
		}
	});

	it("positions the hardware cursor at the prompt marker", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const transcript = new TestComponent(["history"]);
		const dock = new TestComponent([`prompt${CURSOR_MARKER}`, "status"]);
		tui.addChild(transcript);
		tui.addChild(dock);
		tui.enterFullscreen({ scroll: [transcript], dock });
		try {
			tui.start();
			await terminal.waitForRender();

			expect(terminal.getViewport()[4]?.trimEnd()).toBe("prompt");
			expect(terminal.getCursor()).toEqual({ row: 4, col: 6 });
		} finally {
			tui.stop();
		}
	});
	it("reuses transcript rows for dock-only input renders", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const transcript = new TestComponent(Array.from({ length: 20 }, (_, index) => `line-${index}`));
		const dock = new TestComponent(["prompt", "status"]);
		tui.addChild(transcript);
		tui.addChild(dock);
		tui.enterFullscreen({ scroll: [transcript], dock });
		tui.setFocus(dock);
		tui.enableScopedInputRender(dock);

		try {
			tui.start();
			await terminal.waitForRender();
			expect(transcript.renderCount).toBe(1);

			terminal.sendInput("x");
			await terminal.waitForRender();

			expect(transcript.renderCount).toBe(1);
			expect(dock.renderCount).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("returns to follow-tail after an authoritative transcript replacement", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const transcript = new TestComponent(Array.from({ length: 20 }, (_, index) => `old-${index}`));
		const dock = new TestComponent(["prompt", "status"]);
		tui.addChild(transcript);
		tui.addChild(dock);
		tui.enterFullscreen({ scroll: [transcript], dock });

		try {
			tui.start();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			expect(tui.getScrollInfo()?.following).toBe(false);

			transcript.lines = Array.from({ length: 20 }, (_, index) => `new-${index}`);
			tui.resetFullscreenViewport();
			tui.requestRender();
			await terminal.waitForRender();

			expect(tui.getScrollInfo()).toEqual({ following: true, linesAbove: 16, linesBelow: 0 });
			expect(terminal.getViewport().map(line => line.trimEnd())).toEqual([
				"new-16",
				"new-17",
				"new-18",
				"new-19",
				"prompt",
				"status",
			]);
		} finally {
			tui.stop();
		}
	});

	it("does not add cursor-control bytes to native fullscreen overlays", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(terminal);
		tui.addChild(new TestComponent(["history"]));

		try {
			tui.start();
			await terminal.waitForRender();
			writes.length = 0;

			tui.showOverlay(new TestComponent(["modal"]), { fullscreen: true });
			await terminal.waitForRender();

			expect(writes.join("").match(/\x1b\[\?25l/g)).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});
});
