#!/usr/bin/env node
/**
 * SQL-схема читается из файла (`new URL('./schema.sql', import.meta.url)`), поэтому её надо
 * положить рядом с собранным js. Копирование — явное: иначе после `tsc` сервер падает
 * на старте только в проде, а тесты этого не видят.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const pairs = [['src/db/schema.sql', 'dist/db/schema.sql']];
for (const [from, to] of pairs) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copy ${from} → ${to}`);
}
