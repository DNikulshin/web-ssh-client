#!/usr/bin/env bash
# Установка/обновление web-ssh на хосте. Запускать от root:
#   sudo deploy/install-host.sh artifacts/release/web-ssh-<метка>.tar.gz
#
# Идемпотентен: повторный запуск с тем же архивом ничего не дублирует, с новым — обновляет
# код. Данные (/var/lib/web-ssh) не трогаются никогда, поэтому сессии и креды переживают
# обновление. Обновление кода = restart сервиса; KillMode=process оставляет воркеры живыми.
#
# Что НЕ делает скрипт: не включает регистрацию владельца и не выключает её. После первого
# входа правится /etc/web-ssh/web-ssh.env (см. deploy/env/web-ssh.env.example).
set -euo pipefail

RELEASE=${1:?использование: install-host.sh <release.tar.gz>}
DOMAIN=ssh.dnikulshin.ru
APP_PORT=3030
APP_DIR=/opt/web-ssh
DATA_DIR=/var/lib/web-ssh
ENV_DIR=/etc/web-ssh
ENV_FILE=$ENV_DIR/web-ssh.env
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "ОШИБКА: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo $0 $RELEASE"
[ -f "$RELEASE" ] || die "архив не найден: $RELEASE"

# ── предпосылки ──────────────────────────────────────────────────────────────────────
command -v node >/dev/null || die "нет node"
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 22 ] || die "node $node_major: нужен >= 22.5 (node:sqlite)"
command -v nginx >/dev/null || die "нет nginx"
[ -f /etc/ssl/dnikulshin/fullchain.pem ] || die "нет wildcard-сертификата /etc/ssl/dnikulshin/fullchain.pem"
[ -f /etc/nginx/.dev_htpasswd ] || die "нет /etc/nginx/.dev_htpasswd (basic-auth в конфиге nginx)"
ss -ltn "( sport = :$APP_PORT )" | grep -q LISTEN && die "порт $APP_PORT уже занят"

# ── пользователь и каталоги ──────────────────────────────────────────────────────────
step "пользователь webssh"
getent group webssh >/dev/null || groupadd --system webssh
getent passwd webssh >/dev/null || useradd --system --gid webssh --home "$DATA_DIR" \
  --shell /usr/sbin/nologin --comment "web-ssh" webssh
install -d -m 0700 -o webssh -g webssh "$DATA_DIR"
install -d -m 0755 "$APP_DIR" "$ENV_DIR"

# ── код ──────────────────────────────────────────────────────────────────────────────
step "распаковка $RELEASE → $APP_DIR"
# Только код и зависимости. Каталог данных здесь не появляется по определению.
rm -rf "$APP_DIR/dist" "$APP_DIR/public" "$APP_DIR/node_modules"
tar -xzf "$RELEASE" -C "$APP_DIR"
[ -f "$APP_DIR/dist/index.js" ] || die "в архиве нет dist/index.js"
[ -f "$APP_DIR/public/index.html" ] || die "в архиве нет public/index.html"
[ -d "$APP_DIR/node_modules/@xterm/xterm" ] || die "в архиве нет node_modules/@xterm/xterm (терминал отдаётся локально)"
[ -f "$APP_DIR/dist/db/schema.sql" ] || die "в архиве нет dist/db/schema.sql (сервер не стартует)"
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# ── окружение ────────────────────────────────────────────────────────────────────────
step "окружение $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  echo "уже есть — не перезаписываю (правки владельца важнее шаблона)"
else
  install -m 0600 -o root -g root "$SCRIPT_DIR/env/web-ssh.env.example" "$ENV_FILE"
  echo "создан из шаблона"
fi

# ── systemd ──────────────────────────────────────────────────────────────────────────
step "systemd: /etc/systemd/system/web-ssh.service"
install -m 0644 "$SCRIPT_DIR/systemd/web-ssh.service" /etc/systemd/system/web-ssh.service
systemctl daemon-reload
systemctl enable web-ssh >/dev/null
systemctl restart web-ssh
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null \
  || { journalctl -u web-ssh -n 40 --no-pager; die "сервис не отвечает на 127.0.0.1:$APP_PORT"; }
echo "сервис отвечает"

# ── nginx ────────────────────────────────────────────────────────────────────────────
step "nginx: /etc/nginx/conf.d/ssh.dnikulshin.ru.conf"
install -m 0644 "$SCRIPT_DIR/nginx/ssh.dnikulshin.ru.conf" "/etc/nginx/conf.d/$DOMAIN.conf"
nginx -t
systemctl reload nginx
echo "nginx перечитал конфиг"

# ── проверка через сам прокси ────────────────────────────────────────────────────────
step "проверка через nginx (с хоста, по реальному имени)"
# basic-auth включён: без -u здесь честный 401, и это тоже проверка.
code=$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/")
echo "GET / -> $code (401 без basic-auth — ожидаемо; 200 — если креды подхвачены)"
echo
echo "Готово. Дальше:"
echo "  1) открыть https://$DOMAIN:8443/ и зарегистрировать владельца (пока в БД никого);"
echo "  2) выставить WEB_SSH_ALLOW_REGISTRATION=false в $ENV_FILE и systemctl restart web-ssh;"
echo "  3) добавить хост и креды в интерфейсе, проверить реальный SSH."
