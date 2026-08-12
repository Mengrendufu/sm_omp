import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

class TestModalEditor extends CustomEditor {}

class PersistentRowsComponent implements Component {
	#rows: readonly string[] = ["before"];

	setText(text: string): void {
		this.#rows = [text];
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		vi.useRealTimers();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("assembles the fixed transcript viewport while keeping editor focus", async () => {
		await mode.init({ suppressWelcomeIntro: true });

		expect(mode.ui.isFullscreen()).toBe(true);
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});

	it("preserves the native scrollback layout when configured", async () => {
		mode.settings.set("tui.layout", "native");
		await mode.init({ suppressWelcomeIntro: true });

		expect(mode.ui.isFullscreen()).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});

	it("assembles conversation, input, and sidebar panes while keeping editor focus", async () => {
		mode.settings.set("tui.layout", "panes");
		await mode.init({ suppressWelcomeIntro: true });

		expect(mode.ui.isPanes()).toBe(true);
		expect(mode.ui.children).toHaveLength(3);
		expect(mode.ui.getPaneFocus()).toBe("input");
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});

	it("keeps pane content at normal intensity and delegates focus emphasis to indicators", async () => {
		mode.settings.set("tui.layout", "panes");
		const enterPanes = vi.spyOn(mode.ui, "enterPanes");
		await mode.init({ suppressWelcomeIntro: true });

		const options = enterPanes.mock.calls[0]?.[0];
		expect(options).toBeDefined();
		expect(options?.contentStyle?.("output", "conversation", false)).toBe("output");
		expect(options?.contentStyle?.("input", "input", false)).toBe("input");
		expect(options?.focusIndicator).toBeTruthy();
		expect(options?.focusIndicatorStyle?.("π", "conversation", true)).not.toBe(
			options?.focusIndicatorStyle?.("π", "conversation", false),
		);
		expect(options?.onFocusChange).toBeDefined();
		expect(options?.selectionStyle?.("picked")).not.toBe("picked");
		expect(options?.onCopySelection).toBeDefined();
	});

	it("shows a transient Copied status on the Sidebar bottom border", async () => {
		vi.useFakeTimers();
		mode.settings.set("tui.layout", "panes");
		const enterPanes = vi.spyOn(mode.ui, "enterPanes");
		const setSidebarStatus = vi.spyOn(mode.ui, "setPanesSidebarStatus");
		await mode.init({ suppressWelcomeIntro: true });
		const onCopySelection = enterPanes.mock.calls[0]?.[0].onCopySelection;

		onCopySelection?.("first");
		expect(setSidebarStatus.mock.lastCall?.[0]).toContain("Copied");
		vi.advanceTimersByTime(1_000);
		onCopySelection?.("second");
		vi.advanceTimersByTime(1_000);
		expect(setSidebarStatus.mock.calls.some(([status]) => status === undefined)).toBe(false);
		vi.advanceTimersByTime(500);
		expect(setSidebarStatus).toHaveBeenLastCalledWith(undefined);
	});

	it("synchronizes the input Pi indicator with pane focus", async () => {
		mode.settings.set("tui.layout", "panes");
		const setInputFocused = vi.spyOn(mode.statusLine, "setInputFocused");
		const enterPanes = vi.spyOn(mode.ui, "enterPanes");
		await mode.init({ suppressWelcomeIntro: true });

		const options = enterPanes.mock.calls[0]?.[0];
		expect(setInputFocused).toHaveBeenCalledWith(true);
		options?.onFocusChange?.("conversation");
		expect(setInputFocused).toHaveBeenLastCalledWith(false);
	});

	it("keeps working status in the conversation pane", async () => {
		mode.settings.set("tui.layout", "panes");
		await mode.init({ suppressWelcomeIntro: true });

		const conversation = mode.ui.children[0];
		const input = mode.ui.children[1];
		expect(conversation).toBeInstanceOf(Container);
		expect(input).toBeInstanceOf(Container);
		expect((conversation as Container).children).toContain(mode.statusContainer);
		expect((input as Container).children).not.toContain(mode.statusContainer);
	});

	it("recomposes persistent transcript rows without keyboard input", async () => {
		mode.settings.set("tui.layout", "panes");
		await mode.init({ suppressWelcomeIntro: true });
		const conversation = mode.ui.children[0]!;
		const persistent = new PersistentRowsComponent();
		mode.chatContainer.addChild(persistent);

		expect(conversation.render(80).join("\n")).toContain("before");
		persistent.setText("after");

		expect(conversation.render(80).join("\n")).toContain("after");
	});
});
