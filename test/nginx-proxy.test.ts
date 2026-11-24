import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import WebSocket from 'ws';

/**
 * Прокси кадров проверяется через НАСТОЯЩИЙ nginx и НАСТОЯЩИЙ WebSocket, а не через
 * fastify.inject: inject не умеет upgrade, поэтому «терминал не поднимается, а форма
 * входа работает» — ровно та поломка, которую он не поймает.
 *
 * Конфиг берётся боевой — `deploy/nginx/ssh.dnikulshin.ru.conf`; в тесте подменяются
 * только порт, сертификат и файл basic-auth. Смысл проверки — что этот файл, попав на
 * хост, действительно пропускает кадры, а не только HTTP.
 *
 * Гейтед: без `nginx` и `openssl` тест пропускается, а не «проходит».
 */

function has(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}

const gated = !has('nginx') || !has('openssl');
const skip = gated ? 'нужны nginx и openssl в PATH' : false;

const REPO = join(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'wssh-proxy-data-'));
const prefix = mkdtempSync(join(tmpdir(), 'wssh-proxy-nginx-'));
process.env.WEB_SSH_DATA_DIR = dataDir;
process.env.WEB_SSH_FAKE_SESSIONS = 'true';

const { config } = await import('../src/config.ts');
const { openAndMigrate } = await import('../src/db/index.ts');
const { createVault } = await import('../src/vault.ts');
const { buildServer } = await import('../src/web/server.ts');
const { killSession } = await import('../src/hub/manager.ts');
const { encodeControl } = await import('../src/proto/frames.ts');

const BASIC = { user: 'tester', password: 'proxy-pass' };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(
  port: number,
  method: string,
  path: string,
  opts: { cookie?: string; json?: unknown; basic?: boolean } = {},
): Promise<Reply> {
  const body = opts.json === undefined ? null : Buffer.from(JSON.stringify(opts.json));
  const headers: Record<string, string> = {};
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.basic !== false) {
    headers.authorization = `Basic ${Buffer.from(`${BASIC.user}:${BASIC.password}`).toString('base64')}`;
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      // Самоподписанный сертификат теста: проверять его нечем и не нужно.
      { host: '127.0.0.1', port, method, path, headers, rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function firstFrameText(messages: Buffer[]): string {
  // Кадр: [4 байта длина][1 байт тип][payload]. Тип не проверяем — важно, что байты доехали.
  return messages.map((m) => m.subarray(5).toString('utf8')).join('');
}

test('nginx: HTTP и WS-прокси кадров через боевой конфиг ssh.dnikulshin.ru', { skip }, async (t) => {
  const appPort = await freePort();
  const proxyPort = await freePort();
  const db = openAndMigrate(config.dbPath);
  const vault = createVault({ keyFile: config.masterKeyFile });
  const app = await buildServer({ db, vault, fakeSessions: true });
  await app.listen({ host: '127.0.0.1', port: appPort });

  const created: string[] = [];
  const htpasswd = join(prefix, 'htpasswd');
  writeFileSync(htpasswd, `${BASIC.user}:${execFileSync('openssl', ['passwd', '-apr1', BASIC.password], { encoding: 'utf8' }).trim()}\n`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=ssh.dnikulshin.ru',
    '-keyout', join(prefix, 'key.pem'), '-out', join(prefix, 'fullchain.pem'),
  ], { stdio: 'ignore' });

  const nginxConf = join(prefix, 'nginx.conf');
  const siteConf = join(prefix, 'site.conf');
  // Подстановки ровно те, что зависят от машины; остальное — байт в байт боевой файл.
  const site = readFileSync(join(REPO, 'deploy/nginx/ssh.dnikulshin.ru.conf'), 'utf8')
    .replace('listen 443 ssl;', `listen 127.0.0.1:${proxyPort} ssl;`)
    .replace('server 127.0.0.1:3030;', `server 127.0.0.1:${appPort};`)
    .replaceAll('/etc/ssl/dnikulshin/fullchain.pem', join(prefix, 'fullchain.pem'))
    .replaceAll('/etc/ssl/dnikulshin/key.pem', join(prefix, 'key.pem'))
    .replaceAll('/etc/nginx/.dev_htpasswd', htpasswd);
  writeFileSync(siteConf, site);
  for (const dir of ['logs', 'body', 'proxy', 'fcgi', 'uwsgi', 'scgi']) mkdirSync(join(prefix, dir), { recursive: true });
  writeFileSync(nginxConf, `
worker_processes 1;
error_log ${prefix}/logs/error.log warn;
pid ${prefix}/nginx.pid;
events { worker_connections 64; }
http {
  access_log ${prefix}/logs/access.log;
  client_body_temp_path ${prefix}/logs/body;
  proxy_temp_path ${prefix}/logs/proxy;
  fastcgi_temp_path ${prefix}/logs/fcgi;
  uwsgi_temp_path ${prefix}/logs/uwsgi;
  scgi_temp_path ${prefix}/logs/scgi;
  include ${siteConf};
}
`);

  const nginx = (args: string[]) => spawnSync('nginx', ['-p', prefix, '-c', nginxConf, ...args], { encoding: 'utf8' });
  const probe = nginx(['-t']);
  assert.equal(probe.status, 0, `nginx -t: ${probe.stderr}`);
  const started = nginx([]);
  assert.equal(started.status, 0, `nginx: ${started.stderr}`);

  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    nginx(['-s', 'stop']);
    for (const id of created) await killSession(db, id).catch(() => {});
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
  });

  // 1. Замок nginx: без basic-auth не отдаётся даже форма входа.
  const noAuth = await http(proxyPort, 'GET', '/', { basic: false });
  assert.equal(noAuth.status, 401, 'без basic-auth nginx обязан отвечать 401');

  // 2. Через прокси — статика, API и заголовки.
  const index = await http(proxyPort, 'GET', '/');
  assert.equal(index.status, 200, index.body.slice(0, 200));
  assert.match(index.body, /<html/i);
  const headers = Object.entries(index.headers).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
  assert.match(headers, /x-frame-options: DENY/i);
  // nginx склеивает свой add_header со значением приложения в одно поле; важно, что
  // в итоге есть no-store, а не только max-age=0 у статики fastify.
  assert.match(headers, /cache-control: [^\n]*no-store/i);
  const health = await http(proxyPort, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');

  // 3. Владелец, креды, хост, сессия — через тот же прокси.
  const reg = await http(proxyPort, 'POST', '/api/auth/register', {
    json: { login: 'owner', password: 'proxy-owner-pass' },
  });
  assert.equal(reg.status, 200, reg.body);
  const setCookie = [reg.headers['set-cookie'] ?? []].flat()[0] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  assert.match(cookie, /^wssh_session=/, `ожидалась cookie сессии, получено: ${setCookie}`);

  const cred = await http(proxyPort, 'POST', '/api/credentials', {
    cookie, json: { label: 'proxy-cred', kind: 'password', secret: 'не-утечь-наружу' },
  });
  assert.ok(cred.status === 200 || cred.status === 201, `креды: ${cred.status} ${cred.body}`);
  const credentialId = JSON.parse(cred.body).id as string;

  const host = await http(proxyPort, 'POST', '/api/hosts', {
    cookie,
    json: { label: 'fake-host', host: '127.0.0.1', port: 22, username: 'root', credentialId },
  });
  assert.ok(host.status === 200 || host.status === 201, `хост: ${host.status} ${host.body}`);
  const hostId = JSON.parse(host.body).id as string;

  const session = await http(proxyPort, 'POST', '/api/sessions', {
    cookie, json: { hostId, title: 'proxy-test', rows: 24, cols: 80 },
  });
  assert.ok(session.status === 200 || session.status === 201, `сессия: ${session.status} ${session.body}`);
  const sessionId = JSON.parse(session.body).id as string;
  created.push(sessionId);

  // 4. Главное: кадры терминала идут через upgrade-локацию nginx.
  const frames: Buffer[] = [];
  const ws = new WebSocket(`wss://127.0.0.1:${proxyPort}/ws/session/${encodeURIComponent(sessionId)}`, {
    rejectUnauthorized: false,
    headers: { authorization: `Basic ${Buffer.from(`${BASIC.user}:${BASIC.password}`).toString('base64')}`, cookie },
  });
  sockets.push(ws);
  // Как браузер: без attach воркер не начинает стримить вывод (см. public/js/app.js).
  ws.on('open', () => ws.send(encodeControl({ t: 'attach', from: 0 })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`кадры не пришли за 15 с; получено: ${frames.length}`)), 15_000);
    ws.on('message', (data: Buffer) => {
      frames.push(data);
      if (firstFrameText(frames).includes('[fake] tick')) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  assert.ok(frames.length > 0, 'WS через nginx не отдал ни одного кадра');
  assert.match(firstFrameText(frames), /\[fake\] tick/, 'в кадрах нет вывода сессии');

  // 5. Прокси не отдаёт секрет: он вообще не покидает сервер.
  const creds = await http(proxyPort, 'GET', '/api/credentials', { cookie });
  assert.equal(creds.status, 200);
  assert.ok(!creds.body.includes('не-утечь-наружу'), 'секрет кредов утёк в ответ API');
  ws.close();
});
