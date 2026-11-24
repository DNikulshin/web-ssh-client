import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';

export type Db = DatabaseSync;

const SCHEMA_FILE = new URL('./schema.sql', import.meta.url);

/**
 * Открывает БД в режиме, рассчитанном на жёсткие перезагрузки:
 *  - WAL + synchronous=FULL: коммит подтверждается только после записи на диск;
 *  - busy_timeout: веб-слой и воркеры пишут в один файл, короткая блокировка не превращается в ошибку;
 *  - foreign_keys: осиротевшие сессии и креды не накапливаются.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') restrictPermissions(path);
  return db;
}

/**
 * В базе шифротекст, но читать её посторонним всё равно незачем. -wal и -shm создаёт сам
 * SQLite в момент первой записи, поэтому одного chmod при открытии мало: список файлов
 * фиксируется после PRAGMA, а umask выставляется в точках входа.
 */
export function restrictPermissions(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path + suffix;
    if (existsSync(file)) {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* файл мог исчезнуть между проверкой и chmod — не повод падать */
      }
    }
  }
}

export function migrate(db: Db): number {
  const sql = readFileSync(SCHEMA_FILE, 'utf8');
  db.exec(sql);
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function openAndMigrate(path: string): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}

export function now(): number {
  return Date.now();
}

export function newId(): string {
  return randomUUID();
}

/** Тонкая обёртка: возвращает одну строку или undefined, без приведения типов на каждом вызове. */
export function getRow<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function allRows<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function dataFileExists(path: string): boolean {
  return existsSync(path);
}
