# --- Этап 1: сборка ---
# node:24 — первая LTS-линия, где node:sqlite доступен без экспериментального флага.
FROM node:24-alpine AS builder
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
# tsc собирает js, copy-assets кладёт рядом schema.sql: без неё сервер падает на старте
# (схема читается по URL рядом с модулем).
RUN pnpm run build

# --- Этап 2: запуск ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && addgroup -S webssh && adduser -S -G webssh webssh

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --prod && pnpm store prune

COPY --from=builder /app/dist ./dist
COPY public ./public

# Данные (SQLite, мастер-ключ, сокеты сессий) — только здесь. Мастер-ключ обязан лежать
# вне бэкапа БД; в контейнере удобно смонтировать его отдельным секретом.
RUN mkdir -p /data && chown -R webssh:webssh /data /app
VOLUME ["/data"]
ENV WEB_SSH_DATA_DIR=/data

USER webssh
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_SSH_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
