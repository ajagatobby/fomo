/**
 * Layout primitives: banner, section headers, key-value cards.
 */

import { bold, dim, gray, gold, width } from "./ansi.ts";
import { padEndVisible } from "./format.ts";

export function banner(subtitle: string): string {
  const title = gold(bold("FOMO"));
  return `\n${title} ${dim("·")} ${dim(subtitle)}\n`;
}

export function section(title: string): string {
  return `\n${bold(title)}\n${gray("─".repeat(Math.max(24, title.length + 2)))}`;
}

export type Stat = { label: string; value: string };

/**
 * Render stats as aligned rows of "label  value" cards, N per row.
 */
export function statRow(stats: Stat[], perRow = 4, cellWidth = 24): string {
  const lines: string[] = [];
  for (let i = 0; i < stats.length; i += perRow) {
    const chunk = stats.slice(i, i + perRow);
    const labels = chunk.map((s) => padEndVisible(dim(s.label), cellWidth)).join("");
    const values = chunk.map((s) => padEndVisible(s.value, cellWidth)).join("");
    lines.push("  " + labels, "  " + values, "");
  }
  return lines.join("\n").trimEnd();
}

export function kv(label: string, value: string, labelWidth = 18): string {
  return `  ${padEndVisible(dim(label), labelWidth)}${value}`;
}
