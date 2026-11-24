import net from 'node:net';
import { unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { Client } from 'ssh2';
import { createVault } from '../vault.ts';
import { openAndMigrate, getRow, now } from '../db/index.ts';
import { config, ensureDirs } from '../config.ts';
import {
  FRAME_CONTROL,
  FRAME_IN,
  FRAME_OUT,
  FrameDecoder,
  decodeControl,
  encodeFrame,
  type Control,
  type SessionStatus,
} from '../proto/frames.ts';

// Umask до создания любых файлов: БД, мастер-ключ и сокеты не должны быть доступны соседям.
process.umask(0o077);

/**
 * Воркер одной сессии: отдельный процесс, который держит SSH-соединение и переживает
 * перезапуск веб-слоя и хаба. Смерть веб-слоя не должна рвать терминал — поэтому SSH живёт
 * здесь, а не в HTTP-сервере, и клиенты подключаются к воркеру напрямую по Unix-сокету.
 */

interface SessionRow {
  id: string;
  user_id: string;
  host_id: string | null;
  title: string;
  rows: number;
  cols: number;
  last_seq: number;
  status: string;
}

interface HostRow {
  id: string;
  host: string;
  port: number;
  username: string;
  credential_id: string | null;
}

interface CredRow {
  id: string;
  kind: 'password' | 'key';
  aad: string;
  iv: string;
  tag: string;
  ciphertext: string;
  cipher: string;
  key_version: number;
  passphrase_enc: string | null;
}

interface ClientConn {
  socket: net.Socket;
  decoder: FrameDecoder;
  attached: boolean;
}

interface RingChunk {
  seq: number;
  data: Buffer;
}

const sessionIdArg = process.argv[2];
const socketPathArg = process.argv[3];
const fakeMode = process.argv.includes('--fake');

if (!sessionIdArg || !socketPathArg) {
  console.error('usage: worker.ts <sessionId> <socketPath> [--fake]');
  process.exit(2);
}

// Явная аннотация: сужение через process.exit не переносится в замыкания, а воркер —
// это сплошные замыкания на sessionId/socketPath.
const sessionId: string = sessionIdArg;
const socketPath: string = socketPathArg;

ensureDirs();
const db = openAndMigrate(config.dbPath);
const vault = createVault({ keyFile: config.masterKeyFile });

const foundSession = getRow<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', sessionId);
if (!foundSession) {
  console.error(`[worker ${sessionId}] сессии нет в БД`);
  process.exit(3);
}
const session: SessionRow = foundSession;

let seq = session.last_seq;
let status: SessionStatus = 'starting';
let rows = session.rows;
let cols = session.cols;
let stream: { write: (d: Buffer | string) => boolean; setWindow: (r: number, c: number, h: number, w: number) => void; close: () => void; stderr?: { on: (e: string, cb: (d: Buffer) => void) => void }; on: (e: string, cb: (...a: any[]) => void) => void } | null = null;
let ssh: Client | null = null;
let fakeTimer: NodeJS.Timeout | null = null;

const clients = new Set<ClientConn>();
const ring: RingChunk[] = [];
let ringBytes = 0;

// ── Запись вывода: сначала в память (ring), затем пачкой в БД ──────────────────────────
// Пачка нужна не для экономии места, а для fsync: synchronous=FULL означает, что каждая
// транзакция ждёт диск. Писать по одному байту — гарантированная деградация на `yes`.
let pendingOut: Buffer[] = [];
let pendingBytes = 0;
let flushTimer: NodeJS.Timeout | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushOutput();
  }, 25);
}

function flushOutput(): void {
  if (pendingOut.length === 0) return;
  const chunk = Buffer.concat(pendingOut);
  const bytes = chunk.length;
  pendingOut = [];
  pendingBytes = 0;

  const nextSeq = seq + 1;
  db.prepare(
    `INSERT INTO session_chunks (session_id, seq, ts, dir, data) VALUES (?, ?, ?, 'out', ?)`,
  ).run(sessionId, nextSeq, now(), chunk);
  db.prepare('UPDATE sessions SET last_seq = ? WHERE id = ?').run(nextSeq, sessionId);
  seq = nextSeq;

  ring.push({ seq, data: chunk });
  ringBytes += bytes;
  while (ringBytes > config.ringBytes && ring.length > 1) {
    const dropped = ring.shift()!;
    ringBytes -= dropped.data.length;
  }

  // Ретенция: держим не больше config.scrollbackBytes всего вывода сессии.
  const total = getRow<{ b: number }>(
    db,
    `SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM session_chunks WHERE session_id = ? AND dir = 'out'`,
    sessionId,
  );
  if (total && total.b > config.scrollbackBytes) {
    const excess = total.b - config.scrollbackBytes;
    const oldest = db
      .prepare(
        `SELECT seq, LENGTH(data) AS len FROM session_chunks
         WHERE session_id = ? AND dir = 'out' ORDER BY seq ASC`,
      )
      .all(sessionId) as { seq: number; len: number }[];
    let freed = 0;
    const doomed: number[] = [];
    for (const row of oldest) {
      if (freed >= excess) break;
      doomed.push(row.seq);
      freed += row.len;
    }
    if (doomed.length > 0) {
      const placeholders = doomed.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM session_chunks WHERE session_id = ? AND dir = 'out' AND seq IN (${placeholders})`,
      ).run(sessionId, ...doomed);
    }
  }
}

function onOutput(data: Buffer): void {
  for (const c of clients) {
    if (!c.attached) continue;
    writeFrame(c.socket, FRAME_OUT, data);
  }
  pendingOut.push(data);
  pendingBytes += data.length;
  // Крупный вывод не ждёт таймера: 64 КиБ — уже повод записать.
  if (pendingBytes >= 64 * 1024) flushOutput();
  else scheduleFlush();
}

function writeFrame(socket: net.Socket, type: 1 | 2 | 3, payload: Buffer): void {
  if (socket.destroyed) return;
  // Медленный читатель: буфер сокета растёт быстрее, чем приложение читает.
  // Рвать соединение лучше, чем растить память воркера до OOM и уносить чужие сессии.
  if (socket.writableLength > 16 * 1024 * 1024) {
    socket.destroy(new Error('slow consumer'));
    return;
  }
  socket.write(encodeFrame(type, payload));
}

function sendControl(c: ClientConn, msg: Control): void {
  writeFrame(c.socket, FRAME_CONTROL, Buffer.from(JSON.stringify(msg), 'utf8'));
}

function setStatus(next: SessionStatus, extra: { exitCode?: number | null } = {}): void {
  status = next;
  if (next === 'exited' || next === 'lost') {
    db.prepare('UPDATE sessions SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?').run(
      next,
      extra.exitCode ?? null,
      now(),
      sessionId,
    );
  } else {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(next, sessionId);
  }
  for (const c of clients) {
    if (c.attached) sendControl(c, { t: 'status', status: next });
  }
}

// ── Транспорт: настоящий SSH или локальный эхо-режим для тестов ────────────────────────
function startFakeTransport(): void {
  let counter = 0;
  fakeTimer = setInterval(() => {
    counter += 1;
    onOutput(Buffer.from(`[fake] tick ${counter}\r\n`));
  }, 250);
  stream = {
    write(data) {
      onOutput(Buffer.from(`[fake-echo] ${data.toString('utf8')}`));
      return true;
    },
    setWindow(r, c) {
      rows = r;
      cols = c;
    },
    close() {
      if (fakeTimer) clearInterval(fakeTimer);
      finish(0);
    },
    on() {},
  };
  setStatus('active');
}

function startSshTransport(): void {
  if (!session.host_id) {
    fail('у сессии нет хоста');
    return;
  }
  const host = getRow<HostRow>(db, 'SELECT * FROM hosts WHERE id = ?', session.host_id);
  if (!host) {
    fail('хост сессии удалён');
    return;
  }
  let password: string | undefined;
  let privateKey: string | undefined;
  let passphrase: string | undefined;

  if (host.credential_id) {
    const cred = getRow<CredRow>(db, 'SELECT * FROM credentials WHERE id = ?', host.credential_id);
    if (!cred) {
      fail('креденшл хоста удалён');
      return;
    }
    const secret = vault.openText(
      { cipher: 'aes-256-gcm', keyVersion: cred.key_version, iv: cred.iv, tag: cred.tag, ciphertext: cred.ciphertext },
      cred.aad,
    );
    if (cred.kind === 'password') password = secret;
    else privateKey = secret;

    if (cred.passphrase_enc) {
      const envelope = JSON.parse(cred.passphrase_enc) as Record<string, string | number>;
      passphrase = vault.openText(envelope as never, cred.aad + ':passphrase');
    }
  }

  ssh = new Client();
  ssh.on('ready', () => {
    ssh!.shell({ term: 'xterm-256color', rows, cols }, (err, ch) => {
      if (err) {
        fail(`shell: ${err.message}`);
        return;
      }
      stream = ch as never;
      setStatus('active');
      ch.on('data', (data: Buffer) => onOutput(data));
      ch.stderr?.on('data', (data: Buffer) => onOutput(data));
      ch.on('close', (code: number | null, signal?: string) => {
        finish(code ?? null, signal);
      });
    });
  });
  ssh.on('error', (err: Error) => fail(`SSH: ${err.message}`));
  ssh.on('close', () => {
    if (status !== 'exited' && status !== 'lost') finish(null);
  });

  ssh.connect({
    host: host.host,
    port: host.port,
    username: host.username,
    // keepalive важнее таймаутов: мобильный клиент уходит в сон, соединение должно выжить.
    keepaliveInterval: 15_000,
    keepaliveCountMax: 6,
    readyTimeout: 20_000,
    ...(privateKey ? { privateKey, passphrase } : { password }),
  });
}

function fail(message: string): void {
  for (const c of clients) sendControl(c, { t: 'error', message });
  setStatus('lost');
  cleanupAndExit(1);
}

function finish(code: number | null, signal?: string): void {
  flushOutput();
  if (fakeTimer) clearInterval(fakeTimer);
  setStatus('exited', { exitCode: code });
  for (const c of clients) {
    sendControl(c, { t: 'exit', code, ...(signal ? { signal } : {}) });
  }
  ssh?.end();
  // Дать клиентам дочитать кадр exit, но не висеть вечно.
  setTimeout(() => cleanupAndExit(0), 150);
}

function cleanupAndExit(code: number): void {
  flushOutput();
  if (flushTimer) clearTimeout(flushTimer);
  for (const c of clients) c.socket.end();
  server.close();
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    if (existsSync(pidFile())) unlinkSync(pidFile());
  } catch {
    /* файлы мог убрать хаб */
  }
  process.exit(code);
}

function pidFile(): string {
  return `${socketPath}.pid`;
}

// ── Сервер сокета: клиенты (веб-слой, повторные подключения) ──────────────────────────
const server = net.createServer((socket) => {
  const client: ClientConn = { socket, decoder: new FrameDecoder(), attached: false };
  clients.add(client);

  sendControl(client, { t: 'hello', sessionId: sessionId, status, rows, cols, lastSeq: seq, pid: process.pid });

  socket.on('data', (chunk) => {
    let frames;
    try {
      frames = client.decoder.push(chunk);
    } catch (err) {
      socket.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const frame of frames) {
      if (frame.type === FRAME_IN) {
        stream?.write(frame.payload);
        continue;
      }
      if (frame.type !== FRAME_CONTROL) continue;
      let msg: Control;
      try {
        msg = decodeControl(frame);
      } catch {
        continue;
      }
      handleControl(client, msg);
    }
  });

  socket.on('error', () => {
    clients.delete(client);
  });
  socket.on('close', () => {
    const wasAttached = client.attached;
    clients.delete(client);
    if (wasAttached && attachedCount() === 0 && status === 'active') {
      // Никого не осталось — сессия живёт дальше, но факт надо записать:
      // иначе после перезагрузки нельзя отличить «ушли» от «воркер умер».
      db.prepare('UPDATE sessions SET status = ?, attached_at = ? WHERE id = ?').run('detached', now(), sessionId);
      status = 'detached';
    }
  });
});

function attachedCount(): number {
  let n = 0;
  for (const c of clients) if (c.attached) n += 1;
  return n;
}

function handleControl(client: ClientConn, msg: Control): void {
  switch (msg.t) {
    case 'attach': {
      const from = msg.from ?? 0;
      let replayed = 0;
      for (const chunk of ring) {
        if (chunk.seq <= from) continue;
        writeFrame(client.socket, FRAME_OUT, chunk.data);
        replayed += chunk.data.length;
      }
      client.attached = true;
      db.prepare('UPDATE sessions SET attached_at = ? WHERE id = ?').run(now(), sessionId);
      if (status === 'detached') setStatus('active');
      sendControl(client, { t: 'attached', fromSeq: from, replayedBytes: replayed });
      return;
    }
    case 'resize': {
      rows = msg.rows;
      cols = msg.cols;
      stream?.setWindow(msg.rows, msg.cols, 0, 0);
      db.prepare('UPDATE sessions SET rows = ?, cols = ? WHERE id = ?').run(rows, cols, sessionId);
      return;
    }
    case 'ping':
      sendControl(client, { t: 'pong', at: msg.at });
      return;
    case 'detach':
      client.attached = false;
      client.socket.end();
      return;
    default:
      return;
  }
}

process.on('SIGTERM', () => {
  // Мягкая остановка: закрываем SSH честно, чтобы удалённая сторона не ждала таймаута.
  finish(null, 'SIGTERM');
});
process.on('uncaughtException', (err) => {
  console.error(`[worker ${sessionId}] uncaught: ${err.message}`);
  try {
    setStatus('lost');
    flushOutput();
  } catch {
    /* best effort */
  }
  process.exit(1);
});

// Сокет мог остаться от прошлого запуска с тем же id.
if (existsSync(socketPath)) unlinkSync(socketPath);
server.listen(socketPath, () => {
  writeFileSync(pidFile(), String(process.pid));
  db.prepare('UPDATE sessions SET worker_pid = ?, socket_path = ? WHERE id = ?').run(
    process.pid,
    socketPath,
    sessionId,
  );
  if (fakeMode) startFakeTransport();
  else startSshTransport();
});
server.on('error', (err) => {
  console.error(`[worker ${sessionId}] socket: ${err.message}`);
  process.exit(4);
});
