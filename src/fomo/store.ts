import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import type {
  FomoAccount,
  FomoLoginMethod,
  FomoStoreStatus,
  FomoSwap,
  FomoSyncSummary,
  FomoUser,
  RawFomoPage,
  ResearchDataset,
  StoredFomoUser,
  StoredFomoAccount,
} from "./types.ts";

const DEFAULT_DATABASE = path.join(homedir(), ".fomo", "fomo.sqlite");
const SCHEMA_VERSION = 4;

export type CompleteSyncInput = {
  userId?: string;
  swapCount?: number;
  rawPageCount?: number;
  truncated?: boolean;
  error?: string;
};

/** Versioned local research store. Call close() when the consuming command exits. */
export class FomoStore {
  readonly databasePath: string;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(databasePath = DEFAULT_DATABASE) {
    this.databasePath = databasePath;
    const directory = path.dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    tryChmod(directory, 0o700);
    this.#db = new DatabaseSync(databasePath);
    tryChmod(databasePath, 0o600);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  beginSync(handle: string): number {
    this.#assertOpen();
    const cleanHandle = handle.trim().replace(/^@/, "");
    if (!cleanHandle) throw new Error("A Fomo profile handle is required");
    const result = this.#db
      .prepare("INSERT INTO sync_runs (handle, started_at, status) VALUES (?, ?, 'running')")
      .run(cleanHandle, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  completeSync(runId: number, input: CompleteSyncInput = {}): FomoSyncSummary {
    this.#assertOpen();
    const completedAt = new Date().toISOString();
    const status = input.error ? "failed" : "completed";
    const result = this.#db
      .prepare(
        `UPDATE sync_runs
         SET user_id = COALESCE(?, user_id), completed_at = ?, status = ?,
             swaps_saved = COALESCE(?, swaps_saved), raw_pages_saved = COALESCE(?, raw_pages_saved),
             truncated = COALESCE(?, truncated), error = ?
         WHERE id = ?`,
      )
      .run(
        input.userId ?? null,
        completedAt,
        status,
        input.swapCount ?? null,
        input.rawPageCount ?? null,
        input.truncated === undefined ? null : Number(input.truncated),
        input.error ?? null,
        runId,
      );
    if (result.changes !== 1) throw new Error(`Unknown Fomo sync run ${runId}`);
    return this.#syncSummary(runId);
  }

  saveUser(user: FomoUser, syncedAt = new Date().toISOString()): StoredFomoUser {
    this.#assertOpen();
    this.#db
      .prepare(
        `INSERT INTO users
           (id, user_handle, display_name, clan_id, clan_name, solana_address, evm_address,
            first_observed_at, synced_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_handle = excluded.user_handle,
           display_name = excluded.display_name,
            clan_id = excluded.clan_id,
            clan_name = excluded.clan_name,
            solana_address = excluded.solana_address,
            evm_address = excluded.evm_address,
           synced_at = excluded.synced_at,
           raw_json = excluded.raw_json`,
      )
      .run(
        user.id,
        user.userHandle,
        user.displayName,
        user.clan?.id ?? null,
        user.clan?.name ?? null,
        user.address ?? null,
        user.evmAddress ?? null,
        syncedAt,
        syncedAt,
        stringifyJson(user),
      );
    const firstObserved = this.#db.prepare("SELECT first_observed_at FROM users WHERE id = ?").get(user.id) as
      | Record<string, unknown>
      | undefined;
    return {
      id: user.id,
      userHandle: user.userHandle,
      handle: user.userHandle,
      displayName: user.displayName,
      clanId: user.clan?.id ?? null,
      clanName: user.clan?.name ?? null,
      address: user.address ?? null,
      evmAddress: user.evmAddress ?? null,
      firstObservedAt: String(firstObserved?.first_observed_at ?? syncedAt),
      syncedAt,
    };
  }

  saveCurrentAccount(account: FomoAccount): StoredFomoAccount {
    this.#assertOpen();
    this.#transaction(() => {
      this.saveUser(account.user, account.fetchedAt);
      this.#db.prepare(
        `INSERT INTO current_account
           (singleton_id, user_id, privy_user_id, login_email, login_method, fetched_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           user_id = excluded.user_id,
           privy_user_id = excluded.privy_user_id,
           login_email = excluded.login_email,
           login_method = excluded.login_method,
           fetched_at = excluded.fetched_at`,
      ).run(
        account.user.id,
        account.login.privyUserId,
        account.login.email,
        account.login.method,
        account.fetchedAt,
      );
    });
    return this.currentAccount()!;
  }

  currentAccount(): StoredFomoAccount | null {
    this.#assertOpen();
    const row = this.#db.prepare(
      `SELECT a.user_id, u.user_handle, u.display_name, a.privy_user_id,
              a.login_email, a.login_method, a.fetched_at
       FROM current_account a
       JOIN users u ON u.id = a.user_id
       WHERE a.singleton_id = 1`,
    ).get() as Record<string, unknown> | undefined;
    return row ? storedAccountFromRow(row) : null;
  }

  /** Upsert a batch atomically. The returned count is the number of rows processed. */
  saveSwaps(swaps: FomoSwap[], syncRunId?: number): number {
    this.#assertOpen();
    if (swaps.length === 0) return 0;
    const statement = this.#db.prepare(
      `INSERT INTO swaps
         (id, user_id, user_handle, created_at, observed_at, last_observed_at,
          in_network_id, out_network_id, in_token_address, out_token_address,
          in_trade_id, out_trade_id, in_human_amount, out_human_amount,
          human_usd_amount_in, human_usd_amount_out, last_sync_run_id, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         user_handle = excluded.user_handle,
         created_at = excluded.created_at,
         last_observed_at = excluded.last_observed_at,
         in_network_id = excluded.in_network_id,
         out_network_id = excluded.out_network_id,
         in_token_address = excluded.in_token_address,
         out_token_address = excluded.out_token_address,
         in_trade_id = excluded.in_trade_id,
         out_trade_id = excluded.out_trade_id,
         in_human_amount = excluded.in_human_amount,
         out_human_amount = excluded.out_human_amount,
         human_usd_amount_in = excluded.human_usd_amount_in,
         human_usd_amount_out = excluded.human_usd_amount_out,
         last_sync_run_id = excluded.last_sync_run_id,
         raw_json = excluded.raw_json`,
    );

    this.#transaction(() => {
      for (const swap of swaps) {
        statement.run(
          swap.id,
          swap.userId,
          swap.userHandle,
          swap.createdAt,
          swap.observedAt,
          swap.observedAt,
          swap.inNetworkId,
          swap.outNetworkId,
          swap.inTokenAddress,
          swap.outTokenAddress,
          swap.inTradeId,
          swap.outTradeId,
          swap.inHumanAmount,
          swap.outHumanAmount,
          swap.humanUsdAmountIn,
          swap.humanUsdAmountOut,
          syncRunId ?? null,
          stringifyJson(swap),
        );
      }
    });
    return swaps.length;
  }

  saveRawPage(syncRunId: number, page: RawFomoPage): number {
    this.#assertOpen();
    const json = Buffer.from(stringifyJson(page.response), "utf8");
    const compressed = gzipSync(json);
    const sha256 = createHash("sha256").update(json).digest("hex");
    const result = this.#db
      .prepare(
        `INSERT INTO raw_pages
           (sync_run_id, endpoint, page_number, cursor, fetched_at, body_gzip, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        syncRunId,
        page.endpoint,
        page.pageNumber,
        page.cursor,
        page.fetchedAt,
        compressed,
        sha256,
      );
    return Number(result.lastInsertRowid);
  }

  dataset(handles?: string[]): ResearchDataset {
    this.#assertOpen();
    const cleanHandles = handles?.map((handle) => handle.trim().replace(/^@/, "")).filter(Boolean);
    if (cleanHandles && cleanHandles.length === 0) return { users: [], swaps: [] };
    const placeholders = cleanHandles?.map(() => "?").join(", ");
    const userSql = `SELECT id, user_handle, display_name, clan_id, clan_name, solana_address, evm_address,
        first_observed_at, synced_at
      FROM users${placeholders ? ` WHERE user_handle COLLATE NOCASE IN (${placeholders})` : ""}
      ORDER BY user_handle COLLATE NOCASE`;
    const swapSql = `SELECT s.* FROM swaps s
      JOIN users u ON u.id = s.user_id
      ${placeholders ? `WHERE u.user_handle COLLATE NOCASE IN (${placeholders})` : ""}
      ORDER BY s.created_at, s.id`;
    const params = cleanHandles ?? [];
    const userRows = this.#db.prepare(userSql).all(...params) as Record<string, unknown>[];
    const swapRows = this.#db.prepare(swapSql).all(...params) as Record<string, unknown>[];
    return {
      users: userRows.map(storedUserFromRow),
      swaps: swapRows.map(swapFromRow),
    };
  }

  status(): FomoStoreStatus {
    this.#assertOpen();
    const counts = this.#db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM swaps) AS swaps,
           (SELECT COUNT(*) FROM raw_pages) AS raw_pages`,
      )
      .get() as Record<string, unknown>;
    const latest = this.#db.prepare("SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    return {
      databasePath: this.databasePath,
      users: Number(counts.users),
      swaps: Number(counts.swaps),
      rawPages: Number(counts.raw_pages),
      lastSync: latest ? this.#syncSummary(Number(latest.id)) : null,
    };
  }

  /** User IDs whose latest attempted refresh failed or reached its page cap. */
  incompleteUserIds(): Set<string> {
    this.#assertOpen();
    const rows = this.#db.prepare(
      `SELECT u.id,
         (SELECT s.status FROM sync_runs s
          WHERE s.user_id = u.id OR s.handle = u.user_handle COLLATE NOCASE
          ORDER BY s.id DESC LIMIT 1) AS latest_status,
         (SELECT s.truncated FROM sync_runs s
          WHERE s.user_id = u.id OR s.handle = u.user_handle COLLATE NOCASE
          ORDER BY s.id DESC LIMIT 1) AS latest_truncated
       FROM users u`,
    ).all() as Record<string, unknown>[];
    return new Set(rows.filter((row) =>
      row.latest_status != null
      && (row.latest_status !== "completed" || Number(row.latest_truncated) === 1)
    ).map((row) => String(row.id)));
  }

  /** User IDs whose latest attempted refresh completed without reaching its page cap. */
  completedUserIds(): Set<string> {
    this.#assertOpen();
    const rows = this.#db.prepare(
      `SELECT u.id,
         (SELECT s.status FROM sync_runs s
          WHERE s.user_id = u.id OR s.handle = u.user_handle COLLATE NOCASE
          ORDER BY s.id DESC LIMIT 1) AS latest_status,
         (SELECT s.truncated FROM sync_runs s
          WHERE s.user_id = u.id OR s.handle = u.user_handle COLLATE NOCASE
          ORDER BY s.id DESC LIMIT 1) AS latest_truncated
       FROM users u`,
    ).all() as Record<string, unknown>[];
    return new Set(rows.filter((row) =>
      row.latest_status === "completed" && Number(row.latest_truncated) !== 1
    ).map((row) => String(row.id)));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #syncSummary(runId: number): FomoSyncSummary {
    const row = this.#db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Unknown Fomo sync run ${runId}`);
    return {
      handle: String(row.handle),
      userId: nullableString(row.user_id),
      startedAt: String(row.started_at),
      completedAt: nullableString(row.completed_at),
      swapCount: Number(row.swaps_saved),
      rawPageCount: Number(row.raw_pages_saved),
      status: syncState(row.status),
      ...(Number(row.truncated) === 1 ? { truncated: true } : {}),
      ...(row.error == null ? {} : { error: String(row.error) }),
    };
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    let version = Number(row.user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Fomo database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.#transaction(() => {
        this.#db.exec(`
          CREATE TABLE sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            handle TEXT NOT NULL,
            user_id TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
            swaps_saved INTEGER NOT NULL DEFAULT 0,
            raw_pages_saved INTEGER NOT NULL DEFAULT 0,
            truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
            error TEXT
          );

          CREATE TABLE raw_pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            cursor TEXT,
            fetched_at TEXT NOT NULL,
            body_gzip BLOB NOT NULL,
            sha256 TEXT NOT NULL
          );

          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            user_handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
            display_name TEXT,
            clan_id TEXT,
            clan_name TEXT,
            solana_address TEXT,
            evm_address TEXT,
            first_observed_at TEXT NOT NULL,
            synced_at TEXT NOT NULL,
            raw_json TEXT NOT NULL
          );

          CREATE TABLE current_account (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            user_id TEXT NOT NULL REFERENCES users(id),
            privy_user_id TEXT NOT NULL,
            login_email TEXT NOT NULL,
            login_method TEXT NOT NULL CHECK (login_method IN ('apple', 'google', 'email')),
            fetched_at TEXT NOT NULL
          );

          CREATE TABLE swaps (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            user_handle TEXT NOT NULL,
            created_at TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            last_observed_at TEXT NOT NULL,
            in_network_id TEXT NOT NULL,
            out_network_id TEXT NOT NULL,
            in_token_address TEXT NOT NULL,
            out_token_address TEXT NOT NULL,
            in_trade_id TEXT,
            out_trade_id TEXT,
            in_human_amount TEXT NOT NULL,
            out_human_amount TEXT NOT NULL,
            human_usd_amount_in TEXT,
            human_usd_amount_out TEXT,
            last_sync_run_id INTEGER REFERENCES sync_runs(id),
            raw_json TEXT NOT NULL
          );

          CREATE INDEX swaps_user_created_idx ON swaps(user_id, created_at);
          CREATE INDEX raw_pages_run_idx ON raw_pages(sync_run_id, page_number);
          PRAGMA user_version = 4;
        `);
      });
      return;
    }
    if (version === 1) {
      this.#transaction(() => {
        this.#db.exec(`
          ALTER TABLE users ADD COLUMN solana_address TEXT;
          ALTER TABLE users ADD COLUMN evm_address TEXT;
          PRAGMA user_version = 2;
        `);
      });
      version = 2;
    }
    if (version === 2) {
      this.#transaction(() => {
        this.#db.exec(`
          CREATE TABLE current_account (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            user_id TEXT NOT NULL REFERENCES users(id),
            privy_user_id TEXT NOT NULL,
            login_email TEXT NOT NULL,
            login_method TEXT NOT NULL CHECK (login_method IN ('apple', 'google', 'email')),
            fetched_at TEXT NOT NULL
          );
          PRAGMA user_version = 3;
        `);
      });
      version = 3;
    }
    if (version === 3) {
      this.#transaction(() => {
        this.#db.exec(`
          ALTER TABLE users ADD COLUMN first_observed_at TEXT;
          UPDATE users SET first_observed_at = synced_at;
          ALTER TABLE sync_runs ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1));
          PRAGMA user_version = 4;
        `);
      });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Fomo store is closed");
  }
}

function storedUserFromRow(row: Record<string, unknown>): StoredFomoUser {
  return {
    id: String(row.id),
    userHandle: String(row.user_handle),
    handle: String(row.user_handle),
    displayName: nullableString(row.display_name),
    clanId: nullableString(row.clan_id),
    clanName: nullableString(row.clan_name),
    address: nullableString(row.solana_address),
    evmAddress: nullableString(row.evm_address),
    firstObservedAt: String(row.first_observed_at ?? row.synced_at),
    syncedAt: String(row.synced_at),
  };
}

function storedAccountFromRow(row: Record<string, unknown>): StoredFomoAccount {
  const loginMethod = String(row.login_method);
  if (loginMethod !== "apple" && loginMethod !== "google" && loginMethod !== "email") {
    throw new Error(`Invalid stored Fomo login method: ${loginMethod}`);
  }
  return {
    userId: String(row.user_id),
    userHandle: String(row.user_handle),
    displayName: nullableString(row.display_name),
    privyUserId: String(row.privy_user_id),
    email: String(row.login_email),
    loginMethod: loginMethod as FomoLoginMethod,
    fetchedAt: String(row.fetched_at),
  };
}

function swapFromRow(row: Record<string, unknown>): FomoSwap {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    userHandle: String(row.user_handle),
    createdAt: String(row.created_at),
    observedAt: String(row.observed_at),
    inNetworkId: String(row.in_network_id),
    outNetworkId: String(row.out_network_id),
    inTokenAddress: String(row.in_token_address),
    outTokenAddress: String(row.out_token_address),
    inTradeId: nullableString(row.in_trade_id),
    outTradeId: nullableString(row.out_trade_id),
    inHumanAmount: String(row.in_human_amount),
    outHumanAmount: String(row.out_human_amount),
    humanUsdAmountIn: nullableString(row.human_usd_amount_in),
    humanUsdAmountOut: nullableString(row.human_usd_amount_out),
  };
}

function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Cannot store an undefined Fomo response");
  return json;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function syncState(value: unknown): FomoSyncSummary["status"] {
  if (value === "running" || value === "completed" || value === "failed") return value;
  throw new Error(`Invalid stored Fomo sync status: ${String(value)}`);
}

function tryChmod(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // Permissions are best-effort on filesystems that do not implement chmod.
  }
}
