const STORAGE_KEY = 'wish-service-data';
const AUTH_KEY_STORAGE = 'wish-service-sync-key';
const API_BASE = '/api/wishes';
const POLL_MS = 2500;

const DIFFICULTY = {
  easy: { label: 'Лёгкое', points: 5, emoji: '🟢' },
  medium: { label: 'Среднее', points: 15, emoji: '🟡' },
  hard: { label: 'Сложное', points: 30, emoji: '🔴' },
  legendary: { label: 'Легендарное', points: 50, emoji: '💜' },
};

const BONUSES = {
  hug: '🤗 Объятия',
  kiss: '💋 Поцелуй',
  compliment: '💬 Комплимент',
  massage: '💆 Массаж',
  gift: '🎁 Подарок',
  custom: null,
};

const STATUS_LABELS = {
  pending: '⏳ Ожидает',
  active: '🔧 В работе',
  done: '✅ Выполнено',
};

const TEMPLATES = {
  coffee: { title: 'Принеси кофе', desc: 'Тёплый, с любовью', difficulty: 'easy', type: 'real', bonus: 'kiss' },
  movie: { title: 'Посмотри со мной фильм', desc: 'Выбираю я 🎬', difficulty: 'medium', type: 'real', bonus: 'hug' },
  massage: { title: 'Сделай массаж', desc: 'Плечи или спина — на твой выбор', difficulty: 'hard', type: 'real', bonus: 'massage' },
  hug: { title: 'Обними меня', desc: 'Крепко и надолго', difficulty: 'easy', type: 'real', bonus: 'hug' },
  joke: { title: 'Расскажи шутку дня', desc: 'Чем хуже — тем лучше', difficulty: 'easy', type: 'joke', bonus: 'compliment' },
};

let state = { wishes: [], version: 0, updatedAt: null };
let currentRole = 'customer';
let executorFilter = 'pending';
let useCloud = true;
let pollTimer = null;
let isSyncing = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function getAuthKey() {
  return localStorage.getItem(AUTH_KEY_STORAGE) || '';
}

function setAuthKey(key) {
  if (key) localStorage.setItem(AUTH_KEY_STORAGE, key);
  else localStorage.removeItem(AUTH_KEY_STORAGE);
}

function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const key = getAuthKey();
  if (key) headers['X-Wish-Key'] = key;
  return headers;
}

function setSyncStatus(mode, label) {
  const el = $('#sync-status');
  el.className = `sync-status ${mode}`;
  $('#sync-label').textContent = label;
}

async function apiRequest(method, body) {
  const opts = { method, headers: apiHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(API_BASE, opts);
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    setAuthKey('');
    $('#auth-modal').showModal();
    throw new Error('auth');
  }

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

function applyServerState(serverState, reRender = true) {
  const prevVersion = state.version || 0;
  state = {
    wishes: serverState.wishes || [],
    version: serverState.version || 0,
    updatedAt: serverState.updatedAt || null,
  };
  if (reRender && state.version !== prevVersion) {
    renderWishes();
  } else if (reRender) {
    updateStats();
  }
}

async function fetchFromCloud(silent = false) {
  if (!useCloud) return false;
  if (!silent) setSyncStatus('syncing', 'Синхронизация…');

  try {
    const data = await apiRequest('GET');
    applyServerState(data, true);
    setSyncStatus('online', 'Синхронизировано');
    return true;
  } catch (err) {
    if (err.message === 'auth') {
      setSyncStatus('offline', 'Нужен ключ');
      return false;
    }
    if (!silent) setSyncStatus('offline', 'Нет связи');
    return false;
  }
}

async function pushWish(wish) {
  if (useCloud) {
    const data = await apiRequest('POST', { wish });
    applyServerState(data, true);
    return;
  }
  state.wishes.unshift(wish);
  saveLocalState();
  renderWishes();
}

async function patchWish(id, patch) {
  if (useCloud) {
    const data = await apiRequest('PATCH', { id, patch });
    applyServerState(data, true);
    return;
  }
  const wish = state.wishes.find((w) => w.id === id);
  if (wish) Object.assign(wish, patch);
  saveLocalState();
  renderWishes();
}

async function removeWish(id) {
  if (useCloud) {
    const data = await apiRequest('DELETE', { id });
    applyServerState(data, true);
    return;
  }
  state.wishes = state.wishes.filter((w) => w.id !== id);
  saveLocalState();
  renderWishes();
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { wishes: [] };
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ wishes: state.wishes }));
}

async function migrateLocalToCloud() {
  const local = loadLocalState();
  if (!local.wishes?.length) return;

  const server = await apiRequest('GET');
  if (server.wishes?.length > 0) return;

  await apiRequest('PUT', { wishes: local.wishes });
  localStorage.removeItem(STORAGE_KEY);
  showToast('Старые заказы перенесены в облако ☁️');
}

async function detectCloud() {
  try {
    const res = await fetch(API_BASE, { method: 'GET', headers: apiHeaders() });
    if (res.status === 401) {
      useCloud = true;
      if (!getAuthKey()) {
        $('#auth-modal').showModal();
        setSyncStatus('offline', 'Введите ключ');
      } else {
        setSyncStatus('offline', 'Неверный ключ');
        $('#auth-modal').showModal();
      }
      return true;
    }
    if (res.ok) {
      useCloud = true;
      const data = await res.json();
      applyServerState(data, true);
      await migrateLocalToCloud();
      setSyncStatus('online', 'Синхронизировано');
      return true;
    }
  } catch (_) {}

  useCloud = false;
  state = loadLocalState();
  if (!state.wishes) state.wishes = [];
  setSyncStatus('local', 'Только на этом устройстве');
  renderWishes();
  return false;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (!useCloud) return;

  pollTimer = setInterval(() => {
    if (document.hidden || isSyncing) return;
    fetchFromCloud(true).then((ok) => {
      if (ok) setSyncStatus('online', 'Синхронизировано');
    });
  }, POLL_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && useCloud) fetchFromCloud(true);
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getBonusLabel(wish) {
  if (wish.bonusType === 'custom') return wish.bonusCustom || '✏️ Свой бонус';
  return BONUSES[wish.bonusType] || wish.bonusType;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function updateStats() {
  const wishes = state.wishes;
  const done = wishes.filter((w) => w.status === 'done');
  $('#stat-total').textContent = wishes.length;
  $('#stat-done').textContent = done.length;
  $('#stat-points').textContent = done.reduce((s, w) => s + (DIFFICULTY[w.difficulty]?.points || 0), 0);
  $('#stat-bonuses').textContent = done.length;
}

function setRole(role) {
  currentRole = role;
  $$('.role-btn').forEach((btn) => {
    const active = btn.dataset.role === role;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });
  $('#panel-customer').classList.toggle('active', role === 'customer');
  $('#panel-executor').classList.toggle('active', role === 'executor');
  $('#wishes-title').textContent = role === 'customer' ? 'Мои заказы' : 'Очередь исполнителя';
  renderWishes();
}

function filterWishesForRole(wishes) {
  if (currentRole === 'customer') {
    return [...wishes].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  let filtered = wishes;
  if (executorFilter === 'pending') filtered = wishes.filter((w) => w.status === 'pending');
  else if (executorFilter === 'active') filtered = wishes.filter((w) => w.status === 'active');
  else if (executorFilter === 'done') filtered = wishes.filter((w) => w.status === 'done');
  const order = { pending: 0, active: 1, done: 2 };
  return [...filtered].sort((a, b) => order[a.status] - order[b.status] || new Date(b.createdAt) - new Date(a.createdAt));
}

function renderWishes() {
  const list = $('#wishes-list');
  const empty = $('#empty-state');
  const filtered = filterWishesForRole(state.wishes);

  list.innerHTML = '';

  if (filtered.length === 0) {
    empty.classList.remove('hidden');
    empty.querySelector('.empty-icon').textContent = currentRole === 'customer' ? '🌙' : '📭';
    empty.lastChild.textContent =
      currentRole === 'customer'
        ? ' Пока пусто. Создай первое желание!'
        : ' Нет заказов в этой категории.';
    updateStats();
    return;
  }

  empty.classList.add('hidden');

  filtered.forEach((wish) => {
    const li = document.createElement('li');
    li.className = `wish-card status-${wish.status}`;
    const diff = DIFFICULTY[wish.difficulty];
    const typeBadge =
      wish.type === 'joke'
        ? '<span class="badge badge-type-joke">🎭 Шутка</span>'
        : '<span class="badge badge-status">Реальное</span>';

    li.innerHTML = `
      <div class="wish-card-header">
        <h4 class="wish-title">${escapeHtml(wish.title)}</h4>
        <div class="wish-badges">
          <span class="badge badge-difficulty-${wish.difficulty}">${diff.emoji} ${diff.label}</span>
          ${typeBadge}
          <span class="badge badge-status">${STATUS_LABELS[wish.status]}</span>
        </div>
      </div>
      ${wish.description ? `<p class="wish-desc">${escapeHtml(wish.description)}</p>` : ''}
      <div class="wish-meta">
        <span class="wish-bonus">Бонус: ${escapeHtml(getBonusLabel(wish))}</span>
        <span class="wish-points">+${diff.points} баллов</span>
        <span class="wish-date">${formatDate(wish.createdAt)}</span>
      </div>
      <div class="wish-actions"></div>
    `;

    const actions = li.querySelector('.wish-actions');
    appendActions(actions, wish);
    list.appendChild(li);
  });

  updateStats();
}

function appendActions(container, wish) {
  if (currentRole === 'customer') {
    if (wish.status !== 'done') {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger';
      del.textContent = 'Отменить заказ';
      del.addEventListener('click', () => deleteWish(wish.id));
      container.appendChild(del);
    }
    return;
  }

  if (wish.status === 'pending') {
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'btn btn-primary';
    accept.textContent = '✋ Принять заказ';
    accept.addEventListener('click', () => acceptWish(wish.id));
    container.appendChild(accept);
  }

  if (wish.status === 'active') {
    const complete = document.createElement('button');
    complete.type = 'button';
    complete.className = 'btn btn-success';
    complete.textContent = '🎉 Отметить выполненным';
    complete.addEventListener('click', () => completeWish(wish.id));
    container.appendChild(complete);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Вернуть в очередь';
    cancel.addEventListener('click', () => setWishStatus(wish.id, 'pending'));
    container.appendChild(cancel);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function withSync(fn) {
  isSyncing = true;
  try {
    await fn();
  } catch (err) {
    if (err.message === 'auth') return;
    showToast('Ошибка: ' + (err.message || 'не удалось сохранить'));
    await fetchFromCloud(true);
  } finally {
    isSyncing = false;
  }
}

async function addWish(data) {
  const wish = {
    id: generateId(),
    title: data.title.trim(),
    description: (data.description || '').trim(),
    difficulty: data.difficulty,
    type: data.type,
    bonusType: data.bonusType,
    bonusCustom: data.bonusCustom || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  await withSync(async () => {
    await pushWish(wish);
    showToast('✨ Заказ отправлен в службу!');
  });
}

async function acceptWish(id) {
  await withSync(async () => {
    await patchWish(id, { status: 'active', completedAt: null });
    showToast('Заказ принят! Удачи, герой 🦸');
  });
}

async function completeWish(id) {
  const wish = state.wishes.find((w) => w.id === id);
  if (!wish) return;

  await withSync(async () => {
    await patchWish(id, {
      status: 'done',
      completedAt: new Date().toISOString(),
    });

    const diff = DIFFICULTY[wish.difficulty];
    $('#complete-modal-text').textContent = `«${wish.title}» — выполнено!`;
    $('#complete-modal-bonus').textContent = `Заказчик получает: ${getBonusLabel(wish)} · +${diff.points} баллов`;
    $('#complete-modal').showModal();
    showToast('🎉 Ещё одно желание сбылось!');
  });
}

async function setWishStatus(id, status) {
  const patch = { status };
  if (status !== 'done') patch.completedAt = null;
  await withSync(() => patchWish(id, patch));
}

async function deleteWish(id) {
  if (!confirm('Отменить этот заказ?')) return;
  await withSync(async () => {
    await removeWish(id);
    showToast('Заказ отменён');
  });
}

function applyTemplate(key) {
  const t = TEMPLATES[key];
  if (!t) return;
  $('#wish-title').value = t.title;
  $('#wish-desc').value = t.desc;
  $('#wish-difficulty').value = t.difficulty;
  $('#wish-type').value = t.type;
  const bonusRadio = document.querySelector(`input[name="bonus"][value="${t.bonus}"]`);
  if (bonusRadio) bonusRadio.checked = true;
  toggleCustomBonus();
  showToast('Шаблон подставлен — можно отправлять!');
}

function toggleCustomBonus() {
  const isCustom = document.querySelector('input[name="bonus"]:checked')?.value === 'custom';
  $('#wish-bonus-custom').classList.toggle('hidden', !isCustom);
}

$$('.role-btn').forEach((btn) => {
  btn.addEventListener('click', () => setRole(btn.dataset.role));
});

$$('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    executorFilter = btn.dataset.filter;
    renderWishes();
  });
});

$('#wish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const bonusType = document.querySelector('input[name="bonus"]:checked')?.value || 'hug';
  await addWish({
    title: $('#wish-title').value,
    description: $('#wish-desc').value,
    difficulty: $('#wish-difficulty').value,
    type: $('#wish-type').value,
    bonusType,
    bonusCustom: $('#wish-bonus-custom').value,
  });
  e.target.reset();
  document.querySelector('input[name="bonus"][value="hug"]').checked = true;
  toggleCustomBonus();
});

$$('input[name="bonus"]').forEach((input) => {
  input.addEventListener('change', toggleCustomBonus);
});

$$('.quick-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyTemplate(btn.dataset.template));
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#auth-key-input').value.trim();
  if (!key) return;
  setAuthKey(key);
  $('#auth-modal').close();
  setSyncStatus('syncing', 'Проверка ключа…');
  const ok = await detectCloud();
  if (ok) {
    startPolling();
    showToast('Ключ принят, синхронизация включена ☁️');
  }
});

async function init() {
  toggleCustomBonus();
  setRole('customer');
  setSyncStatus('syncing', 'Подключение…');

  const cloudOk = await detectCloud();
  if (cloudOk) startPolling();
  else renderWishes();
}

init();
