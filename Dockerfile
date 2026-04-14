# --- Этап 1: Сборка ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Собираем проект (результат должен попасть в /app/dist)
RUN npm run build

# --- Этап 2: Запуск ---
FROM node:20-alpine AS runner
WORKDIR /app
# Копируем зависимости для работы
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем скомпилированные файлы
COPY --from=builder /app/dist ./dist
# Копируем папку public (часто нужна для статики в рантайме)
COPY --from=builder /app/public ./public

EXPOSE 3000
# Проверьте в package.json, что делает команда start. 
# Она должна запускать сервер, который отдает файлы из dist или public.
CMD ["npm", "run", "start"]
