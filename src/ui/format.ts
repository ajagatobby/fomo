/**
 * Number, currency, time and address formatting.
 */

import { green, red, gray, dim } from "./ansi.ts";

/**
 * The native currency unit used by amount formatters. A Fomo run analyzes
 * one chain at a time, so a module-level unit keeps call sites clean.
 */
let NATIVE_UNIT = "SOL";
export function setNativeUnit(unit: string): void {
  NATIVE_UNIT = unit;
}

/** 1234567.89 -> "1.23M", 4520 -> "4.52K" */
export function compact(n: number, digits = 2): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  if (abs >= 1) return n.toFixed(digits);
  if (abs === 0) return "0";
  // small numbers: keep significant digits
  return n.toPrecision(3);
}

/** Native amount with unit (SOL/ETH/BNB). */
export function sol(n: number, digits = 3): string {
  const abs = Math.abs(n);
  const d = abs >= 100 ? 1 : abs >= 1 ? digits : 4;
  return `${n.toFixed(d)} ${NATIVE_UNIT}`;
}

/** Signed native amount, colored green/red. */
export function pnl(n: number, digits = 3): string {
  if (Math.abs(n) < 1e-9) return gray(`0.000 ${NATIVE_UNIT}`);
  const s = `${n > 0 ? "+" : ""}${sol(n, digits)}`;
  return n > 0 ? green(s) : red(s);
}

/** Signed percentage, colored. */
export function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return gray("—");
  const s = `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
  return n > 0 ? green(s) : n < 0 ? red(s) : gray(s);
}

/** Plain percentage 0-100. */
export function pctPlain(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

/** "7xKX...gAsU" */
export function shortAddr(addr: string, chars = 4): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

/** Unix seconds -> "Aug 12" or "Aug 12 '25" if not current year. */
export function shortDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const base = d.toLocaleDateString("en-US", opts);
  const yr = d.getUTCFullYear();
  return yr === new Date().getUTCFullYear() ? base : `${base} '${String(yr).slice(2)}`;
}

/** "2025-08-12" (UTC bucket key). */
export function dayKey(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** Seconds -> "4m", "2.3h", "5d" */
export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

/** Relative time from unix seconds: "3h ago", "12d ago" */
export function ago(unixSec: number): string {
  return dim(duration(Date.now() / 1000 - unixSec) + " ago");
}

/** Pad string to visible width (ANSI aware), left-aligned. */
export function padEndVisible(s: string, w: number): string {
  const diff = w - visibleWidth(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

/** Pad string to visible width (ANSI aware), right-aligned. */
export function padStartVisible(s: string, w: number): string {
  const diff = w - visibleWidth(s);
  return diff > 0 ? " ".repeat(diff) + s : s;
}

function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
