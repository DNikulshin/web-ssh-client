import type { FastifyReply, FastifyRequest } from 'fastify';
import { newSessionToken, sha256, verifyPassword, hashPassword } from '../auth/password.ts';
import { getRow, newId, now, type Db } from '../db/index.ts';
import { config } from '../config.ts';

export const COOKIE_NAME = 'wssh_session';

export interface UserRow {
  id: string;
  login: string;
  password_hash: string;
}

export interface AuthSessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
}

export function userCount(db: Db): number {
  const row = getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users');
  return row?.n ?? 0;
}

export function createUser(db: Db, login: string, password: string): UserRow {
  if (login.trim().length < 3) throw new HttpError(400, 'логин короче 3 символов');
  if (password.length < 10) throw new HttpError(400, 'пароль короче 10 символов');
  const id = newId();
  db.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    login.trim(),
    hashPassword(password),
    now(),
  );
  return { id, login: login.trim(), password_hash: '' };
}

export function checkLogin(db: Db, login: string, password: string): UserRow | null {
  const user = getRow<UserRow>(db, 'SELECT * FROM users WHERE login = ?', login.trim());
  if (!user) {
    // Хешируем вхолостую: время ответа не должно сообщать, есть ли такой логин.
    verifyPassword(password, hashPassword('placeholder-for-timing'));
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
  return user;
}

export function issueToken(db: Db, userId: string, req: { ip?: string; userAgent?: string }): string {
  const { token, hash } = newSessionToken();
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    userId,
    hash,
    req.userAgent ?? null,
    req.ip ?? null,
    now(),
    now() + config.authSessionDays * 86_400_000,
  );
  return token;
}

export function revokeToken(db: Db, token: string): void {
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(now(), sha256(token));
}

export function userForToken(db: Db, token: string | undefined): UserRow | null {
  if (!token) return null;
  const row = getRow<AuthSessionRow & { user_id: string }>(
    db,
    `SELECT * FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    sha256(token),
    now(),
  );
  if (!row) return null;
  return getRow<UserRow>(db, 'SELECT * FROM users WHERE id = ?', row.user_id) ?? null;
}

export function tokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function setCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.authSessionDays * 86_400,
  });
}

export function clearCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export class HttpError extends Error {
  // Не parameter property: Node со strip-only типами такое не выполняет, а сервер
  // запускается прямо из .ts без сборки (см. tools/verify.mjs — сборка есть, но dev без неё).
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
  }
}

export async function requireUser(db: Db, req: FastifyRequest): Promise<UserRow> {
  const user = userForToken(db, tokenFromCookieHeader(req.headers.cookie));
  if (!user) throw new HttpError(401, 'нужен вход');
  req.user = user;
  return user;
}
