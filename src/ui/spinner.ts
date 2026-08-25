/**
 * Minimal spinner with live status text. Safe on non-TTY (falls back to plain logs).
 */

import { cyan, gray } from "./ansi.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  #text = "";
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;
  #tty = process.stdout.isTTY === true;
  #started = false;

  start(text: string): this {
    this.#started = true;
    this.#text = text;
    if (!this.#tty) {
      console.log(text);
      return this;
    }
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.#timer = setInterval(() => this.#render(), 80);
    return this;
  }

  update(text: string): void {
    if (!this.#started) return;
    this.#text = text;
    if (!this.#tty) console.log(text);
  }

  #render(): void {
    const frame = FRAMES[this.#frame++ % FRAMES.length];
    process.stdout.write(`\r\x1b[2K${cyan(frame)} ${this.#text}`);
  }

  stop(finalText?: string): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#tty) {
      process.stdout.write(`\r\x1b[2K\x1b[?25h`); // clear line, show cursor
    }
    if (finalText) console.log(finalText);
  }

  fail(text: string): void {
    this.stop(`${gray("✗")} ${text}`);
  }
}
