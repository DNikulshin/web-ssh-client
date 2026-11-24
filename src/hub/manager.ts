import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { getRow, allRows, now, type Db } from '../db/index.ts';

/**
 * Управление воркерами сессий. Живёт внутри веб-слоя: отдельный демон-хаб добавил бы
 * ещё одну точку отказа, ничего не давая — воркеры всё равно запускаются с `detached`,
 * поэтому переживают и падение веб-слоя, и его перезапуск.
 *
 * Инвариант: источник правды о том, жива ли сессия, — не БД, а живой Unix-сокет воркера.
 * БД может врать после SIGKILL, сокет — нет.
 */

export interface SessionRow {
  id: string;
  status: 'starting' | 'active' | 'detached' | 'exited' | 'lost';
  worker_pid: number | null;
  socket_path: string | null;
}

export function sessionSocketPath(stateDir: string, sessionId: string): string {
  return join(stateDir, `session-${sessionId}.sock`);
}

function workerEntry(): string {
  // Один и тот же код гоняется из src (.ts, Node 22+ со стриппингом типов) и из dist (.js).
  const here = new URL(import.meta.url);
  const ext = here.pathname.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./worker.${ext}`, import.meta.url).pathname;
}

export function isSocketAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(false);
    const socket = net.connect(path);
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function spawnSession(
  db: Db,
  sessionId: string,
  opts: { fake?: boolean } = {},
): Promise<{ pid: number; socketPath: string }> {
  const socketPath = sessionSocketPath(config.stateDir, sessionId);
  const args = [workerEntry(), sessionId, socketPath, ...(opts.fake ? ['--fake'] : [])];

  // detached + stdio ignore — именно поэтому воркер переживает смерть родителя:
  // он не в его группе процессов и не висит на его пайпах.
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const pid = child.pid;
  if (!pid) throw new Error('воркер не запустился: нет pid');
  db.prepare('UPDATE sessions SET status = ?, worker_pid = ?, socket_path = ? WHERE id = ?').run(
    'starting',
    pid,
    socketPath,
    sessionId,
  );

  // Ждём сокет: воркер слушает его до подключения к SSH, поэтому ожидание короткое,
  // но не мгновенное — даём процессу шанс упасть с внятной ошибкой в БД.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isSocketAlive(socketPath, 200)) return { pid, socketPath };
    if (!isPidAlive(pid)) break;
    await sleep(100);
  }
  db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('lost', sessionId);
  throw new Error(`воркер сессии ${sessionId} не поднял сокет (pid ${pid})`);
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(db: Db, sessionId: string, graceMs = 3000): Promise<boolean> {
  const row = getRow<{ worker_pid: number | null }>(db, 'SELECT worker_pid FROM sessions WHERE id = ?', sessionId);
  const pid = row?.worker_pid ?? null;
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* процесс уже ушёл */
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isPidAlive(pid)) await sleep(50);
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?').run('exited', now(), sessionId);
  return true;
}

export interface ReconcileResult {
  id: string;
  before: SessionRow['status'];
  after: SessionRow['status'];
}

/**
 * Сверка БД с реальностью. Вызывается при старте веб-слоя и периодически: после жёсткой
 * перезагрузки хоста в БД остаются «active», которых уже нет, и клиент должен увидеть это
 * как факт, а не как бесконечный reconnect.
 */
export async function reconcile(db: Db): Promise<ReconcileResult[]> {
  const rows = allRows<SessionRow>(
    db,
    `SELECT id, status, worker_pid, socket_path FROM sessions
     WHERE status IN ('starting', 'active', 'detached')`,
  );
  const results: ReconcileResult[] = [];
  for (const row of rows) {
    const socketPath = row.socket_path ?? sessionSocketPath(config.stateDir, row.id);
    const alive = await isSocketAlive(socketPath);
    if (alive) {
      // Воркер сам выставит active/detached по факту подключений клиентов;
      // здесь трогаем только «застрявший» starting.
      if (row.status === 'starting') {
        db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('active', row.id);
        results.push({ id: row.id, before: row.status, after: 'active' });
      }
      continue;
    }
    db.prepare('UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(
      'lost',
      now(),
      row.id,
    );
    results.push({ id: row.id, before: row.status, after: 'lost' });
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
