import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Хранилище секретов: AES-256-GCM, ключ живёт в файле вне БД.
 *
 * Почему так, а не «просто зашифруем поле в БД»: дамп БД (бэкап, копия, чужой ноутбук)
 * не должен давать SSH-доступ. Ключ в отдельном файле с правами 0600 разделяет две
 * разные утечки — «унесли базу» и «унесли хост». Это не HSM: если кто-то получил и БД,
 * и файл ключа, он получил всё. Это записано в docs/decisions.md как принятый риск.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  cipher: 'aes-256-gcm';
  keyVersion: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface Vault {
  readonly keyVersion: number;
  seal(plaintext: Buffer | string, aad: string): Sealed;
  open(sealed: Sealed, aad: string): Buffer;
  openText(sealed: Sealed, aad: string): string;
}

function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${path}: мастер-ключ должен быть ${KEY_BYTES} байт (получено ${key.length}). ` +
          'Файл повреждён — расшифровать существующие креды им нельзя.',
      );
    }
    return key;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key.toString('base64') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function createVault(opts: { keyFile?: string; keyVersion?: number } = {}): Vault {
  if (!opts.keyFile) throw new Error('createVault: нужен keyFile');
  const key = loadOrCreateKey(opts.keyFile);
  const keyVersion = opts.keyVersion ?? 1;

  return {
    keyVersion,
    seal(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([
        cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
        cipher.final(),
      ]);
      return {
        cipher: 'aes-256-gcm',
        keyVersion,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ct.toString('base64'),
      };
    },

    open(sealed, aad) {
      if (sealed.cipher !== 'aes-256-gcm') throw new Error(`неизвестный шифр: ${sealed.cipher}`);
      if (sealed.keyVersion !== keyVersion) {
        throw new Error(
          `запись зашифрована ключом v${sealed.keyVersion}, активный ключ v${keyVersion}: нужна ротация`,
        );
      }
      const iv = Buffer.from(sealed.iv, 'base64');
      const tag = Buffer.from(sealed.tag, 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error('повреждённый конверт: неверная длина iv/tag');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      // GCM ловит подмену aad/iv/ct: ошибка здесь — признак правки строки в БД, а не сбоя.
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
    },

    openText(sealed, aad) {
      return this.open(sealed, aad).toString('utf8');
    },
  };
}

/** Постоянное по времени сравнение для токенов/хешей. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
