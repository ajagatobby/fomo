/**
 * Card / box drawing: rounded borders, ANSI-aware content, optional
 * accent-colored frame and internal dividers. The terminal analog of a
 * rounded-3xl card with an accent ring.
 */

import { width } from "./ansi.ts";
import { padEndVisible } from "./format.ts";

export type BoxOptions = {
  /** Inner content width. Lines are padded/truncated to this. */
  width: number;
  /** Color fn applied to the frame characters. */
  frame?: (s: string) => string;
  /** Horizontal padding inside the border. */
  padX?: number;
};

const H = "─";

/**
 * Render content lines inside a rounded box.
 * Use `divider()` sentinel lines to draw full-width separators.
 */
export function box(lines: string[], opts: BoxOptions): string {
  const { width: w, frame = (s) => s, padX = 2 } = opts;
  const inner = w + padX * 2;
  const top = frame(`╭${H.repeat(inner)}╮`);
  const bottom = frame(`╰${H.repeat(inner)}╯`);
  const pad = " ".repeat(padX);

  const body = lines.map((line) => {
    if (line === DIVIDER) return frame(`├${H.repeat(inner)}┤`);
    const clipped = clip(line, w);
    return frame("│") + pad + padEndVisible(clipped, w) + pad + frame("│");
  });

  return [top, ...body, bottom].join("\n");
}

export const DIVIDER = "\u0000__DIVIDER__\u0000";
export function divider(): string {
  return DIVIDER;
}

/** Center a string within visible width w. */
export function center(s: string, w: number): string {
  const len = width(s);
  if (len >= w) return s;
  const left = Math.floor((w - len) / 2);
  return " ".repeat(left) + s;
}

/** Space two strings apart to fill width w (left ... right). */
export function spread(left: string, right: string, w: number): string {
  const gap = w - width(left) - width(right);
  return left + " ".repeat(Math.max(1, gap)) + right;
}

/**
 * Lay out cells as equal columns separated by a vertical rule, each centered.
 * Mirrors the Invested / Entry / Current footer row.
 */
export function columns(cells: string[][], w: number, frame?: (s: string) => string): string[] {
  const n = cells.length;
  const sep = frame ? frame("│") : "│";
  const colW = Math.floor((w - (n - 1)) / n);
  const rows = Math.max(...cells.map((c) => c.length));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(
      cells
        .map((col) => padEndVisible(center(col[r] ?? "", colW), colW))
        .join(sep),
    );
  }
  return out;
}

function clip(s: string, max: number): string {
  if (width(s) <= max) return s;
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.slice(0, max - 1) + "…";
}
