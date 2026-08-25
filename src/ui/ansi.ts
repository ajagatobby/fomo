/**
 * ANSI styling primitives. Zero dependencies.
 * Respects NO_COLOR and non-TTY output.
 */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined);

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);
export const strikethrough = wrap(9, 29);

export const black = wrap(30, 39);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const white = wrap(37, 39);
export const gray = wrap(90, 39);

export const bgRed = wrap(41, 49);
export const bgGreen = wrap(42, 49);
export const bgYellow = wrap(43, 49);

/** 256-color foreground */
export const fg256 = (n: number) => (s: string) =>
  enabled ? `\x1b[38;5;${n}m${s}\x1b[39m` : s;

// Brand palette
export const accent = fg256(63); // ~rgb(81,106,246)
export const gold = fg256(220);
export const orange = fg256(208);
export const mint = fg256(49);
export const rose = fg256(204);
export const steel = fg256(245);

/** Strip ANSI codes — needed for measuring visible width. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width of a string (ANSI-aware). */
export function width(s: string): number {
  return stripAnsi(s).length;
}

export const colorEnabled = enabled;
