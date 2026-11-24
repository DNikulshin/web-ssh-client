import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Проверка REST-слоя через fastify.inject: без сети и без реального SSH.
 * Главное, что здесь ловится, — утечка секрета в ответах API и потеря связи
 * «сессия в БД ↔ живой воркер»: то, что глазами не видно, а тестом видно.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'wssh-api-'));
process.env.WEB_SSH_DATA_DIR = dataDir;

const { config } = await import('../src/config.ts');
const { openAndMigrate } = await import('../src/db/index.ts');
const { createVault } = await import('../src/vault.ts');
const { buildServer } = await import('../src/web/server.ts');
const { killSession } = await import('../src/hub/manager.ts');

const SECRET = 'hunter2-никогда-не-в-ответе-API';

test('REST: вход, креды не утекают, сессия поднимается фейковым воркером', async (t) => {
  const db = openAndMigrate(config.dbPath);
  const vault = createVault({ keyFile: config.masterKeyFile });
  const app = await buildServer({ db, vault, fakeSessions: true });
  const created: string[] = [];

  t.after(async () => {
    for (const id of created) await killSession(db, id).catch(() => {});
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // 1. Первый запуск: пользователей нет.
  const initial = await app.inject({ method: 'GET', url: '/api/auth/state' });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().needsSetup, true);

  // 2. Регистрация владельца выдаёт cookie, а без cookie закрыт доступ к данным.
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { login: 'owner', password: 'very-secret-pass' },
  });
  assert.equal(reg.statusCode, 200, reg.body);
  const cookie = reg.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
  assert.ok(cookie.includes('wssh_session'));

  const noAuth = await app.inject({ method: 'GET', url: '/api/hosts' });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.json().error, 'нужен вход');

  const auth = { cookie };

  // 3. Кред создаётся, но секрет не возвращается ни списком, ни созданием.
  const credRes = await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth,
    payload: { label: 'vps-root', kind: 'password', secret: SECRET },
  });
  assert.equal(credRes.statusCode, 200, credRes.body);
  assert.ok(!credRes.body.includes(SECRET), 'создание креда не должно возвращать секрет');
  const credentialId = credRes.json().id as string;

  const credList = await app.inject({ method: 'GET', url: '/api/credentials', headers: auth });
  assert.equal(credList.statusCode, 200);
  assert.ok(!credList.body.includes(SECRET), 'список кредов не должен содержать секрет');
  assert.ok(credList.body.includes('vps-root'));

  // 4. Хост ссылается на креды.
  const hostRes = await app.inject({
    method: 'POST',
    url: '/api/hosts',
    headers: auth,
    payload: { label: 'fake-host', host: '127.0.0.1', port: 22, username: 'root', credentialId },
  });
  assert.equal(hostRes.statusCode, 200, hostRes.body);
  const hostId = hostRes.json().id as string;

  // 5. Сессия поднимается воркером в фейковом транспорте и становится активной.
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: auth,
    payload: { hostId, rows: 30, cols: 100 },
  });
  assert.equal(sessionRes.statusCode, 201, sessionRes.body);
  const sessionId = sessionRes.json().id as string;
  created.push(sessionId);

  await new Promise((r) => setTimeout(r, 700));
  const list = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth });
  const session = list.json().find((s: { id: string }) => s.id === sessionId);
  assert.ok(session, 'сессия должна быть в списке');
  assert.equal(session.live, true, `ожидали живой воркер, получили ${JSON.stringify(session)}`);
  assert.equal(session.rows, 30);
  assert.equal(session.cols, 100);

  // 6. История вывода уже на сервере — это и есть «переживает перезагрузку страницы».
  const scroll = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/scrollback`, headers: auth });
  assert.equal(scroll.statusCode, 200);
  const chunks = scroll.json().chunks as { seq: number; data: string }[];
  assert.ok(chunks.length > 0, 'вывод должен быть записан в БД');
  const text = Buffer.from(chunks[0]!.data, 'base64').toString('utf8');
  assert.match(text, /fake/);

  // 7. Состояние интерфейса — per device, чтобы телефон и ноутбук не мешали друг другу.
  await app.inject({
    method: 'PUT',
    url: '/api/state',
    headers: auth,
    payload: { device: 'phone', data: { tabs: [sessionId], active: sessionId } },
  });
  const phoneState = await app.inject({ method: 'GET', url: '/api/state?device=phone', headers: auth });
  assert.deepEqual(phoneState.json().data.tabs, [sessionId]);
  const laptopState = await app.inject({ method: 'GET', url: '/api/state?device=laptop', headers: auth });
  assert.equal(laptopState.json().data, null, 'у другого устройства своё состояние');

  // 8. Завершение сессии закрывает канал, а не оставляет «вечно активную».
  const kill = await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}`, headers: auth });
  assert.equal(kill.statusCode, 200);
  const after = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: auth });
  assert.equal(after.json().status, 'exited');
  assert.equal(after.json().live, false);
});
