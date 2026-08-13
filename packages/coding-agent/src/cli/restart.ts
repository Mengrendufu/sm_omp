import { postmortem } from "@oh-my-pi/pi-utils";

export interface RestartRuntime {
	execPath: string;
	argv: readonly string[];
}

export interface RestartActivity {
	isStreaming: boolean;
	isCompacting: boolean;
	isGeneratingHandoff: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	isEvalRunning: boolean;
	queuedMessageCount: number;
}

interface RestartChild {
	unref(): void;
}

interface RestartSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
}

export interface RestartProcessOptions {
	runtime?: RestartRuntime;
	cleanup?: () => Promise<void>;
	chdir?: (cwd: string) => void;
	execve?: ((file: string, argv: string[], env: Record<string, string>) => void) | null;
	spawn?: (command: string[], options: RestartSpawnOptions) => RestartChild;
	quit?: () => Promise<void>;
}

/** Explain why a restart would discard active work, or return undefined when it is safe. */
export function getRestartBlockReason(
	activity: RestartActivity,
	runningSubagents: number,
	activeSideRequests: number = 0,
): string | undefined {
	if (activity.isStreaming) return "Wait for the current response to finish or abort it before restarting.";
	if (activity.isCompacting) return "Wait for the current compaction to finish before restarting.";
	if (activity.isGeneratingHandoff) return "Wait for the current handoff to finish before restarting.";
	if (activity.isRetrying) return "Wait for the current retry to finish before restarting.";
	if (activity.isBashRunning) return "Wait for the current shell command to finish before restarting.";
	if (activity.isEvalRunning) return "Wait for the current evaluation to finish before restarting.";
	if (activity.queuedMessageCount > 0) return "Submit or remove queued messages before restarting.";
	if (runningSubagents > 0) return "Wait for running subagents to finish before restarting.";
	if (activeSideRequests > 0) return "Close the active /btw or /omfg panel before restarting.";
	return undefined;
}

/** Build a clean restart invocation, resuming only when durable history exists. */
export function buildRestartCommand(session: string | undefined, runtime: RestartRuntime = process): string[] {
	const entrypoint = runtime.argv[1];
	const sourceEntrypoint =
		entrypoint && !/(?:\$bunfs|~BUN|%7EBUN)/i.test(entrypoint) && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entrypoint)
			? entrypoint
			: undefined;
	return [
		runtime.execPath,
		...(sourceEntrypoint ? [sourceEntrypoint] : []),
		...(session ? ["--resume", session] : []),
	];
}

/** The restart target must already exist; fresh empty sessions have only a prospective path. */
export function isRestartableSessionFile(sessionFile: string): Promise<boolean> {
	return Bun.file(sessionFile).exists();
}

/**
 * Run global cleanup, then replace the current process with a fresh or resumed OMP.
 * `execve` preserves the foreground process group and shell wait boundary; platforms
 * without it fall back to a detached-from-the-event-loop child using the same terminal.
 */
export async function restartCurrentProcess(
	session: string | undefined,
	cwd: string,
	options: RestartProcessOptions = {},
): Promise<void> {
	const cleanup = options.cleanup ?? postmortem.cleanup;
	const chdir = options.chdir ?? process.chdir;
	const execve = options.execve === undefined ? process.execve : options.execve;
	const spawn =
		options.spawn ?? ((command: string[], spawnOptions: RestartSpawnOptions) => Bun.spawn(command, spawnOptions));
	const quit = options.quit ?? (() => postmortem.quit(0));
	const command = buildRestartCommand(session, options.runtime);
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);

	await cleanup();
	if (execve) {
		chdir(cwd);
		execve(command[0], command, env);
		return;
	}

	const child = spawn(command, {
		cwd,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	child.unref();
	await quit();
}
