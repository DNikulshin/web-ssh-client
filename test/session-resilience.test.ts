import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Проверка главного обещания сервиса: сессия живёт в отдельном процессе, поэтому
 *  - отключение клиента её не убивает (detached, а не exited);
 *  - повторное подключение возвращает историю вывода;
 *  - SIGKILL воркера не стирает уже записанный вывод из БД;
 *  - сверка честно помечает такую сессию как потерянную.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'wssh-resilience-'));
process.env.WEB_SSH_DATA_DIR = dataDir;

const { config } = await import('../src/config.ts');
const { openAndMigrate, getRow, allRows } = await import('../src/db/index.ts');
const { spawnSession, reconcile, sessionSocketPath, isPidAlive } = await import('../src/hub/manager.ts');
const { FrameDecoder, encodeControl, FRAME_OUT } = await import('../src/proto/frames.ts');

interface Control {
  t: string;
  [k: string]: unknown;
}

interface Agent {
  socket: net.Socket;
  controls: Control[];
  output: () => string;
  send: (msg: Control) => void;
  waitFor: (pred: () => boolean, what: string, timeoutMs?: number) => Promise<void>;
  close: () => void;
}

function attach(path: string): Promise<Agent> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const decoder = new FrameDecoder();
    const controls: Control[] = [];
    let out = Buffer.alloc(0);

    const agent = {
      socket,
      controls,
      output: () => out.toString('utf8'),
      send: (msg: Control) => socket.write(encodeControl(msg as never)),
      waitFor: async (pred: () => boolean, what: string, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (pred()) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`не дождались: ${what}`);
      },
      close: () => socket.destroy(),
    };

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FRAME_OUT) out = Buffer.concat([out, frame.payload]);
        else controls.push(JSON.parse(frame.payload.toString('utf8')) as Control);
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => resolve(agent));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('сессия переживает отключение клиента, переподключение и SIGKILL воркера', async (t) => {
  const db = openAndMigrate(config.dbPath);
  const userId = 'user-test';
  const sessionId = 'sess-resilience';
  const ts = Date.now();

  db.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    userId,
    'tester',
    'scrypt$1$1$1$AA$AA',
    ts,
  );
  db.prepare(
    `INSERT INTO sessions (id, user_id, host_id, title, status, rows, cols, created_at)
     VALUES (?, ?, NULL, ?, 'starting', 24, 80, ?)`,
  ).run(sessionId, userId, 'fake', ts);

  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const { pid } = await spawnSession(db, sessionId, { fake: true });
  assert.ok(isPidAlive(pid), 'воркер должен быть живым процессом');

  // 1. Клиент подключается и получает вывод.
  const first = await attach(sessionSocketPath(config.stateDir, sessionId));
  await first.waitFor(() => first.controls.some((c) => c.t === 'hello'), 'hello');
  first.send({ t: 'attach', from: 0 });
  await first.waitFor(() => first.controls.some((c) => c.t === 'attached'), 'attached');
  await first.waitFor(() => first.output().includes('[fake] tick'), 'живой вывод');

  const echoCheck = first.output().length;
  first.close();
  await sleep(400);

  // 2. Клиента нет — сессия detached, процесс жив.
  const afterDetach = getRow<{ status: string }>(db, 'SELECT status FROM sessions WHERE id = ?', sessionId);
  assert.equal(afterDetach?.status, 'detached', 'сессия обязана остаться живой без клиента');
  assert.ok(isPidAlive(pid));

  // 3. Повторное подключение отдаёт историю с нуля.
  const second = await attach(sessionSocketPath(config.stateDir, sessionId));
  await second.waitFor(() => second.controls.some((c) => c.t === 'hello'), 'hello #2');
  second.send({ t: 'attach', from: 0 });
  await second.waitFor(() => second.controls.some((c) => c.t === 'attached'), 'attached #2');
  const attachedMsg = second.controls.find((c) => c.t === 'attached')!;
  assert.ok(Number(attachedMsg.replayedBytes) > 0, 'при reconnect должен прийти replay из ring-буфера');
  await second.waitFor(() => second.output().length >= echoCheck, 'replay истории');
  second.close();

  // 4. SIGKILL: вывод, уже записанный в БД, обязан уцелеть.
  process.kill(pid, 'SIGKILL');
  await sleep(500);
  assert.equal(isPidAlive(pid), false, 'воркер должен умереть от SIGKILL');

  const chunks = allRows<{ n: number; bytes: number }>(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS bytes FROM session_chunks WHERE session_id = ?`,
    sessionId,
  )[0]!;
  assert.ok(chunks.n > 0, 'чанки вывода должны быть на диске до смерти процесса');
  assert.ok(chunks.bytes > 0);
  assert.equal(
    existsSync(sessionSocketPath(config.stateDir, sessionId)),
    true,
    'сокет остаётся файлом — поэтому живость проверяется подключением, а не наличием файла',
  );

  // 5. Сверка помечает сессию потерянной, а не вечно активной.
  const changes = await reconcile(db);
  assert.ok(!isPidAlive(pid), 'сокет без процесса не должен считаться живым');
  assert.equal(
    changes.find((c) => c.id === sessionId)?.after,
    'lost',
    `ожидали lost, получили ${JSON.stringify(changes)}`,
  );

  db.close();
});
