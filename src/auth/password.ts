import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Пароли: scrypt из стандартной библиотеки (N=2^15, r=8, p=1). argon2id был бы лучше,
 * но требует нативной сборки: лишний шаг в Dockerfile и на хосте там, где можно обойтись
 * node:crypto. Формат хеша самодостаточен, параметры лежат в строке — их можно поднять
 * позже и перехешировать при входе.
 */

const N = 2 ** 15;
const r = 8;
const p = 1;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const n = Number(nStr);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length, {
    N: n,
    r: Number(rStr),
    p: Number(pStr),
    maxmem: 128 * n * Number(rStr) * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Токен cookie: в БД лежит только его хеш. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
