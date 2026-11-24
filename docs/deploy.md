# Деплой на хост

Хост — эта же машина (`46.44.24.51`, ноутбук за домашним роутером). nginx на хосте слушает
только 443; роутер пробрасывает `8443 → 443`, поэтому публичный адрес —
**https://ssh.dnikulshin.ru:8443**. Тот же nginx отдаёт `pi.dnikulshin.ru` и `code.dnikulshin.ru`.

| Что | Где | Почему так |
| --- | --- | --- |
| Код | `/opt/web-ssh` (root, только чтение для сервиса) | сервис не может подменить свой код |
| Данные: БД, мастер-ключ, сокеты сессий | `/var/lib/web-ssh` (webssh:webssh, 0700) | `ProtectSystem=strict` разрешает запись только сюда |
| Окружение | `/etc/web-ssh/web-ssh.env` (root:root, 0600) | секретов в нём нет, но менять его должен только root |
| Сервис | `web-ssh.service`, пользователь `webssh` | `KillMode=process` — restart не рвёт терминалы |
| Вход снаружи | nginx: `deploy/nginx/ssh.dnikulshin.ru.conf` → `127.0.0.1:3030` | приложение наружу не смотрит |

Сертификат — существующий wildcard `*.dnikulshin.ru`
(`/etc/ssl/dnikulshin/fullchain.pem`, `key.pem`), отдельный выпуск для `ssh` не нужен.
Автопродления wildcard'а на хосте нет: это отдельная задача (`hair-lab/deploy/cert/install.md`).

## Что проверено, а что нет

Проверено на этой машине (24.11.2026):

- `pnpm build` → `dist/`; релизный архив собирается и распаковывается как самостоятельный:
  сервис стартует из `dist/index.js` без `src/`, отдаёт `/`, `/vendor/xterm/**`, `/api/health`
  (права `web-ssh.db`, `master.key` — `0600`).
- `deploy/nginx/ssh.dnikulshin.ru.conf` проходит `nginx -t` (nginx 1.28.3) и держит **реальный
  WebSocket**: `test/nginx-proxy.test.ts` поднимает nginx с этим конфигом (подменены только порт,
  сертификат и файл basic-auth), регистрирует владельца, создаёт креды/хост/сессию и получает
  кадры терминала через `wss://` — то есть upgrade-локация не «на бумаге».
- `node tools/verify.mjs` → 21 тест (20 проходят, реальный SSH пропускается без переменных).

Не проверено: установка на боевой путь (нужен root — см. ниже). Пока владелец не выполнил
`install-host.sh`, сервис на хосте не запущен, а `ssh.dnikulshin.ru:8443` отвечает
`tlsv1 unrecognized name` (нет server-блока для этого имени).

## Установка

```bash
cd ~/projects/web-ssh-client
node tools/verify.mjs 2>&1 | tee artifacts/selftest.log   # гейт перед деплоем
deploy/make-release.sh                                    # → artifacts/release/web-ssh-<коммит>.tar.gz
sudo deploy/install-host.sh artifacts/release/web-ssh-<коммит>.tar.gz
```

`make-release.sh` кладёт в архив `dist/`, `public/`, `docs/` и **прод-зависимости** (typescript
и тесты на хост не едут; pnpm на хосте не нужен). `install-host.sh` идемпотентен: создаёт
пользователя `webssh`, каталоги, ставит юнит и конфиг nginx, перезапускает сервис, проверяет
`/api/health` и `nginx -t`. Данные и `/etc/web-ssh/web-ssh.env` существующие не перезаписывает.

Проверить, что сервис жив, можно и вручную:

```bash
curl -sS http://127.0.0.1:3030/api/health
sudo -u webssh env $(grep -v '^#' /etc/web-ssh/web-ssh.env | xargs) \
  /usr/bin/node /opt/web-ssh/dist/hub/cli.js status     # pid, сокет, статус сессий
sudo journalctl -u web-ssh -n 50 --no-pager
```

## Первый вход

1. Открыть https://ssh.dnikulshin.ru:8443 — сначала спросит basic-auth (`dev` из
   `/etc/nginx/.dev_htpasswd`), затем форма регистрации владельца.
2. Зарегистрировать владельца (пароль — только через менеджер паролей).
3. **Сразу** закрыть регистрацию и перезапустить сервис:

   ```bash
   sudo sed -i 's/^WEB_SSH_ALLOW_REGISTRATION=.*/WEB_SSH_ALLOW_REGISTRATION=false/' \
       /etc/web-ssh/web-ssh.env
   sudo systemctl restart web-ssh
   ```

   Сессии при этом не рвутся (`KillMode=process`), но открытая регистрация на публичном
   адресе означает, что любой, кто дошёл до формы, создаст себе учётку.

## Обновление и откат

```bash
deploy/make-release.sh && sudo deploy/install-host.sh artifacts/release/web-ssh-<новый>.tar.gz
```

Restart веб-слоя терминалы не рвёт: воркеры сессий живут отдельными процессами. Долгоживущие
соединения проверяются так: открыть консоль, `sudo systemctl restart web-ssh`, убедиться, что
в терминале продолжается вывод и `cli.js status` показывает те же pid.

Откат — тем же скриптом с предыдущим архивом (архивы лежат в `artifacts/release/`). Схема БД
меняется только миграциями, поэтому старый архив на новой БД запустится, а вот откат схемы
не поддерживается: миграции пишутся совместимыми вперёд.

## Проверка снаружи

```bash
curl -sSI https://ssh.dnikulshin.ru:8443/          # 401 без basic-auth — это норма
curl -sS  https://ssh.dnikulshin.ru:8443/api/health # 401 без basic-auth
```

С хоста, без выхода наружу: `curl -sS --resolve ssh.dnikulshin.ru:443:127.0.0.1 -u dev:... https://ssh.dnikulshin.ru/api/health`.

## Что осталось за рамками этого деплоя

- TOTP и ограничение частоты входов в приложении: сейчас перебор пароля тормозит только
  `limit_req zone=wssh_auth` (10 r/m, burst 5) и basic-auth.
- Сверка `known_hosts` (ADR-007) — ключ SSH-хоста не проверяется.
- Продление wildcard-сертификата — не на этом хосте.
