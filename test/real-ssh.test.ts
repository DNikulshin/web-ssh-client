import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';

/**
 * Реальный путь через ssh2: вход по ключу, shell, размер pty, код выхода.
 *
 * Тест включается только при заданных переменных окружения — в CI и на машине без
 * SSH-сервера он молча пропускается, а не притворяется пройденным:
 *
 *   WEB_SSH_TEST_HOST=127.0.0.1 \
 *   WEB_SSH_TEST_USER=dev \
 *   WEB_SSH_TEST_KEY=~/.ssh/webssh-test \
 *   node --test test/real-ssh.test.ts
 *
 * Ключ должен быть уже разрешён на целевом хосте (authorized_keys). Тест ничего не
 * настраивает на удалённой стороне: если вход не проходит, он это и покажет.
 */

const HOST = process.env.WEB_SSH_TEST_HOST;
const USER = process.env.WEB_SSH_TEST_USER;
const KEY_PATH = process.env.WEB_SSH_TEST_KEY;
const PORT = Number(process.env.WEB_SSH_TEST_PORT ?? 22);

const missing = !HOST || !USER || !KEY_PATH ? 'нужны WEB_SSH_TEST_HOST, WEB_SSH_TEST_USER, WEB_SSH_TEST_KEY' : false;

const dataDir = missing ? null : mkdtempSync(join(tmpdir(), 'wssh-real-'));
if (dataDir) process.env.WEB_SSH_DATA_DIR = dataDir;

const { config } = await import('../src/config.ts');
const { openAndMigrate, getRow } = await import('../src/db/index.ts');
const { createVault } = await import('../src/vault.ts');
const { buildServer } = await import('../src/web/server.ts');
const { killSession } = await import('../src/hub/manager.ts');
const { FRAME_CONTROL, FRAME_OUT, FrameDecoder, encodeControl, encodeFrame } = await import('../src/proto/frames.ts');

interface Control {
  t: string;
  [k: string]: unknown;
}

test(
  'реальный SSH: shell, TERM, размер pty из UI, код выхода',
  { skip: missing, timeout: 60_000 },
  async (t) => {
    const db = openAndMigrate(config.dbPath);
    const vault = createVault({ keyFile: config.masterKeyFile });
    // fakeSessions намеренно выключен: проверяется ровно тот путь, которого нет в других тестах.
    const app = await buildServer({ db, vault, fakeSessions: false });
    let sessionId: string | null = null;

    t.after(async () => {
      if (sessionId) await killSession(db, sessionId).catch(() => {});
      await app.close();
      db.close();
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    });

    // 1. Владелец, кред с приватным ключом, хост.
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { login: 'owner', password: 'very-secret-pass' },
    });
    const cookie = reg.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');

    const key = readFileSync(KEY_PATH!.replace(/^~/, process.env.HOME ?? ''), 'utf8');
    const cred = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: { cookie },
      payload: { label: 'test-key', kind: 'key', secret: key },
    });
    assert.equal(cred.statusCode, 200, cred.body);

    const host = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        label: 'localhost-sshd',
        host: HOST,
        port: PORT,
        username: USER,
        credentialId: cred.json().id,
      },
    });
    assert.equal(host.statusCode, 200, host.body);

    // 2. Сессия с конкретным размером pty — его мы потом сверим через `stty size`.
    const rows = 31;
    const cols = 104;
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { hostId: host.json().id, rows, cols },
    });
    assert.equal(created.statusCode, 201, created.body);
    sessionId = created.json().id;

    // 3. Слушаем на случайном порту и подключаемся тем же путём, что и браузер.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/session/${sessionId}`, { headers: { cookie } });

    let output = '';
    const controls: Control[] = [];
    const decoder = new FrameDecoder();

    ws.on('message', (data: Buffer) => {
      for (const frame of decoder.push(Buffer.from(data))) {
        if (frame.type === FRAME_OUT) output += frame.payload.toString('utf8');
        else if (frame.type === FRAME_CONTROL) controls.push(JSON.parse(frame.payload.toString('utf8')) as Control);
      }
    });

    const waitFor = async (pred: () => boolean, what: string, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`не дождались: ${what}. Вывод: ${JSON.stringify(output.slice(-400))}`);
    };

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(encodeControl({ t: 'attach', from: 0 }));
    await waitFor(() => controls.some((c) => c.t === 'attached'), 'cadr attached');

    // 4. Подключились по ключу и получили рабочий shell.
    ws.send(encodeFrame(3, Buffer.from('echo MARK-one; echo TERM=$TERM\r')));
    await waitFor(() => output.includes('TERM=xterm-256color'), 'TERM=xterm-256color (pty запрошен как терминал)');
    assert.match(output, /MARK-one/);

    // 5. Размер pty дошёл до удалённой стороны: это то, что проверяет setWindow.
    ws.send(encodeFrame(3, Buffer.from('stty size\r')));
    await waitFor(() => new RegExp(`${rows} ${cols}`).test(output), `stty size = ${rows} ${cols}`);

    // 6. Код выхода прокидывается в клиента и в БД, а не теряется.
    ws.send(encodeFrame(3, Buffer.from('exit 3\r')));
    await waitFor(() => controls.some((c) => c.t === 'exit'), 'кадр exit');
    const exitFrame = controls.find((c) => c.t === 'exit')!;
    assert.equal(exitFrame.code, 3, `ожидали код 3, получили ${JSON.stringify(exitFrame)}`);

    await new Promise((r) => setTimeout(r, 300));
    const row = getRow<{ status: string; exit_code: number | null }>(
      db,
      'SELECT status, exit_code FROM sessions WHERE id = ?',
      sessionId,
    );
    assert.equal(row?.status, 'exited');
    assert.equal(row?.exit_code, 3);

    // 7. История входа в БД: то, что видел пользователь, доступно после перезагрузки страницы.
    const scroll = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/scrollback?from=0&limit=100`,
      headers: { cookie },
    });
    const text = scroll
      .json()
      .chunks.map((c: { data: string }) => Buffer.from(c.data, 'base64').toString('utf8'))
      .join('');
    assert.match(text, /MARK-one/, 'вывод сессии должен лежать в БД');

    ws.close();
  },
);
