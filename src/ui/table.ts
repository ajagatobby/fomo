/**
 * ANSI-aware table renderer with column alignment.
 */

import { gray, dim, width } from "./ansi.ts";
import { padEndVisible, padStartVisible } from "./format.ts";

export type Align = "left" | "right";

export type Column = {
  header: string;
  align?: Align;
  /** Max column width; content is truncated with "…". */
  max?: number;
};

export function table(columns: Column[], rows: string[][], indent = "  "): string {
  const widths = columns.map((c, i) => {
    let w = width(c.header);
    for (const row of rows) w = Math.max(w, width(row[i] ?? ""));
    return c.max ? Math.min(w, c.max) : w;
  });

  const line = (cells: string[], pad: (s: string, w: number) => string[] | string) =>
    indent +
    cells
      .map((cell, i) => {
        const truncated = truncate(cell, widths[i]);
        return columns[i].align === "right"
          ? padStartVisible(truncated, widths[i])
          : padEndVisible(truncated, widths[i]);
      })
      .join("  ");

  const out: string[] = [];
  out.push(line(columns.map((c) => dim(c.header)), padEndVisible));
  out.push(indent + gray(widths.map((w) => "─".repeat(w)).join("──")));
  for (const row of rows) out.push(line(row, padEndVisible));
  return out.join("\n");
}

function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  // Strip ANSI when truncating to keep it simple & safe.
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.slice(0, max - 1) + "…";
}
