#!/usr/bin/env node
/**
 * Операции без веб-интерфейса: посмотреть сессии, добить зависшую, сверить БД с реальностью.
 * Специально отдельный процесс: чинить состояние надо уметь, когда веб-слой не поднимается.
 */
import { config, ensureDirs } from '../config.ts';
import { openAndMigrate, allRows } from '../db/index.ts';
import { isSocketAlive, isPidAlive, killSession, reconcile, sessionSocketPath } from './manager.ts';

// Umask до создания любых файлов: БД, мастер-ключ и сокеты не должны быть доступны соседям.
process.umask(0o077);

const cmd = process.argv[2] ?? 'status';

ensureDirs();
const db = openAndMigrate(config.dbPath);

interface Row {
  id: string;
  title: string;
  status: string;
  worker_pid: number | null;
  socket_path: string | null;
  last_seq: number;
}

async function status(): Promise<void> {
  const rows = allRows<Row>(
    db,
    `SELECT id, title, status, worker_pid, socket_path, last_seq FROM sessions
     WHERE status IN ('starting','active','detached') ORDER BY created_at DESC`,
  );
  if (rows.length === 0) {
    console.log('живых сессий нет');
    return;
  }
  for (const row of rows) {
    const alive = await isSocketAlive(row.socket_path ?? sessionSocketPath(config.stateDir, row.id));
    const pidOk = row.worker_pid ? isPidAlive(row.worker_pid) : false;
    console.log(
      `${row.id.slice(0, 8)}  ${row.status.padEnd(9)} pid=${String(row.worker_pid ?? '-').padEnd(8)} ` +
        `сокет=${alive ? 'жив' : 'мёртв'} pid=${pidOk ? 'жив' : 'мёртв'}  ${row.title}`,
    );
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'status':
      await status();
      break;
    case 'reconcile': {
      const changed = await reconcile(db);
      if (changed.length === 0) console.log('расхождений нет');
      for (const c of changed) console.log(`${c.id}: ${c.before} → ${c.after}`);
      break;
    }
    case 'kill': {
      const id = process.argv[3];
      if (!id) throw new Error('usage: cli.ts kill <sessionId>');
      await killSession(db, id);
      console.log(`сессия ${id} остановлена`);
      break;
    }
    default:
      console.log(`неизвестная команда: ${cmd}. Доступно: status | reconcile | kill <id>`);
      process.exitCode = 2;
  }
  db.close();
}

void main();
