import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/vault.ts';

function tempKeyFile(): { dir: string; keyFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wssh-vault-'));
  return { dir, keyFile: join(dir, 'master.key') };
}

test('конверт: зашифровал → расшифровал, plaintext не виден в конверте', () => {
  const { dir, keyFile } = tempKeyFile();
  try {
    const vault = createVault({ keyFile });
    const sealed = vault.seal('super-secret-key-material', 'credential:abc:user1');
    assert.equal(vault.openText(sealed, 'credential:abc:user1'), 'super-secret-key-material');
    assert.ok(!JSON.stringify(sealed).includes('super-secret'));
    assert.notEqual(sealed.iv, vault.seal('x', 'a').iv, 'iv не должен повторяться');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('мастер-ключ создаётся с правами 0600 и переиспользуется', () => {
  const { dir, keyFile } = tempKeyFile();
  try {
    const a = createVault({ keyFile });
    const mode = statSync(keyFile).mode & 0o777;
    assert.equal(mode, 0o600, `права ${mode.toString(8)} вместо 600`);
    assert.ok(readFileSync(keyFile, 'utf8').trim().length > 0);

    const sealed = a.seal('секрет', 'aad');
    const b = createVault({ keyFile });
    assert.equal(b.openText(sealed, 'aad'), 'секрет', 'ключ должен читаться из того же файла');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('подмена aad (другая запись БД) не расшифровывается', () => {
  const { dir, keyFile } = tempKeyFile();
  try {
    const vault = createVault({ keyFile });
    const sealed = vault.seal('секрет', 'credential:abc:user1');
    assert.throws(() => vault.openText(sealed, 'credential:abc:user2'), /unable to authenticate|bad decrypt/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('подмена шифротекста ловится GCM-тегом', () => {
  const { dir, keyFile } = tempKeyFile();
  try {
    const vault = createVault({ keyFile });
    const sealed = vault.seal('пароль-от-сервера', 'aad');
    const raw = Buffer.from(sealed.ciphertext, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    assert.throws(() => vault.openText({ ...sealed, ciphertext: raw.toString('base64') }, 'aad'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ключ другой версии не выдаётся за актуальный', () => {
  const { dir, keyFile } = tempKeyFile();
  try {
    const v1 = createVault({ keyFile, keyVersion: 1 });
    const sealed = v1.seal('секрет', 'aad');
    const v2 = createVault({ keyFile, keyVersion: 2 });
    assert.throws(() => v2.openText(sealed, 'aad'), /ротация/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('испорченный файл ключа останавливает расшифровку, а не молча создаёт новый', () => {
  const { dir, keyFile } = tempKeyFile();
  try {
    createVault({ keyFile });
    writeFileSync(keyFile, Buffer.from('short').toString('base64'));
    assert.throws(() => createVault({ keyFile }), /мастер-ключ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
