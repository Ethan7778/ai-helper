/**
 * Turns bursty network chunks into an even "typing" reveal.
 *
 * Callers push the full text received so far; the smoother reveals it one
 * animation frame at a time, speeding up when it falls behind so the visible
 * text never lags the network by more than ~CATCH_UP_MS.
 */

/** Steady typing pace when nearly caught up. */
const MIN_CHARS_PER_SEC = 75;
/** Upper bound on how far the display may trail the received text. */
const CATCH_UP_MS = 300;
/** How quickly the remainder drains once the stream has finished. */
const DRAIN_MS = 200;

export class StreamSmoother {
  private target = "";
  private shownLen = 0;
  private frame = 0;
  private lastTs = 0;
  private finishing = false;
  private onDone: (() => void) | null = null;
  private readonly instant: boolean;

  constructor(private readonly render: (visible: string) => void) {
    this.instant =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Text revealed so far (what's on screen). */
  get visible(): string {
    return this.target.slice(0, this.shownLen);
  }

  /** Supply the full text received so far. */
  push(fullText: string): void {
    if (!fullText.startsWith(this.target.slice(0, this.shownLen))) {
      // The source rewrote earlier text; restart from the common prefix.
      let i = 0;
      const max = Math.min(fullText.length, this.shownLen);
      while (i < max && fullText[i] === this.target[i]) i++;
      this.shownLen = i;
    }
    this.target = fullText;
    if (this.instant) {
      this.shownLen = fullText.length;
      this.render(fullText);
      return;
    }
    this.schedule();
  }

  /** Quickly reveal whatever remains, then resolve. */
  finish(): Promise<void> {
    this.finishing = true;
    if (this.shownLen >= this.target.length) {
      this.stop();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.onDone = resolve;
      this.schedule();
    });
  }

  cancel(): void {
    this.stop();
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame((ts) => this.tick(ts));
  }

  private stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastTs = 0;
  }

  private tick(ts: number): void {
    this.frame = 0;
    const dt = this.lastTs ? Math.min(ts - this.lastTs, 100) : 16;
    this.lastTs = ts;

    const backlog = this.target.length - this.shownLen;
    if (backlog > 0) {
      const window = this.finishing ? DRAIN_MS : CATCH_UP_MS;
      const step = Math.max(
        (MIN_CHARS_PER_SEC * dt) / 1000,
        (backlog * dt) / window
      );
      this.shownLen = Math.min(
        this.target.length,
        this.shownLen + Math.max(1, Math.round(step))
      );
      this.render(this.visible);
    }

    if (this.shownLen < this.target.length) {
      this.schedule();
      return;
    }
    this.lastTs = 0;
    if (this.finishing) {
      const done = this.onDone;
      this.onDone = null;
      done?.();
    }
  }
}
