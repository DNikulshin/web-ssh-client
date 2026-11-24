import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}: ожидалось число, получено "${raw}"`);
  return n;
}

const dataDir = resolve(env('WEB_SSH_DATA_DIR', 'data'));

export const config = {
  dataDir,
  dbPath: resolve(env('WEB_SSH_DB', join(dataDir, 'web-ssh.db'))),
  masterKeyFile: resolve(env('WEB_SSH_MASTER_KEY_FILE', join(dataDir, 'master.key'))),
  stateDir: resolve(env('WEB_SSH_STATE_DIR', join(dataDir, 'state'))),
  hubSocket: resolve(env('WEB_SSH_HUB_SOCKET', join(dataDir, 'hub.sock'))),
  host: env('WEB_SSH_HOST', '127.0.0.1'),
  port: envInt('WEB_SSH_PORT', 3000),
  // За прокси (nginx) нужно доверять X-Forwarded-For, иначе все входы выглядят с 127.0.0.1.
  trustProxy: env('WEB_SSH_TRUST_PROXY', 'false') === 'true',
  cookieSecure: env('WEB_SSH_COOKIE_SECURE', 'false') === 'true',
  // Сколько байт вывода сессии держим на диске: 8 МиБ ≈ десятки тысяч строк.
  scrollbackBytes: envInt('WEB_SSH_SCROLLBACK_BYTES', 8 * 1024 * 1024),
  // Сколько байт держим в памяти воркера для мгновенной перерисовки при reconnect.
  ringBytes: envInt('WEB_SSH_RING_BYTES', 512 * 1024),
  authSessionDays: envInt('WEB_SSH_AUTH_SESSION_DAYS', 30),
  // Пустой список = регистрация разрешена (первый запуск создаёт владельца).
  allowRegistration: env('WEB_SSH_ALLOW_REGISTRATION', 'true') === 'true',
  // Только для проверок и демо: сессии поднимаются с эхо-транспортом вместо SSH,
  // чтобы UI можно было прогнать без реальных хостов и кредов.
  fakeSessions: env('WEB_SSH_FAKE_SESSIONS', 'false') === 'true',
  nodeEnv: env('NODE_ENV', 'development'),
} as const;

export function ensureDirs(): void {
  for (const dir of [dirname(config.dbPath), config.stateDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function readSecretFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
