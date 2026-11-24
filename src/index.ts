import { config, ensureDirs } from './config.ts';
import { openAndMigrate } from './db/index.ts';
import { createVault } from './vault.ts';
import { buildServer } from './web/server.ts';
import { reconcile } from './hub/manager.ts';

// Umask до создания любых файлов: БД, мастер-ключ и сокеты не должны быть доступны соседям.
process.umask(0o077);

/**
 * Точка входа веб-слоя. Здесь нет SSH: сессии живут в отдельных воркерах, поэтому
 * `systemctl restart web-ssh` не рвёт открытые терминалы, а падение веб-слоя не уносит
 * соединения с удалёнными хостами. Сверка состояния при старте чинит БД после аварии.
 */
async function main(): Promise<void> {
  ensureDirs();
  const db = openAndMigrate(config.dbPath);
  const vault = createVault({ keyFile: config.masterKeyFile });

  const reconciled = await reconcile(db);
  if (reconciled.length > 0) {
    for (const r of reconciled) console.log(`[reconcile] ${r.id}: ${r.before} → ${r.after}`);
  }

  const app = await buildServer({ db, vault });
  await app.listen({ host: config.host, port: config.port });
  console.log(`web-ssh слушает http://${config.host}:${config.port} (данные: ${config.dataDir})`);

  // Периодическая сверка: SIGKILL воркера не оставляет в БД вечно «active».
  const sweep = setInterval(() => {
    reconcile(db).catch((err) => console.error('[reconcile]', err));
  }, 10_000);
  sweep.unref();

  const shutdown = async (signal: string) => {
    console.log(`[${signal}] останавливаюсь; воркеры сессий остаются жить`);
    clearInterval(sweep);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
