/**
 * Application-owned viewport for the persistent alternate-screen layout.
 * Transcript rows scroll independently while dock rows stay pinned at the
 * bottom of the terminal.
 */

export const FULLSCREEN_MIN_TRANSCRIPT_ROWS = 3;

export interface ScrollInfo {
	following: boolean;
	linesBelow: number;
	linesAbove: number;
}

export function clippedFullscreenDockHeight(dockLength: number, height: number): number {
	const maxDock = Math.max(0, height - FULLSCREEN_MIN_TRANSCRIPT_ROWS);
	return Math.min(dockLength, maxDock);
}

export class FullscreenViewport {
	#scrollTop = 0;
	#following = true;
	#lastMaxScroll = 0;
	#lastWindowHeight = 0;
	#lastTranscriptLength = 0;
	#lastDockStart = 0;
	#lastDockHeight = 0;

	/**
	 * Compose exactly `height` rows from a frame whose dock begins at
	 * `transcriptLength`. `focusedDockRow` keeps the editor cursor row visible
	 * when auxiliary dock content must be clipped.
	 */
	composeFrame(frame: readonly string[], transcriptLength: number, height: number, focusedDockRow?: number): string[] {
		const frameHeight = Math.max(0, height);
		const transcriptEnd = Math.max(0, Math.min(frame.length, transcriptLength));
		const dockLength = frame.length - transcriptEnd;
		const dockHeight = clippedFullscreenDockHeight(dockLength, frameHeight);
		const bottomDockStart = frame.length - dockHeight;
		const dockStart =
			focusedDockRow !== undefined && focusedDockRow >= transcriptEnd && focusedDockRow < frame.length
				? Math.min(bottomDockStart, focusedDockRow)
				: bottomDockStart;
		const windowHeight = frameHeight - dockHeight;
		const maxScroll = Math.max(0, transcriptEnd - windowHeight);

		if (this.#following) {
			this.#scrollTop = maxScroll;
		} else {
			this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, maxScroll));
		}
		this.#lastMaxScroll = maxScroll;
		this.#lastWindowHeight = windowHeight;
		this.#lastTranscriptLength = transcriptEnd;
		this.#lastDockStart = dockStart;
		this.#lastDockHeight = dockHeight;

		const window = frame.slice(this.#scrollTop, Math.min(transcriptEnd, this.#scrollTop + windowHeight));
		while (window.length < windowHeight) window.push("");
		return [...window, ...frame.slice(dockStart, dockStart + dockHeight)];
	}

	/** Map a row in the composed component frame to its visible screen row. */
	screenRowForFrameRow(frameRow: number): number | undefined {
		if (
			frameRow >= this.#scrollTop &&
			frameRow < Math.min(this.#lastTranscriptLength, this.#scrollTop + this.#lastWindowHeight)
		) {
			return frameRow - this.#scrollTop;
		}
		if (frameRow >= this.#lastDockStart && frameRow < this.#lastDockStart + this.#lastDockHeight) {
			return this.#lastWindowHeight + frameRow - this.#lastDockStart;
		}
		return undefined;
	}

	/** Scrolling away from the bottom pauses follow-tail until the bottom is reached again. */
	scrollBy(delta: number): void {
		const base = this.#following ? this.#lastMaxScroll : this.#scrollTop;
		this.#scrollTop = Math.max(0, Math.min(base + delta, this.#lastMaxScroll));
		this.#following = this.#scrollTop >= this.#lastMaxScroll;
	}

	scrollToTop(): void {
		this.#scrollTop = 0;
		this.#following = this.#lastMaxScroll === 0;
	}

	scrollToBottom(): void {
		this.#scrollTop = this.#lastMaxScroll;
		this.#following = true;
	}

	pageSize(): number {
		return Math.max(1, this.#lastWindowHeight - 1);
	}

	windowHeight(): number {
		return this.#lastWindowHeight;
	}

	scrollInfo(): ScrollInfo {
		return {
			following: this.#following,
			linesBelow: Math.max(0, this.#lastMaxScroll - this.#scrollTop),
			linesAbove: this.#scrollTop,
		};
	}
}
