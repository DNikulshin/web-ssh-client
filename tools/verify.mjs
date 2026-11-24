#!/usr/bin/env node
/**
 * Одна команда — все проверки: типы, затем тесты.
 * Отдельный скрипт, а не цепочка в package.json, чтобы порядок и вывод были предсказуемы
 * и в CI, и локально: сначала дешёвая статика, потом то, что поднимает процессы.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'типы (tsc --noEmit)', cmd: 'node', args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'] },
  { name: 'тесты (node --test)', cmd: 'node', args: ['--test', 'test/'] },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n── ${step.name}\n`);
  const res = spawnSync(step.cmd, step.args, { stdio: 'inherit', env: process.env });
  if (res.status !== 0) {
    failed += 1;
    console.error(`✗ ${step.name}`);
  } else {
    console.log(`✓ ${step.name}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
