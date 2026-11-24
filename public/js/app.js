import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit/lib/addon-fit.mjs';
import { FRAME_CONTROL, FRAME_IN, FRAME_OUT, FrameDecoder, decodeControl, encodeControl, encodeFrame } from './frames.js';
import { api } from './api.js';

/**
 * Клиент веб-терминала. Без фреймворка: состояние — один объект, DOM перерисовывается
 * точечно. Причина не в религии: здесь важна предсказуемость жизненного цикла терминалов,
 * а не реактивность — пересозданный xterm теряет историю прокрутки.
 *
 * Главное правило клиента: вкладка — это не сессия. Закрыл вкладку — SSH жив (detached),
 * вернулся — терминал восстановлен из истории на сервере.
 */

const $ = (sel, root = document) => root.querySelector(sel);

const TERM_THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88,166,255,.25)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const state = {
  user: null,
  needsSetup: false,
  hosts: [],
  credentials: [],
  sessions: [],
  tabs: [],
  active: null,
  /** @type {Map<string, any>} */
  contexts: new Map(),
  device: localStorage.getItem('wssh.device') || makeDeviceKey(),
  saveTimer: null,
};

if (!localStorage.getItem('wssh.device')) localStorage.setItem('wssh.device', state.device);

function makeDeviceKey() {
  // Телефон и ноутбук не должны перетягивать друг у друга раскладку: ключ устройства
  // живёт в localStorage и переезжает только вместе с профилем браузера.
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4400);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function statusLabel(status) {
  return (
    {
      active: 'подключено',
      starting: 'подключается',
      detached: 'в фоне',
      exited: 'завершено',
      lost: 'потеряно',
      connecting: 'соединение',
      reconnecting: 'переподключение',
    }[status] || status
  );
}

function statusClass(status) {
  if (status === 'active') return 'alive';
  if (status === 'detached' || status === 'connecting' || status === 'reconnecting' || status === 'starting') return 'detached';
  if (status === 'lost') return 'lost';
  return 'idle';
}

// ── Авторизация ─────────────────────────────────────────────────────────────────────

async function boot() {
  bindStaticHandlers();
  try {
    const auth = await api.authState();
    state.needsSetup = auth.needsSetup;
    if (!auth.authenticated) return showAuth();
    state.user = { login: auth.login };
    return enterApp();
  } catch (err) {
    showAuth(`сервис недоступен: ${err.message}`);
  }
}

function showAuth(notice) {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  const setup = state.needsSetup;
  $('#auth-title').textContent = setup ? 'Первый запуск' : 'Вход';
  $('#auth-sub').textContent = setup
    ? 'В базе нет ни одного пользователя. Создай владельца — после этого регистрация закрывается.'
    : 'Веб-терминал с сессиями, которые переживают перезапуск сервиса.';
  $('#auth-submit').textContent = setup ? 'Создать владельца' : 'Войти';
  $('#auth-notice').textContent = notice || '';
  $('#auth-notice').classList.toggle('hidden', !notice);
}

async function submitAuth(event) {
  event.preventDefault();
  const login = $('#auth-login').value.trim();
  const password = $('#auth-password').value;
  $('#auth-error').textContent = '';
  try {
    if (state.needsSetup) await api.register(login, password);
    else await api.login(login, password);
    const auth = await api.authState();
    state.user = { login: auth.login };
    await enterApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
}

async function enterApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try {
    await reloadAll();
    await restoreLayout();
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      return showAuth('сессия истекла — войди заново');
    }
    toast(err.message, 'error');
  }
  renderAll();
  // Раскладка восстановлена — активная вкладка должна не просто «быть», а подключиться:
  // иначе после F5 видно имя сессии и пустой экран.
  if (state.active) activate(state.active);
}

async function logout() {
  for (const ctx of state.contexts.values()) closeContext(ctx, { kill: false });
  state.contexts.clear();
  state.tabs = [];
  state.active = null;
  await api.logout().catch(() => {});
  state.user = null;
  showAuth();
}

// ── Данные ──────────────────────────────────────────────────────────────────────────

async function reloadAll() {
  const [hosts, credentials, sessions] = await Promise.all([api.hosts(), api.credentials(), api.sessions()]);
  state.hosts = hosts;
  state.credentials = credentials;
  state.sessions = sessions;
}

async function restoreLayout() {
  try {
    const saved = await api.getState(state.device);
    const data = saved.data || {};
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    // Только те, к чему можно подключиться: иначе F5 после удаления сессии запускает
    // бесконечный reconnect к мёртвому сокету.
    state.tabs = (data.tabs || []).filter((id) => isOpenable(byId.get(id)));
    state.active = state.tabs.includes(data.active) ? data.active : state.tabs[0] || null;
  } catch {
    state.tabs = [];
    state.active = null;
  }
}

function persistLayout() {
  // Дебаунс: переключение вкладок — частое действие, а запись в БД — fsync.
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    api.putState(state.device, { tabs: state.tabs, active: state.active }).catch(() => {});
  }, 400);
}

// ── Отрисовка ───────────────────────────────────────────────────────────────────────

function renderAll() {
  renderRail();
  renderTabs();
  renderStatus();
  $('#btn-logout').title = `Выйти (${state.user?.login || ''})`;
}

function sessionById(id) {
  return state.sessions.find((s) => s.id === id) || null;
}

function isOpenable(s) {
  return Boolean(s) && s.status !== 'exited' && s.status !== 'lost';
}

function renderRail() {
  const sessionsBox = $('#list-sessions');
  sessionsBox.replaceChildren();
  const visible = state.sessions.filter((s) => s.status !== 'exited');
  if (visible.length === 0) {
    sessionsBox.append(emptyNote('Сессий нет: выбери хост ниже.'));
  }
  for (const s of visible) {
    const ctx = state.contexts.get(s.id);
    const status = ctx?.status || s.status;
    const row = document.createElement('div');
    row.className = 'rail-item' + (s.id === state.active ? ' active' : '');
    row.title = `${s.hostLabel || ''} ${s.title} — ${statusLabel(status)}`;

    const dot = document.createElement('i');
    dot.className = `dot ${statusClass(status)}`;
    row.append(dot);

    const name = document.createElement('span');
    name.className = 'rail-name';
    name.textContent = s.title;
    row.append(name);

    const kill = document.createElement('button');
    kill.className = 'rail-kill';
    kill.title = 'Завершить сессию (SSH закроется)';
    kill.textContent = '⏻';
    kill.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Завершить сессию «${s.title}»? Канал SSH будет закрыт.`)) return;
      await api.killSession(s.id).catch((e) => toast(e.message, 'error'));
      removeTab(s.id);
      await reloadAll();
      renderAll();
    });
    row.append(kill);

    row.addEventListener('click', () => openTab(s.id));
    sessionsBox.append(row);
  }

  const hostsBox = $('#list-hosts');
  hostsBox.replaceChildren();
  if (state.hosts.length === 0) {
    hostsBox.append(emptyNote('Хостов нет — добавь в настройках (⚙).'));
  }
  for (const h of state.hosts) {
    const row = document.createElement('div');
    row.className = 'rail-item';
    row.title = `${h.username}@${h.host}:${h.port}`;
    const dot = document.createElement('i');
    dot.className = 'dot idle';
    row.append(dot);
    const name = document.createElement('span');
    name.className = 'rail-name';
    name.textContent = h.label;
    row.append(name);
    const meta = document.createElement('span');
    meta.className = 'rail-meta';
    meta.textContent = h.credential_id ? 'ключ' : 'порт ' + h.port;
    row.append(meta);
    row.addEventListener('click', () => createSessionFor(h));
    hostsBox.append(row);
  }
}

function emptyNote(text) {
  const el = document.createElement('div');
  el.className = 'rail-empty';
  el.textContent = text;
  return el;
}

function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren();
  for (const id of state.tabs) {
    const s = sessionById(id);
    if (!s) continue;
    const ctx = state.contexts.get(id);
    const status = ctx?.status || s.status;
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === state.active ? ' active' : '');
    const dot = document.createElement('i');
    dot.className = `dot ${statusClass(status)}`;
    tab.append(dot);
    const label = document.createElement('span');
    label.textContent = s.title;
    tab.append(label);
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.title = 'Закрыть вкладку — сессия останется жить на сервере';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      detachTab(id);
    });
    tab.append(close);
    tab.addEventListener('click', () => activate(id));
    box.append(tab);
  }

  const add = document.createElement('button');
  add.className = 'tab add';
  add.textContent = '+';
  add.title = 'Хосты и креды';
  add.addEventListener('click', openSettings);
  box.append(add);
}

function renderStatus() {
  const s = state.active ? sessionById(state.active) : null;
  const ctx = state.active ? state.contexts.get(state.active) : null;
  const status = ctx?.status || s?.status || 'idle';

  $('#conn-text').textContent = statusLabel(status);
  $('#conn-dot').className = `dot ${statusClass(status)}`;
  const statusDot = $('#conn-dot-status');
  if (statusDot) statusDot.className = `dot ${statusClass(status)}`;
  // Метка хоста уже входит в заголовок («prod #2»), дублировать её в статус-баре незачем.
  $('#status-host').textContent = s
    ? s.hostLabel && !s.title.startsWith(s.hostLabel)
      ? `${s.hostLabel} · ${s.title}`
      : s.title
    : '—';
  $('#status-size').textContent = ctx ? `${ctx.term.cols}×${ctx.term.rows}` : '—';
  // Не «seq» воркера: клиент знает только, до какого чанка он восстановил историю.
  // Показывать счётчик живого потока здесь было бы враньём — кадры его не несут.
  $('#status-seq').textContent = ctx ? `hist ${ctx.historySeq}` : '—';
  $('#status-mode').textContent = ctx?.term ? 'UTF-8' : '—';
}

// ── Терминалы ───────────────────────────────────────────────────────────────────────

function terminalFor(id) {
  const existing = state.contexts.get(id);
  if (existing) return existing;

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.dataset.session = id;
  $('#terminals').append(pane);

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.45,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);

  const ctx = {
    id,
    pane,
    term,
    fit,
    ws: null,
    status: 'connecting',
    lastSeq: 0,
    historySeq: 0,
    retries: 0,
    detachedByUser: false,
    reconnectTimer: null,
    exited: false,
  };
  state.contexts.set(id, ctx);

  term.onData((data) => {
    if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
      ctx.ws.send(encodeFrame(FRAME_IN, new TextEncoder().encode(data)));
    }
  });

  term.onResize(({ cols, rows }) => {
    sendResize(ctx, cols, rows);
  });

  return ctx;
}

function sendResize(ctx, cols = ctx.term.cols, rows = ctx.term.rows) {
  if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
    ctx.ws.send(encodeControl({ t: 'resize', rows, cols }));
  }
}

function setCtxStatus(ctx, status) {
  ctx.status = status;
  const s = sessionById(ctx.id);
  if (s) s.status = status === 'connecting' ? s.status : status;
  renderRail();
  renderTabs();
  renderStatus();
}

/**
 * Подключение к воркеру. История запрашивается из БД до открытия сокета: так после
 * перезагрузки страницы на экране оказывается всё, что сервер успел записать, а живой
 * поток начинается с ровно того места, где кончилась история.
 */
async function connect(ctx) {
  if (ctx.connecting || ctx.ws) return;
  ctx.connecting = true;
  setCtxStatus(ctx, ctx.retries > 0 ? 'reconnecting' : 'connecting');
  let from = 0;
  try {
    const { chunks } = await api.scrollback(ctx.id, 0, 5000);
    ctx.term.reset();
    for (const chunk of chunks) {
      ctx.term.write(base64ToBytes(chunk.data));
      from = chunk.seq;
    }
    ctx.lastSeq = from;
    ctx.historySeq = from;
  } catch (err) {
    ctx.term.writeln(`\r\n\x1b[31m[история недоступна: ${err.message}]\x1b[0m`);
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/session/${encodeURIComponent(ctx.id)}`);
  ws.binaryType = 'arraybuffer';
  ctx.ws = ws;
  ctx.connecting = false;
  const decoder = new FrameDecoder();

  ws.addEventListener('open', () => {
    ws.send(encodeControl({ t: 'attach', from }));
    sendResize(ctx);
  });

  ws.addEventListener('message', (event) => {
    const bytes = new Uint8Array(event.data);
    let frames;
    try {
      frames = decoder.push(bytes);
    } catch (err) {
      ctx.term.writeln(`\r\n\x1b[31m[повреждённый кадр: ${err.message}]\x1b[0m`);
      ws.close();
      return;
    }
    for (const frame of frames) {
      if (frame.type === FRAME_OUT) {
        ctx.term.write(frame.payload);
      } else if (frame.type === FRAME_CONTROL) {
        handleControl(ctx, decodeControl(frame));
      }
    }
  });

  ws.addEventListener('close', () => {
    ctx.ws = null;
    if (ctx.detachedByUser || ctx.exited) return;
    scheduleReconnect(ctx);
  });

  ws.addEventListener('error', () => {
    /* close придёт следом; повтор — там же */
  });
}

function handleControl(ctx, msg) {
  switch (msg.t) {
    case 'hello':
      ctx.lastSeq = Math.max(ctx.lastSeq, msg.lastSeq || 0);
      if (msg.status === 'exited' || msg.status === 'lost') {
        ctx.exited = true;
        setCtxStatus(ctx, msg.status);
      }
      break;
    case 'attached':
      ctx.retries = 0;
      setCtxStatus(ctx, 'active');
      // fit() прошёл до открытия сокета — актуальные размеры отправляем здесь,
      // иначе удалённый pty остаётся 80×24 и переносит строки не там.
      sendResize(ctx);
      renderStatus();
      break;
    case 'status':
      if (msg.status === 'exited' || msg.status === 'lost') ctx.exited = true;
      setCtxStatus(ctx, msg.status);
      break;
    case 'exit':
      ctx.exited = true;
      setCtxStatus(ctx, 'exited');
      ctx.term.writeln(`\r\n\x1b[2m[сессия завершена${msg.code !== null ? `, код ${msg.code}` : ''}]\x1b[0m`);
      break;
    case 'error':
      ctx.term.writeln(`\r\n\x1b[31m[${msg.message}]\x1b[0m`);
      break;
    default:
      break;
  }
}

const MAX_RECONNECT = 8;

function scheduleReconnect(ctx) {
  if (ctx.reconnectTimer) return;
  ctx.retries += 1;
  if (ctx.retries > MAX_RECONNECT) {
    ctx.exited = true;
    setCtxStatus(ctx, 'lost');
    ctx.term.writeln('\r\n\x1b[31m[соединение не восстановилось — сессия помечена потерянной]\x1b[0m');
    return;
  }
  const delay = Math.min(1000 * 2 ** (ctx.retries - 1), 15000);
  setCtxStatus(ctx, 'reconnecting');
  ctx.reconnectTimer = setTimeout(() => {
    ctx.reconnectTimer = null;
    connect(ctx).catch(() => scheduleReconnect(ctx));
  }, delay);
}

function closeContext(ctx, { kill }) {
  clearTimeout(ctx.reconnectTimer);
  ctx.detachedByUser = true;
  if (ctx.ws) {
    try {
      ctx.ws.send(encodeControl({ t: 'detach' }));
    } catch {
      /* сокет мог уже закрыться */
    }
    ctx.ws.close();
    ctx.ws = null;
  }
  if (kill) ctx.term.dispose();
}

async function openTab(id) {
  const s = sessionById(id);
  if (!s) return;
  if (s.status === 'lost' || s.status === 'exited') {
    const again = confirm(`Сессия «${s.title}» ${s.status === 'lost' ? 'потеряна (соединение не пережило перезапуск)' : 'завершена'}. Открыть новую к этому хосту?`);
    if (again && s.hostId) {
      const host = state.hosts.find((h) => h.id === s.hostId);
      if (host) return createSessionFor(host);
    }
    return;
  }
  if (!state.tabs.includes(id)) state.tabs.push(id);
  activate(id);
}

function activate(id) {
  const s = sessionById(id);
  if (s && !isOpenable(s)) {
    toast(`Сессия «${s.title}» ${s.status === 'lost' ? 'потеряна' : 'завершена'} — открой новую к этому хосту`, 'error');
    return;
  }
  state.active = id;
  const ctx = terminalFor(id);
  for (const [key, other] of state.contexts) {
    other.pane.classList.toggle('visible', key === id);
  }
  ctx.pane.classList.add('visible');
  requestAnimationFrame(() => {
    try {
      ctx.fit.fit();
    } catch {
      /* панель могла быть скрыта */
    }
    ctx.term.focus();
  });
  if (!ctx.ws && !ctx.exited) connect(ctx).catch(() => scheduleReconnect(ctx));
  renderAll();
  persistLayout();
}

function detachTab(id) {
  const ctx = state.contexts.get(id);
  if (ctx) {
    closeContext(ctx, { kill: true });
    state.contexts.delete(id);
    ctx.pane.remove();
  }
  state.tabs = state.tabs.filter((t) => t !== id);
  if (state.active === id) state.active = state.tabs[state.tabs.length - 1] || null;
  if (state.active) activate(state.active);
  else {
    for (const pane of document.querySelectorAll('.term-pane')) pane.classList.remove('visible');
    renderAll();
  }
  persistLayout();
  toast('Вкладка закрыта, сессия живёт на сервере — вернуться можно из списка слева');
}

function removeTab(id) {
  const ctx = state.contexts.get(id);
  if (ctx) {
    closeContext(ctx, { kill: true });
    state.contexts.delete(id);
    ctx.pane.remove();
  }
  state.tabs = state.tabs.filter((t) => t !== id);
  if (state.active === id) state.active = state.tabs[state.tabs.length - 1] || null;
  persistLayout();
}

async function createSessionFor(host) {
  const term = state.contexts.get(state.active)?.term;
  const rows = term?.rows ?? 24;
  const cols = term?.cols ?? 80;
  try {
    const { id } = await api.createSession({ hostId: host.id, rows, cols });
    await reloadAll();
    state.tabs.push(id);
    activate(id);
  } catch (err) {
    toast(`Не удалось открыть сессию: ${err.message}`, 'error');
  }
}

// ── Настройки: хосты и креды ────────────────────────────────────────────────────────

function openSettings() {
  $('#settings').classList.remove('hidden');
  renderSettings();
}

function closeSettings() {
  $('#settings').classList.add('hidden');
}

function renderSettings() {
  const credSelect = $('#host-credential');
  credSelect.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— без кредов (спросит сервер) —';
  credSelect.append(none);
  for (const c of state.credentials) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.label} (${c.kind === 'key' ? 'ключ' : 'пароль'})`;
    credSelect.append(opt);
  }

  const credList = $('#cred-list');
  credList.replaceChildren();
  if (state.credentials.length === 0) credList.append(emptyNote('Кредов нет.'));
  for (const c of state.credentials) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const name = document.createElement('span');
    name.textContent = `${c.label} · ${c.kind === 'key' ? 'ключ' : 'пароль'}`;
    row.append(name);
    const del = document.createElement('button');
    del.className = 'link-danger';
    del.textContent = 'удалить';
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить кред «${c.label}»? Хосты, которые им пользовались, останутся без кредов.`)) return;
      await api.deleteCredential(c.id).catch((e) => toast(e.message, 'error'));
      await reloadAll();
      renderSettings();
      renderRail();
    });
    row.append(del);
    credList.append(row);
  }

  const hostList = $('#host-list');
  hostList.replaceChildren();
  if (state.hosts.length === 0) hostList.append(emptyNote('Хостов нет.'));
  for (const h of state.hosts) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const name = document.createElement('span');
    name.textContent = `${h.label} — ${h.username}@${h.host}:${h.port}`;
    row.append(name);
    const del = document.createElement('button');
    del.className = 'link-danger';
    del.textContent = 'удалить';
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить хост «${h.label}»?`)) return;
      await api.deleteHost(h.id).catch((e) => toast(e.message, 'error'));
      await reloadAll();
      renderSettings();
      renderRail();
    });
    row.append(del);
    hostList.append(row);
  }
}

async function submitHost(event) {
  event.preventDefault();
  const payload = {
    label: $('#host-label').value.trim(),
    host: $('#host-address').value.trim(),
    port: Number($('#host-port').value) || 22,
    username: $('#host-user').value.trim(),
    credentialId: $('#host-credential').value || undefined,
    note: $('#host-note').value.trim() || undefined,
  };
  if (!payload.label || !payload.host || !payload.username) {
    toast('Нужны метка, адрес и пользователь', 'error');
    return;
  }
  try {
    await api.addHost(payload);
    $('#form-host').reset();
    await reloadAll();
    renderSettings();
    renderRail();
    toast(`Хост «${payload.label}» добавлен`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function submitCredential(event) {
  event.preventDefault();
  const kind = $('#cred-kind').value;
  const payload = {
    label: $('#cred-label').value.trim(),
    kind,
    secret: $('#cred-secret').value,
    passphrase: kind === 'key' ? $('#cred-passphrase').value || undefined : undefined,
  };
  if (!payload.label || !payload.secret) {
    toast('Нужны метка и секрет', 'error');
    return;
  }
  try {
    await api.addCredential(payload);
    $('#form-credential').reset();
    await reloadAll();
    renderSettings();
    toast('Кред сохранён (шифрование на сервере, обратно не отдаётся)');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Обвязка интерфейса ──────────────────────────────────────────────────────────────

function bindStaticHandlers() {
  $('#form-auth').addEventListener('submit', submitAuth);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#form-host').addEventListener('submit', submitHost);
  $('#form-credential').addEventListener('submit', submitCredential);

  const rail = $('#rail');
  const scrim = $('#scrim');
  const toggleRail = () => {
    rail.classList.toggle('open');
    scrim.classList.toggle('visible');
  };
  $('#btn-rail').addEventListener('click', toggleRail);
  scrim.addEventListener('click', toggleRail);

  $('#btn-new').addEventListener('click', () => {
    if (state.hosts.length === 0) openSettings();
    else toast('Выбери хост в списке слева — откроется новая консоль');
  });

  // Клавиши, которых нет на мобильной клавиатуре. Шлём готовые байты, а не
  // «нажимаем Ctrl»: предсказуемо и работает одинаково на iOS и Android.
  for (const btn of document.querySelectorAll('#keybar button')) {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      const ctx = state.active ? state.contexts.get(state.active) : null;
      if (!ctx || !ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) return;
      const seq = JSON.parse(btn.dataset.seq);
      ctx.ws.send(encodeFrame(FRAME_IN, new TextEncoder().encode(seq)));
      ctx.term.focus();
    });
  }

  window.addEventListener('resize', () => {
    const ctx = state.active ? state.contexts.get(state.active) : null;
    if (ctx) {
      try {
        ctx.fit.fit();
        renderStatus();
      } catch {
        /* игнорируем: панель может быть в процессе перестроения */
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#settings').classList.contains('hidden')) closeSettings();
  });
}

boot();
