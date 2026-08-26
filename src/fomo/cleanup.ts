import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Removes research data created by versions that predate the realtime-only model. */
export function removeLegacyLocalData(directory = path.join(homedir(), ".fomo")): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
