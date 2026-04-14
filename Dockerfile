# --- Этап 1: Сборка (Builder) ---
FROM node:20-alpine AS builder

WORKDIR /app

# Копируем только файлы зависимостей для кэширования слоев
COPY package*.json ./

# Устанавливаем ВСЕ зависимости (включая typescript)
RUN npm ci

# Копируем исходники и собираем проект
COPY . .
RUN npm run build

# --- Этап 2: Финальный образ (Runner) ---
FROM node:20-alpine AS runner

WORKDIR /app

# Копируем из первого этапа только то, что нужно для работы
# 1. Скомпилированные файлы (обычно папка dist)
COPY --from=builder /app/dist ./dist
# 2. Package.json для запуска скриптов
COPY --from=builder /app/package*.json ./
# 3. Устанавливаем только production-зависимости (без тяжелого TS и тестов)
RUN npm ci --omit=dev

# Экспонируем порт (замените на ваш, если другой)
EXPOSE 3000

# Команда запуска
CMD ["npm", "run", "start"]
