-- Схема БД v1. SQLite в режиме WAL, synchronous=FULL: задача — пережить не «аккуратную
-- остановку», а пропажу питания, поэтому каждый коммит ждёт fsync.
-- Все времена — миллисекунды epoch (INTEGER), чтобы сравнения не зависели от формата.

PRAGMA user_version = 1;

-- Пользователи. Пока один, но модель сразу многопользовательская: sessions/ui_state
-- ссылаются на user_id, иначе первый же второй человек потребует миграции.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,        -- scrypt: scrypt$N$r$p$salt_b64$hash_b64
  totp_secret   TEXT,                 -- зашифрован vault'ом, NULL = 2FA выключена
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Сессии браузера (cookie). Хранится хеш токена, не сам токен: утечка БД не даёт войти.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- Креды. Секрет лежит только шифротекстом (AES-256-GCM, ключ вне БД).
-- aad связывает запись с владельцем: подмена строки в БД ломает расшифровку.
CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('password', 'key')),
  cipher       TEXT NOT NULL,   -- 'aes-256-gcm'
  key_version  INTEGER NOT NULL DEFAULT 1,
  aad          TEXT NOT NULL,   -- 'credential:<id>:<user_id>'
  iv           TEXT NOT NULL,   -- base64, 12 байт
  tag          TEXT NOT NULL,   -- base64, 16 байт
  ciphertext   TEXT NOT NULL,   -- base64
  passphrase_enc TEXT,          -- для ключей с парольной фразой: тот же конверт, base64 JSON
  created_at   INTEGER NOT NULL,
  rotated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS hosts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 22,
  username      TEXT NOT NULL,
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON-массив
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosts_user ON hosts(user_id);

-- Сессия = один SSH-канал + воркер-процесс. Строка живёт после смерти процесса:
-- именно она позволяет отличить «сессия закрыта пользователем» от «воркер упал».
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id      TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('starting', 'active', 'detached', 'exited', 'lost')),
  worker_pid   INTEGER,
  socket_path  TEXT,
  rows         INTEGER NOT NULL DEFAULT 24,
  cols         INTEGER NOT NULL DEFAULT 80,
  last_seq     INTEGER NOT NULL DEFAULT 0,   -- сколько чанков вывода уже записано
  exit_code    INTEGER,
  created_at   INTEGER NOT NULL,
  attached_at  INTEGER,
  ended_at     INTEGER,
  resume_cmd   TEXT                          -- команда восстановления на целевом хосте (tmux/screen)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);

-- Журнал вывода. Это и есть «история»: после перезагрузки страницы терминал
-- восстанавливается из этих чанков, а не из памяти браузера.
CREATE TABLE IF NOT EXISTS session_chunks (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  dir        TEXT NOT NULL CHECK (dir IN ('out', 'in')),
  data       BLOB NOT NULL,
  PRIMARY KEY (session_id, seq, dir)
);

-- Состояние интерфейса (открытые вкладки, активная панель, размеры, тема) — per user+device,
-- чтобы телефон и ноутбук не отбирали друг у друга раскладку.
CREATE TABLE IF NOT EXISTS ui_state (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_key)
);

-- Аудит: кто вошёл, кто куда подключался, кому отдал секрет. Без значений секретов.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  ip         TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
