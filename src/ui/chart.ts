/**
 * Terminal micro-charts: sparklines and signed horizontal bars.
 */

import { green, red, gray } from "./ansi.ts";

const TICKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export type AreaChartOptions = {
  width: number;
  height: number;
  /** Color for columns whose value is >= 0 / < 0. */
  positive?: (s: string) => string;
  negative?: (s: string) => string;
};

/**
 * Multi-row filled area chart (equity-curve style). Values are resampled
 * to `width` columns; each column fills bottom-up with eighth-blocks.
 */
export function areaChart(values: number[], opts: AreaChartOptions): string[] {
  const { width, height, positive = green, negative = red } = opts;
  if (values.length === 0) return Array.from({ length: height }, () => " ".repeat(width));

  // Resample to fixed width, averaging each bucket for smoothness.
  const cols: number[] = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i / width) * values.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / width) * values.length));
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[Math.min(j, values.length - 1)];
    cols.push(sum / (to - from));
  }

  const min = Math.min(...cols, 0);
  const max = Math.max(...cols, 0);
  const range = max - min || 1;
  const unit = height * 8; // total eighth-blocks per column

  const rows: string[] = [];
  for (let r = 0; r < height; r++) {
    let row = "";
    for (let c = 0; c < width; c++) {
      const fill = Math.max(1, Math.round(((cols[c] - min) / range) * unit));
      const floorOfRow = (height - 1 - r) * 8; // eighths below this row
      const inRow = Math.max(0, Math.min(8, fill - floorOfRow));
      const ch = EIGHTHS[inRow];
      row += ch === " " ? ch : cols[c] >= 0 ? positive(ch) : negative(ch);
    }
    rows.push(row);
  }
  return rows;
}

/** Compact sparkline of a series. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.min(TICKS.length - 1, Math.floor(((v - min) / range) * TICKS.length));
      const tick = TICKS[idx];
      return v > 0 ? green(tick) : v < 0 ? red(tick) : gray(tick);
    })
    .join("");
}

/**
 * Signed horizontal bar for a value within [-maxAbs, +maxAbs].
 * Negative fills left of the axis, positive fills right.
 */
export function signedBar(value: number, maxAbs: number, halfWidth = 12): string {
  const filled = maxAbs > 0 ? Math.round((Math.abs(value) / maxAbs) * halfWidth) : 0;
  const n = Math.min(halfWidth, filled);
  const left =
    value < 0 ? " ".repeat(halfWidth - n) + red("█".repeat(n)) : " ".repeat(halfWidth);
  const right =
    value > 0 ? green("█".repeat(n)) + " ".repeat(halfWidth - n) : " ".repeat(halfWidth);
  return left + gray("│") + right;
}

/** Simple positive-only meter, e.g. win rate. */
export function meter(fraction: number, width = 20): string {
  const f = Math.max(0, Math.min(1, fraction));
  const n = Math.round(f * width);
  const color = f >= 0.5 ? green : red;
  return color("█".repeat(n)) + gray("░".repeat(width - n));
}
