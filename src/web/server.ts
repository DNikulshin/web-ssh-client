import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import net from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { allRows, getRow, newId, now, type Db } from '../db/index.ts';
import { createVault, type Vault } from '../vault.ts';
import { FrameDecoder, encodeControl, encodeFrame, FRAME_CONTROL, FRAME_IN, FRAME_OUT } from '../proto/frames.ts';
import {
  HttpError,
  checkLogin,
  clearCookie,
  createUser,
  issueToken,
  requireUser,
  revokeToken,
  setCookie,
  tokenFromCookieHeader,
  userCount,
  userForToken,
  COOKIE_NAME,
  type UserRow,
} from './auth.ts';
import { isSocketAlive, killSession, sessionSocketPath, spawnSession } from '../hub/manager.ts';

export interface ServerDeps {
  db: Db;
  vault: Vault;
  publicDir?: string;
  fakeSessions?: boolean;
}

export interface SessionView {
  id: string;
  hostId: string | null;
  hostLabel: string | null;
  title: string;
  status: string;
  rows: number;
  cols: number;
  lastSeq: number;
  createdAt: number;
  attachedAt: number | null;
  endedAt: number | null;
  live: boolean;
}

interface SessionDbRow {
  id: string;
  host_id: string | null;
  title: string;
  status: string;
  rows: number;
  cols: number;
  last_seq: number;
  created_at: number;
  attached_at: number | null;
  ended_at: number | null;
  socket_path: string | null;
  host_label: string | null;
}

export async function buildServer(deps: ServerDeps) {
  const { db, vault } = deps;
  const app = Fastify({ logger: false, trustProxy: config.trustProxy });
  await app.register(cookie);
  const root = deps.publicDir ?? resolve(import.meta.dirname, '../../public');
  await app.register(fastifyStatic, { root, index: ['index.html'] });

  // xterm отдаётся из node_modules, а не с CDN: терминал обязан работать, когда внешняя
  // сеть недоступна или CDN отвечает 502, иначе «сервис жив, а консоль белая».
  const vendor = resolve(root, '../node_modules');
  await app.register(fastifyStatic, {
    root: resolve(vendor, '@xterm/xterm'),
    prefix: '/vendor/xterm/',
    decorateReply: false,
    index: false,
    cacheControl: true,
    maxAge: '7d',
  });
  await app.register(fastifyStatic, {
    root: resolve(vendor, '@xterm/addon-fit'),
    prefix: '/vendor/addon-fit/',
    decorateReply: false,
    index: false,
    cacheControl: true,
    maxAge: '7d',
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'внутренняя ошибка' });
  });

  const audit = (userId: string | null, action: string, target: string | null, ip: string | null, detail?: string) => {
    db.prepare(
      'INSERT INTO audit_log (user_id, action, target, ip, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(userId, action, target, ip, detail ?? null, now());
  };

  // ── Аутентификация ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

  app.get('/api/auth/state', async (req) => {
    const user = userForToken(db, tokenFromCookieHeader(req.headers.cookie));
    return { authenticated: Boolean(user), needsSetup: userCount(db) === 0, login: user?.login ?? null };
  });

  app.post<{ Body: { login?: string; password?: string } }>('/api/auth/register', async (req, reply) => {
    const firstUser = userCount(db) === 0;
    if (!firstUser && !config.allowRegistration) throw new HttpError(403, 'регистрация закрыта');
    const { login, password } = req.body ?? {};
    if (!login || !password) throw new HttpError(400, 'нужны login и password');
    const user = createUser(db, login, password);
    const token = issueToken(db, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, token);
    audit(user.id, 'auth.register', user.login, req.ip);
    return { ok: true, login: user.login };
  });

  app.post<{ Body: { login?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const { login, password } = req.body ?? {};
    if (!login || !password) throw new HttpError(400, 'нужны login и password');
    const user = checkLogin(db, login, password);
    if (!user) {
      audit(null, 'auth.login_failed', login, req.ip);
      throw new HttpError(401, 'неверный логин или пароль');
    }
    const token = issueToken(db, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, token);
    audit(user.id, 'auth.login', user.login, req.ip);
    return { ok: true, login: user.login };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = tokenFromCookieHeader(req.headers.cookie);
    if (token) revokeToken(db, token);
    clearCookie(reply);
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const user = await requireUser(db, req);
    return { id: user.id, login: user.login };
  });

  // ── Креды ─────────────────────────────────────────────────────────────────────────
  // Наружу отдаётся только метаинформация: секрет не покидает сервер ни при каком запросе.
  app.get('/api/credentials', async (req) => {
    const user = await requireUser(db, req);
    return allRows(
      db,
      `SELECT id, label, kind, created_at, rotated_at FROM credentials WHERE user_id = ? ORDER BY label`,
      user.id,
    );
  });

  app.post<{ Body: { label?: string; kind?: 'password' | 'key'; secret?: string; passphrase?: string } }>(
    '/api/credentials',
    async (req) => {
      const user = await requireUser(db, req);
      const { label, kind, secret, passphrase } = req.body ?? {};
      if (!label || !kind || !secret) throw new HttpError(400, 'нужны label, kind, secret');
      if (kind !== 'password' && kind !== 'key') throw new HttpError(400, 'kind: password | key');
      const id = newId();
      const aad = `credential:${id}:${user.id}`;
      const sealed = vault.seal(secret, aad);
      const passSealed = passphrase ? vault.seal(passphrase, `${aad}:passphrase`) : null;
      db.prepare(
        `INSERT INTO credentials
         (id, user_id, label, kind, cipher, key_version, aad, iv, tag, ciphertext, passphrase_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        user.id,
        label,
        kind,
        sealed.cipher,
        sealed.keyVersion,
        aad,
        sealed.iv,
        sealed.tag,
        sealed.ciphertext,
        passSealed ? JSON.stringify(passSealed) : null,
        now(),
      );
      audit(user.id, 'credential.create', id, req.ip, label);
      return { id, label, kind };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/credentials/:id', async (req) => {
    const user = await requireUser(db, req);
    const res = db
      .prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?')
      .run(req.params.id, user.id);
    audit(user.id, 'credential.delete', req.params.id, req.ip);
    if (res.changes === 0) throw new HttpError(404, 'креденшл не найден');
    return { ok: true };
  });

  // ── Хосты ─────────────────────────────────────────────────────────────────────────
  app.get('/api/hosts', async (req) => {
    const user = await requireUser(db, req);
    return allRows(
      db,
      `SELECT id, label, host, port, username, credential_id, tags, note, created_at, updated_at
       FROM hosts WHERE user_id = ? ORDER BY label`,
      user.id,
    );
  });

  app.post<{
    Body: { label?: string; host?: string; port?: number; username?: string; credentialId?: string; tags?: string[]; note?: string };
  }>('/api/hosts', async (req) => {
    const user = await requireUser(db, req);
    const { label, host, username } = req.body ?? {};
    if (!label || !host || !username) throw new HttpError(400, 'нужны label, host, username');
    const id = newId();
    db.prepare(
      `INSERT INTO hosts (id, user_id, label, host, port, username, credential_id, tags, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      user.id,
      label,
      host,
      req.body?.port ?? 22,
      username,
      req.body?.credentialId ?? null,
      JSON.stringify(req.body?.tags ?? []),
      req.body?.note ?? null,
      now(),
      now(),
    );
    audit(user.id, 'host.create', id, req.ip, `${username}@${host}`);
    return { id };
  });

  app.delete<{ Params: { id: string } }>('/api/hosts/:id', async (req) => {
    const user = await requireUser(db, req);
    const res = db.prepare('DELETE FROM hosts WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    if (res.changes === 0) throw new HttpError(404, 'хост не найден');
    return { ok: true };
  });

  // ── Сессии ────────────────────────────────────────────────────────────────────────
  const sessionView = async (row: SessionDbRow): Promise<SessionView> => {
    const socketPath = row.socket_path ?? sessionSocketPath(config.stateDir, row.id);
    const live = ['active', 'detached', 'starting'].includes(row.status)
      ? await isSocketAlive(socketPath)
      : false;
    return {
      id: row.id,
      hostId: row.host_id,
      hostLabel: row.host_label,
      title: row.title,
      status: live ? (row.status === 'starting' ? 'active' : row.status) : row.status === 'exited' ? 'exited' : 'lost',
      rows: row.rows,
      cols: row.cols,
      lastSeq: row.last_seq,
      createdAt: row.created_at,
      attachedAt: row.attached_at,
      endedAt: row.ended_at,
      live,
    };
  };

  const sessionSelect = `SELECT s.*, h.label AS host_label FROM sessions s
                         LEFT JOIN hosts h ON h.id = s.host_id WHERE s.user_id = ?`;

  app.get('/api/sessions', async (req) => {
    const user = await requireUser(db, req);
    const rows = allRows<SessionDbRow>(db, `${sessionSelect} ORDER BY s.created_at DESC LIMIT 50`, user.id);
    return Promise.all(rows.map(sessionView));
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const user = await requireUser(db, req);
    const row = getRow<SessionDbRow>(db, `${sessionSelect} AND s.id = ?`, user.id, req.params.id);
    if (!row) throw new HttpError(404, 'сессия не найдена');
    return sessionView(row);
  });

  app.post<{ Body: { hostId?: string; title?: string; rows?: number; cols?: number } }>(
    '/api/sessions',
    async (req, reply) => {
      const user = await requireUser(db, req);
      const { hostId, title } = req.body ?? {};
      if (!hostId) throw new HttpError(400, 'нужен hostId');
      const host = getRow<{ label: string; username: string; host: string }>(
        db,
        'SELECT label, username, host FROM hosts WHERE id = ? AND user_id = ?',
        hostId,
        user.id,
      );
      if (!host) throw new HttpError(404, 'хост не найден');
      const id = newId();
      // Заголовок по умолчанию — метка хоста с номером: у мультиконсоли две вкладки
      // «root@127.0.0.1» неразличимы, а «prod #1 / prod #2» — да.
      const openOnHost = allRows<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM sessions WHERE host_id = ? AND status IN ('starting','active','detached')`,
        hostId,
      )[0]?.n ?? 0;
      const fallbackTitle = openOnHost > 0 ? `${host.label} #${openOnHost + 1}` : host.label;
      db.prepare(
        `INSERT INTO sessions (id, user_id, host_id, title, status, rows, cols, created_at)
         VALUES (?, ?, ?, ?, 'starting', ?, ?, ?)`,
      ).run(
        id,
        user.id,
        hostId,
        title?.trim() || fallbackTitle,
        req.body?.rows ?? 24,
        req.body?.cols ?? 80,
        now(),
      );
      try {
        await spawnSession(db, id, { fake: deps.fakeSessions });
      } catch (err) {
        audit(user.id, 'session.spawn_failed', id, req.ip, String(err));
        throw new HttpError(502, `не удалось открыть сессию: ${(err as Error).message}`);
      }
      audit(user.id, 'session.create', id, req.ip, host.label);
      reply.code(201);
      return { id };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const user = await requireUser(db, req);
    const row = getRow<{ id: string }>(db, 'SELECT id FROM sessions WHERE id = ? AND user_id = ?', req.params.id, user.id);
    if (!row) throw new HttpError(404, 'сессия не найдена');
    await killSession(db, req.params.id);
    audit(user.id, 'session.kill', req.params.id, req.ip);
    return { ok: true };
  });

  // История терминала живёт на сервере: после перезагрузки страницы и смены устройства
  // прокрутка восстанавливается из этих чанков, а не из localStorage браузера.
  app.get<{ Params: { id: string }; Querystring: { from?: string; limit?: string } }>(
    '/api/sessions/:id/scrollback',
    async (req) => {
      const user = await requireUser(db, req);
      const row = getRow<{ id: string }>(db, 'SELECT id FROM sessions WHERE id = ? AND user_id = ?', req.params.id, user.id);
      if (!row) throw new HttpError(404, 'сессия не найдена');
      const from = Number(req.query.from ?? 0);
      const limit = Math.min(Number(req.query.limit ?? 500), 5000);
      // from=0 — это «дай историю для восстановления экрана», и нужны последние чанки,
      // а не первые: у сессии с 50 000 чанков первые уже неактуальны, а после ретенции
      // их и вовсе нет. Остальные запросы — честная пагинация вперёд по seq.
      const chunks =
        !Number.isFinite(from) || from <= 0
          ? allRows<{ seq: number; ts: number; data: Buffer }>(
              db,
              `SELECT seq, ts, data FROM (
                 SELECT seq, ts, data FROM session_chunks
                 WHERE session_id = ? AND dir = 'out' ORDER BY seq DESC LIMIT ?
               ) ORDER BY seq ASC`,
              req.params.id,
              limit,
            )
          : allRows<{ seq: number; ts: number; data: Buffer }>(
              db,
              `SELECT seq, ts, data FROM session_chunks
               WHERE session_id = ? AND dir = 'out' AND seq > ? ORDER BY seq ASC LIMIT ?`,
              req.params.id,
              from,
              limit,
            );
      return {
        chunks: chunks.map((c) => ({ seq: c.seq, ts: c.ts, data: Buffer.from(c.data).toString('base64') })),
      };
    },
  );

  // ── Состояние интерфейса ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { device?: string } }>('/api/state', async (req) => {
    const user = await requireUser(db, req);
    const device = req.query.device ?? 'default';
    const row = getRow<{ data: string; updated_at: number }>(
      db,
      'SELECT data, updated_at FROM ui_state WHERE user_id = ? AND device_key = ?',
      user.id,
      device,
    );
    return row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : { data: null, updatedAt: null };
  });

  app.put<{ Body: { device?: string; data?: unknown } }>('/api/state', async (req) => {
    const user = await requireUser(db, req);
    const device = req.body?.device ?? 'default';
    if (req.body?.data === undefined) throw new HttpError(400, 'нужно поле data');
    db.prepare(
      `INSERT INTO ui_state (user_id, device_key, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, device_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(user.id, device, JSON.stringify(req.body.data), now());
    return { ok: true };
  });

  // ── WebSocket: проксирование в воркер сессии ──────────────────────────────────────
  // Прокси, а не второй SSH-клиент: иначе после перезапуска веб-слоя терминал жил бы
  // только на бумаге. Кадры пересылаются как есть, границы кадров = границы ws-сообщений.
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/ws/session/')) {
      socket.destroy();
      return;
    }
    const sessionId = url.pathname.slice('/ws/session/'.length);
    const user = userForToken(db, tokenFromCookieHeader(req.headers.cookie));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const owned = getRow<{ id: string; socket_path: string | null }>(
      db,
      'SELECT id, socket_path FROM sessions WHERE id = ? AND user_id = ?',
      sessionId,
      user.id,
    );
    if (!owned) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, { sessionId, socketPath: owned.socket_path ?? sessionSocketPath(config.stateDir, sessionId) });
    });
  });

  wss.on('connection', (ws: WebSocket, ctx: { sessionId: string; socketPath: string }) => {
    const worker = net.connect(ctx.socketPath);
    const decoder = new FrameDecoder();

    worker.on('data', (chunk) => {
      // Перекадрируем на границы ws-сообщений: браузер получает ровно один кадр на сообщение.
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        ws.close(1011, 'broken frame');
        return;
      }
      for (const frame of frames) {
        ws.send(encodeFrame(frame.type, frame.payload));
      }
    });
    worker.on('error', () => {
      // Только кадры: клиент разбирает поток одним декодером, и «сырой» JSON посреди
      // бинарных кадров он примет за начало кадра — консоль после этого мертва.
      ws.send(encodeControl({ t: 'error', message: 'воркер сессии недоступен' }));
      ws.close(1011, 'worker unavailable');
    });
    worker.on('close', () => ws.close(1000, 'worker closed'));

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length < 5) return;
      const type = buf.readUInt8(4);
      if (type !== FRAME_IN && type !== FRAME_CONTROL && type !== FRAME_OUT) return;
      if (type === FRAME_OUT) return; // клиент не имеет права инжектить вывод
      if (!worker.destroyed) worker.write(buf);
    });
    ws.on('close', () => worker.destroy());
  });

  return app;
}
