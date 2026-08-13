import { describe, expect, it, vi } from "bun:test";
import {
	buildRestartCommand,
	getRestartBlockReason,
	isRestartableSessionFile,
	restartCurrentProcess,
} from "@oh-my-pi/pi-coding-agent/cli/restart";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("restart command", () => {
	it("relaunches a compiled binary without its virtual Bun entrypoint", () => {
		expect(
			buildRestartCommand("/sessions/current.jsonl", {
				execPath: "/opt/omp",
				argv: ["bun", "/$bunfs/root/cli", "--model", "test"],
			}),
		).toEqual(["/opt/omp", "--resume", "/sessions/current.jsonl"]);
	});

	it("drops a compiled virtual Bun entrypoint even when it has a source extension", () => {
		expect(
			buildRestartCommand("/sessions/current.jsonl", {
				execPath: "/opt/omp",
				argv: ["bun", "/$bunfs/root/packages/coding-agent/src/cli.js"],
			}),
		).toEqual(["/opt/omp", "--resume", "/sessions/current.jsonl"]);
	});

	it("relaunches a Bun source entrypoint through the current runtime", () => {
		expect(
			buildRestartCommand("/sessions/current.jsonl", {
				execPath: "/opt/bun",
				argv: ["/opt/bun", "/repo/src/cli.ts", "--model", "test"],
			}),
		).toEqual(["/opt/bun", "/repo/src/cli.ts", "--resume", "/sessions/current.jsonl"]);
	});

	it("relaunches without --resume when the current session has no durable history", () => {
		expect(
			buildRestartCommand(undefined, {
				execPath: "/opt/omp",
				argv: ["bun", "/$bunfs/root/cli"],
			}),
		).toEqual(["/opt/omp"]);
	});

	it("requires the restart target to exist on durable storage", async () => {
		expect(await isRestartableSessionFile(import.meta.path)).toBe(true);
		expect(await isRestartableSessionFile(`${import.meta.path}.missing`)).toBe(false);
	});

	it("blocks restart while the current session still owns work", () => {
		const idle = {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
		};

		expect(getRestartBlockReason({ ...idle, isStreaming: true }, 0)).toContain("response");
		expect(getRestartBlockReason({ ...idle, isCompacting: true }, 0)).toContain("compaction");
		expect(getRestartBlockReason({ ...idle, queuedMessageCount: 1 }, 0)).toContain("queued");
		expect(getRestartBlockReason(idle, 1)).toContain("subagent");
		expect(getRestartBlockReason(idle, 0, 1)).toContain("/btw");
		expect(getRestartBlockReason(idle, 0)).toBeUndefined();
	});

	it("replaces the current process after cleanup when execve is available", async () => {
		const events: string[] = [];
		await restartCurrentProcess("/sessions/current.jsonl", "/workspace", {
			runtime: {
				execPath: "/opt/omp",
				argv: ["bun", "/$bunfs/root/cli"],
			},
			cleanup: async () => {
				events.push("cleanup");
			},
			chdir: cwd => {
				events.push(`chdir:${cwd}`);
			},
			execve: (file, argv) => {
				events.push(`execve:${file}:${argv.join(" ")}`);
			},
			spawn: () => {
				events.push("spawn");
				return { unref: () => {} };
			},
			quit: async () => {
				events.push("quit");
			},
		});

		expect(events).toEqual([
			"cleanup",
			"chdir:/workspace",
			"execve:/opt/omp:/opt/omp --resume /sessions/current.jsonl",
		]);
	});

	it("replaces the current process without a resume target for an empty session", async () => {
		const events: string[] = [];
		await restartCurrentProcess(undefined, "/workspace", {
			runtime: {
				execPath: "/opt/omp",
				argv: ["bun", "/$bunfs/root/cli"],
			},
			cleanup: async () => {
				events.push("cleanup");
			},
			chdir: cwd => {
				events.push(`chdir:${cwd}`);
			},
			execve: (file, argv) => {
				events.push(`execve:${file}:${argv.join(" ")}`);
			},
		});

		expect(events).toEqual(["cleanup", "chdir:/workspace", "execve:/opt/omp:/opt/omp"]);
	});

	it("cleans up before spawning the resumed process and then exits", async () => {
		const events: string[] = [];
		const spawn = vi.fn((_command: string[], _options: unknown) => {
			events.push("spawn");
			return {
				unref: () => {
					events.push("unref");
				},
			};
		});

		await restartCurrentProcess("/sessions/current.jsonl", "/workspace", {
			runtime: {
				execPath: "/opt/omp",
				argv: ["bun", "/$bunfs/root/cli"],
			},
			cleanup: async () => {
				events.push("cleanup");
			},
			execve: null,
			spawn,
			quit: async () => {
				events.push("quit");
			},
		});

		expect(events).toEqual(["cleanup", "spawn", "unref", "quit"]);
		expect(spawn).toHaveBeenCalledWith(
			["/opt/omp", "--resume", "/sessions/current.jsonl"],
			expect.objectContaining({
				cwd: "/workspace",
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			}),
		);
	});

	it("dispatches /restart through the TUI lifecycle boundary", async () => {
		const restart = vi.fn(async () => {});
		const setText = vi.fn();
		const handled = await executeBuiltinSlashCommand("/restart", {
			ctx: {
				editor: { setText },
				restart,
			} as never,
		});

		expect(handled).toBe(true);
		expect(setText).toHaveBeenCalledWith("");
		expect(restart).toHaveBeenCalledTimes(1);
	});
});
