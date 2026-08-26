import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeLegacyLocalData } from "../src/fomo/cleanup.ts";

test("legacy local research data is removed on startup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fomo-cleanup-"));
  const legacy = path.join(root, ".fomo");
  mkdirSync(path.join(legacy, "browser-profile"), { recursive: true });
  writeFileSync(path.join(legacy, "fomo.sqlite"), "legacy research");

  removeLegacyLocalData(legacy);

  assert.equal(existsSync(legacy), false);
});
