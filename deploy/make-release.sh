#!/usr/bin/env bash
# Сборка релизного архива для deploy/install-host.sh. Запускать обычным пользователем:
#   deploy/make-release.sh            → artifacts/release/web-ssh-<коммит>.tar.gz
#
# В архив кладётся только то, что нужно на хосте: скомпилированный код, статика, документы
# и ПРОД-зависимости (без typescript и тестов). Хост тогда не нуждается ни в сети, ни в pnpm —
# установка сводится к распаковке. node_modules собирается отдельно, потому что копировать
# dev-дерево целиком значит тащить на сервер компилятор и половину реестра.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_DIR=$PWD
LABEL=$(git rev-parse --short HEAD 2>/dev/null || echo no-git)
if ! git diff-index --quiet HEAD -- 2>/dev/null; then LABEL="$LABEL-dirty"; fi
OUT_DIR=$REPO_DIR/artifacts/release
STAGE=$OUT_DIR/web-ssh-$LABEL

echo "== сборка TypeScript"
pnpm build

echo "== staging $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a dist public docs package.json pnpm-lock.yaml pnpm-workspace.yaml "$STAGE"/

echo "== прод-зависимости (без сети не получится: pnpm install)"
(cd "$STAGE" && pnpm install --prod --frozen-lockfile --ignore-scripts >/dev/null)

# Ассеты терминала отдаёт сам сервис из node_modules/@xterm: без них консоль белая.
for need in node_modules/@xterm/xterm/css/xterm.css node_modules/@xterm/addon-fit/lib/addon-fit.js \
            dist/db/schema.sql dist/index.js public/index.html; do
  [ -e "$STAGE/$need" ] || { echo "ОШИБКА: в релизе нет $need" >&2; exit 1; }
done

ARCHIVE=$OUT_DIR/web-ssh-$LABEL.tar.gz
tar -czf "$ARCHIVE" -C "$STAGE" .
rm -rf "$STAGE"
echo
echo "архив: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "установка на хост: sudo deploy/install-host.sh $ARCHIVE"
