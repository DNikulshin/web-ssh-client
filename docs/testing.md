# Проверки

Одна команда — все проверки:

```bash
node tools/verify.mjs
```

Порядок намеренный: сначала дешёвая статика (`tsc --noEmit`), потом тесты, которые
поднимают процессы. Упавший тип не должен ждать, пока отработают интеграционные тесты.

## Что проверяется

| файл | о чём | почему именно так |
| --- | --- | --- |
| `test/vault.test.ts` | конверт AES-GCM: roundtrip, подмена aad, подмена шифротекста, версия ключа, права 0600, испорченный файл ключа | «креды в БД» — это про то, что утечка БД не даёт доступ; проверяется отрицательными сценариями |
| `test/frames.test.ts` | кадры: разрезанный по байту поток, бинарный вывод, несколько кадров в чанке, предел длины, неизвестный тип | сокет не обязан отдавать кадр целиком; ошибка здесь выглядит как «терминал иногда показывает мусор» |
| `test/session-resilience.test.ts` | отключение клиента → `detached`; повторный `attach` → replay; `SIGKILL` воркера → чанки на диске; `reconcile` → `lost` | это главное обещание сервиса; тест воспроизводит именно те отказы, от которых он должен защищать |

Фейковый транспорт: воркер с `--fake` не подключается никуда, эмитит `[fake] tick` и отражает
ввод как `[fake-echo] …`. Поэтому тесты не требуют ни SSH-сервера, ни сети, ни кредов.

## Как воспроизвести тест на выживание вручную

```bash
export WEB_SSH_DATA_DIR=/tmp/wssh-manual
node -e "
const {openAndMigrate}=await import('./src/db/index.ts');
const db=openAndMigrate('/tmp/wssh-manual/web-ssh.db');
db.prepare('INSERT INTO users (id,login,password_hash,created_at) VALUES (?,?,?,?)').run('u','t','x',Date.now());
db.prepare('INSERT INTO sessions (id,user_id,host_id,title,status,created_at) VALUES (?,?,NULL,?,?,?)').run('s1','u','manual','starting',Date.now());
" --input-type=module

node src/hub/worker.ts s1 /tmp/wssh-manual/s.sock --fake &
sleep 1
node src/hub/cli.ts status          # сокет и pid живы
kill -9 <pid воркера>
node src/hub/cli.ts reconcile       # сессия → lost
```

Историю вывода после `SIGKILL` смотреть так:

```bash
sqlite3 /tmp/wssh-manual/web-ssh.db \
  "SELECT seq, LENGTH(data) FROM session_chunks WHERE session_id='s1' ORDER BY seq;"
```

## Чего тесты не покрывают (и это надо знать)

- **Настоящий SSH.** Ни один тест не подключается по сети: нужен реальный хост и ключ.
  Значит, регрессии в `ssh2`-специфике (алгоритмы, `shell`, `setWindow`, exit code) ловятся
  только ручным прогоном на живом хосте.
- **Веб-слой.** REST и WS-прокси пока без тестов: нужен прогон сервера и клиента. План —
  интеграционный тест `fastify.inject` + WS-клиент на фейковой сессии.
- **Пропажа питания.** `synchronous=FULL` — это аргумент, а не измерение. Проверка требует
  отдельного стенда с отключением питания; сейчас это заявка, а не факт.
- **Ретенция истории.** Логика удаления старых чанков не покрыта тестом на границе
  `WEB_SSH_SCROLLBACK_BYTES`.
