'use strict';

const STORAGE_KEY = 'ovh-dns-updater.apiKey';
const DEFAULT_REFRESH_MS = 10000;
const EVENTS_LIMIT = 100;
const STREAM_RETRY_DELAYS = [1000, 2000, 5000, 10000];

const STATUS_LABELS = {
  pending: 'Pendiente',
  ok: 'Correcto',
  updated: 'Actualizado',
  error: 'Error',
};

const CHECK_STATUS_LABELS = {
  ok: 'Correcta',
  partial: 'Parcial',
  error: 'Error',
};

const TRIGGER_LABELS = {
  startup: 'Arranque',
  scheduler: 'Programador',
  ondemand: 'Bajo demanda',
};

const ACTION_LABELS = {
  updated: 'Registro actualizado',
  unchanged: 'Sin cambios',
  error: 'Error',
  public_ip_changed: 'IP pública cambiada',
};

const state = {
  apiKey: readStoredKey(),
  snapshot: null,
  snapshotReceivedAt: null,
  events: [],
  eventsTotal: 0,
  refreshMs: DEFAULT_REFRESH_MS,
  lastUpdatedAt: null,
  loading: false,
  syncing: false,
  pollTimer: null,
  reconnectTimer: null,
  tickTimer: null,
  streamController: null,
  streamConnected: false,
  streamState: 'idle',
  streamAttempts: 0,
  lastStreamActivityAt: null,
  pollingFallback: false,
  visible: !document.hidden,
  filters: {
    account: '',
    domain: '',
    type: '',
  },
};

const dom = {
  app: document.getElementById('app'),
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  loginSubmit: document.getElementById('login-submit'),
  loginError: document.getElementById('login-error'),
  apiKeyInput: document.getElementById('api-key'),
  errorBanner: document.getElementById('error-banner'),
  currentIp: document.getElementById('current-ip'),
  initialIp: document.getElementById('initial-ip'),
  ipChanged: document.getElementById('ip-changed'),
  lastCheckTime: document.getElementById('last-check-time'),
  lastCheckStatus: document.getElementById('last-check-status'),
  nextCheckTime: document.getElementById('next-check-time'),
  uptime: document.getElementById('uptime'),
  ipProvider: document.getElementById('ip-provider'),
  ipProviderMeta: document.getElementById('ip-provider-meta'),
  schedulerState: document.getElementById('scheduler-state'),
  ondemandState: document.getElementById('ondemand-state'),
  checksCount: document.getElementById('checks-count'),
  updatesCount: document.getElementById('updates-count'),
  errorsCount: document.getElementById('errors-count'),
  accounts: document.getElementById('accounts'),
  accountsCount: document.getElementById('accounts-count'),
  events: document.getElementById('events'),
  eventsCount: document.getElementById('events-count'),
  filterAccount: document.getElementById('filter-account'),
  filterDomain: document.getElementById('filter-domain'),
  filterType: document.getElementById('filter-type'),
  lastUpdated: document.getElementById('last-updated'),
  syncNow: document.getElementById('sync-now'),
  changeKey: document.getElementById('change-key'),
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function readStoredKey() {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeKey(key) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // sessionStorage can be unavailable in private/restricted contexts.
  }
}

function clearStoredKey() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function textOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function fillSelect(select, values, selected, placeholder) {
  select.replaceChildren();
  const all = el('option', null, placeholder);
  all.value = '';
  select.append(all);

  for (const value of values) {
    const option = el('option', null, value);
    option.value = value;
    select.append(option);
  }

  select.value = values.includes(selected) ? selected : '';
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

function formatRelative(iso) {
  if (!iso) return '—';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '—';

  const difference = timestamp - Date.now();
  const future = difference > 0;
  const seconds = Math.round(Math.abs(difference) / 1000);

  if (seconds < 5) return future ? 'en unos segundos' : 'ahora';

  let amount;
  if (seconds < 60) {
    amount = `${seconds} s`;
  } else if (seconds < 3600) {
    amount = `${Math.round(seconds / 60)} min`;
  } else if (seconds < 86400) {
    amount = `${Math.round(seconds / 3600)} h`;
  } else {
    amount = `${Math.round(seconds / 86400)} d`;
  }

  return future ? `en ${amount}` : `hace ${amount}`;
}

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${remainingSeconds} s`;
  return `${remainingSeconds} s`;
}

function formatInterval(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds > 0 && seconds % 3600 === 0) {
    return `${seconds / 3600} h`;
  }
  if (seconds > 0 && seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds} s`;
}

function providerLabel(value) {
  if (!value) return '—';
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function setTimeElement(element, iso, emptyText = '—') {
  if (!iso) {
    element.textContent = emptyText;
    element.removeAttribute('title');
    delete element.dataset.relativeIso;
    return;
  }
  element.dataset.relativeIso = iso;
  element.textContent = formatRelative(iso);
  element.title = formatDate(iso);
}

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  return el('span', `badge badge-${status}`, label);
}

function setChip(element, active, text) {
  element.textContent = text;
  element.className = `chip ${active ? 'chip-active' : 'chip-inactive'}`;
}

function setLoginError(message) {
  dom.loginError.textContent = message || '';
  dom.loginError.hidden = !message;
}

function showBanner(message) {
  dom.errorBanner.textContent = message;
  dom.errorBanner.hidden = false;
}

function hideBanner() {
  dom.errorBanner.textContent = '';
  dom.errorBanner.hidden = true;
}

function showLogin(message = '', clearInput = true) {
  stopStream();
  stopTimers();
  state.streamState = 'idle';
  state.streamAttempts = 0;
  state.pollingFallback = false;
  dom.app.hidden = true;
  dom.login.hidden = false;
  setLoginError(message);
  if (clearInput) dom.apiKeyInput.value = '';
  window.requestAnimationFrame(() => dom.apiKeyInput.focus());
}

function showApp() {
  dom.login.hidden = true;
  dom.app.hidden = false;
}

function updateLastUpdatedLabel() {
  dom.lastUpdated.className = 'last-updated';

  if (!state.apiKey) {
    dom.lastUpdated.textContent = '';
    return;
  }

  if (state.loading) {
    dom.lastUpdated.textContent = 'Actualizando…';
    return;
  }

  if (state.streamState === 'connecting') {
    dom.lastUpdated.textContent = 'Conectando…';
    return;
  }

  if (state.streamState === 'reconnecting') {
    dom.lastUpdated.textContent = 'Reconectando…';
    return;
  }

  if (!state.lastUpdatedAt) {
    dom.lastUpdated.textContent = state.streamState === 'connected'
      ? 'En directo'
      : 'Conectando…';
    return;
  }

  const seconds = Math.max(
    0,
    Math.floor((Date.now() - state.lastUpdatedAt) / 1000),
  );

  let relative;
  if (seconds < 60) {
    relative = `hace ${seconds} s`;
  } else if (seconds < 3600) {
    relative = `hace ${Math.floor(seconds / 60)} min`;
  } else {
    relative = `hace ${Math.floor(seconds / 3600)} h`;
  }

  if (state.streamState === 'connected') {
    dom.lastUpdated.classList.add('is-live');
    dom.lastUpdated.textContent = `En directo · actualizado ${relative}`;
    return;
  }

  if (state.streamState === 'polling') {
    dom.lastUpdated.classList.add('is-polling');
    dom.lastUpdated.textContent = `Respaldo · actualizado ${relative}`;
    return;
  }

  dom.lastUpdated.textContent = `Actualizado ${relative}`;
}

function refreshRelativeTimes() {
  for (const element of document.querySelectorAll('[data-relative-iso]')) {
    const iso = element.dataset.relativeIso;
    if (iso) element.textContent = formatRelative(iso);
  }
}

function refreshUptime() {
  if (!state.snapshot) return;
  const elapsed = state.snapshotReceivedAt
    ? Math.max(0, Math.floor((Date.now() - state.snapshotReceivedAt) / 1000))
    : 0;
  const uptime = (Number(state.snapshot.uptimeSeconds) || 0) + elapsed;
  dom.uptime.textContent = formatUptime(uptime);
}

function refreshClock() {
  updateLastUpdatedLabel();
  refreshRelativeTimes();
  refreshUptime();
  if (state.snapshot) renderProviderInfo(state.snapshot);

  if (
    state.streamState === 'connected' &&
    state.lastStreamActivityAt &&
    Date.now() - state.lastStreamActivityAt > 45_000
  ) {
    state.lastStreamActivityAt = null;
    stopStream();
    handleStreamFailure();
  }
}

function startTickTimer() {
  if (state.tickTimer || !state.visible) return;
  state.tickTimer = window.setInterval(refreshClock, 1000);
}

function clearPollTimer() {
  if (!state.pollTimer) return;
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function stopTimers() {
  clearPollTimer();
  if (state.tickTimer) {
    window.clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
}

function schedulePoll() {
  clearPollTimer();

  if (!state.apiKey || !state.visible || !state.pollingFallback) return;

  state.pollTimer = window.setTimeout(async () => {
    state.pollTimer = null;
    await refreshData();
    if (state.pollingFallback) schedulePoll();
  }, state.refreshMs);
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${state.apiKey}`);
  headers.set('Accept', 'application/json');

  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    let message = `Error HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // The response did not contain JSON.
    }
    throw new ApiError(message, response.status);
  }

  return response.json();
}

function buildFilteredUrl(path) {
  const params = new URLSearchParams();
  params.set('limit', String(EVENTS_LIMIT));
  if (state.filters.account) params.set('account', state.filters.account);
  if (state.filters.domain) params.set('domain', state.filters.domain);
  if (state.filters.type) params.set('type', state.filters.type);
  return `${path}?${params.toString()}`;
}

function buildEventsUrl() {
  return buildFilteredUrl('/api/events');
}

function buildStreamUrl() {
  return buildFilteredUrl('/api/stream');
}

function handleApiError(error) {
  if (error instanceof ApiError && error.status === 401) {
    state.apiKey = '';
    state.snapshot = null;
    state.snapshotReceivedAt = null;
    state.events = [];
    state.eventsTotal = 0;
    state.lastUpdatedAt = null;
    clearStoredKey();
    showLogin('La API key no es válida. Vuelve a introducirla.');
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const text = `No se pudo actualizar el estado: ${message}`;

  if (dom.app.hidden) {
    setLoginError(`No se pudo conectar con el servidor: ${message}`);
  } else {
    showBanner(text);
  }
}

function updateRefreshMs(snapshot) {
  const refreshSeconds = Number(snapshot.ui && snapshot.ui.refreshSeconds);
  state.refreshMs = Number.isFinite(refreshSeconds) && refreshSeconds > 0
    ? Math.min(Math.max(refreshSeconds, 1), 3600) * 1000
    : DEFAULT_REFRESH_MS;
}

function setSnapshot(snapshot) {
  state.snapshot = snapshot;
  state.snapshotReceivedAt = Date.now();
  updateRefreshMs(snapshot);
}

async function refreshData({ initial = false } = {}) {
  if (!state.apiKey) return false;
  if (state.loading) return false;
  if (!state.visible && !initial) return false;

  state.loading = true;
  updateLastUpdatedLabel();
  const requestKey = state.apiKey;

  let eventsWarning = '';

  try {
    const snapshot = await apiFetch('/api/status');
    if (state.apiKey !== requestKey) return false;
    setSnapshot(snapshot);

    renderSnapshot(snapshot);

    try {
      const eventsPayload = await apiFetch(buildEventsUrl());
      if (state.apiKey !== requestKey) return false;
      state.events = Array.isArray(eventsPayload.events) ? eventsPayload.events : [];
      state.eventsTotal = Number(eventsPayload.total) || 0;
      renderEvents(state.eventsTotal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      const message = error instanceof Error ? error.message : String(error);
      eventsWarning = `No se pudo cargar el historial: ${message}`;
    }

    state.lastUpdatedAt = Date.now();
    hideBanner();
    if (eventsWarning) showBanner(eventsWarning);
    storeKey(state.apiKey);
    showApp();
    startTickTimer();
    refreshClock();
    return true;
  } catch (error) {
    handleApiError(error);
    return false;
  } finally {
    state.loading = false;
    refreshClock();
  }
}

function parseSseFrame(raw) {
  let eventName = 'message';
  const dataLines = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return {
      event: eventName,
      data: JSON.parse(dataLines.join('\n')),
    };
  } catch {
    return null;
  }
}

async function readSseStream(body, onFrame) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(raw);
        if (frame) onFrame(frame);
        boundary = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const frame = parseSseFrame(buffer);
      if (frame) onFrame(frame);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after an abort.
    }
  }
}

function applyStreamSnapshot(snapshot) {
  setSnapshot(snapshot);
  state.streamState = 'connected';
  state.streamConnected = true;
  state.streamAttempts = 0;
  state.pollingFallback = false;
  clearPollTimer();
  state.lastUpdatedAt = Date.now();
  renderSnapshot(snapshot);
  hideBanner();
  storeKey(state.apiKey);
  showApp();
  startTickTimer();
}

function applyBootstrap(payload) {
  if (!payload || !payload.snapshot) return false;

  state.events = Array.isArray(payload.events)
    ? payload.events.slice(0, EVENTS_LIMIT)
    : [];
  state.eventsTotal = Number.isFinite(Number(payload.total))
    ? Number(payload.total)
    : state.events.length;

  applyStreamSnapshot(payload.snapshot);
  renderEvents(state.eventsTotal);
  refreshClock();
  return true;
}

function applyUpdate(payload) {
  if (!payload || !payload.snapshot) return false;

  const incoming = Array.isArray(payload.events) ? payload.events : [];
  if (incoming.length > 0) {
    const known = new Set(state.events.map(event => event.id));
    const fresh = incoming.filter(event => !known.has(event.id));
    if (fresh.length > 0) {
      state.events = [...fresh, ...state.events]
        .sort((left, right) => right.id - left.id)
        .slice(0, EVENTS_LIMIT);
    }
  }

  if (Number.isFinite(Number(payload.total))) {
    state.eventsTotal = Number(payload.total);
  }

  applyStreamSnapshot(payload.snapshot);
  renderEvents(state.eventsTotal);
  refreshClock();
  return true;
}

function stopStream() {
  if (state.streamController) {
    state.streamController.abort();
    state.streamController = null;
  }
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.streamConnected = false;
  state.lastStreamActivityAt = null;
}

function startPollingFallback() {
  if (!state.apiKey || !state.visible) return;

  stopStream();
  state.pollingFallback = true;
  state.streamState = 'polling';
  updateLastUpdatedLabel();

  void refreshData({ initial: true }).then(() => {
    if (state.pollingFallback) schedulePoll();
  });
}

function handleStreamFailure() {
  if (!state.apiKey || !state.visible) return;

  state.streamConnected = false;
  state.streamAttempts += 1;

  if (state.streamAttempts > STREAM_RETRY_DELAYS.length) {
    startPollingFallback();
    return;
  }

  state.streamState = 'reconnecting';
  updateLastUpdatedLabel();

  const delay = STREAM_RETRY_DELAYS[state.streamAttempts - 1];
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    void startLiveUpdates();
  }, delay);
}

async function startLiveUpdates() {
  if (!state.apiKey || !state.visible) return;

  stopStream();
  const controller = new AbortController();
  state.streamController = controller;
  state.streamState = 'connecting';
  state.streamConnected = false;
  state.pollingFallback = false;
  clearPollTimer();
  updateLastUpdatedLabel();

  let bootstrapTimer = null;
  let bootstrapTimedOut = false;

  const clearBootstrapTimer = () => {
    if (!bootstrapTimer) return;
    window.clearTimeout(bootstrapTimer);
    bootstrapTimer = null;
  };

  bootstrapTimer = window.setTimeout(() => {
    bootstrapTimedOut = true;
    controller.abort();
  }, 5000);

  try {
    const response = await fetch(buildStreamUrl(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${state.apiKey}`,
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (controller.signal.aborted) return;

    if (response.status === 401) {
      handleApiError(new ApiError('Unauthorized', 401));
      return;
    }
    if (!response.ok) {
      throw new ApiError(`Error HTTP ${response.status}`, response.status);
    }
    if (!response.body) {
      throw new Error('El servidor no devolvió un stream');
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      throw new Error('El servidor no devolvió un stream SSE');
    }

    await readSseStream(response.body, frame => {
      if (state.streamController !== controller || controller.signal.aborted) {
        return;
      }

      state.lastStreamActivityAt = Date.now();

      if (frame.event === 'bootstrap') {
        if (applyBootstrap(frame.data)) clearBootstrapTimer();
      } else if (frame.event === 'update') {
        if (applyUpdate(frame.data)) clearBootstrapTimer();
      } else if (frame.event === 'heartbeat') {
        clearBootstrapTimer();
      }
    });

    if (!controller.signal.aborted) {
      throw new Error('El stream en directo se cerró');
    }
  } catch (error) {
    if (controller.signal.aborted && !bootstrapTimedOut) return;
    if (state.streamController !== controller) return;

    if (error instanceof ApiError && error.status === 401) {
      handleApiError(error);
      return;
    }

    handleStreamFailure();
  } finally {
    clearBootstrapTimer();
    if (state.streamController === controller) {
      state.streamController = null;
    }
  }
}

function renderSnapshot(snapshot) {
  const scheduler = snapshot.scheduler || { enabled: false, intervalSeconds: 0 };
  const ondemand = snapshot.ondemand || { enabled: false };
  const counters = snapshot.counters || { checks: 0, updates: 0, errors: 0 };

  dom.currentIp.textContent = textOrDash(snapshot.currentIp);
  dom.initialIp.textContent = textOrDash(snapshot.initialIp);

  const ipChanged = Boolean(
    snapshot.initialIp &&
    snapshot.currentIp &&
    snapshot.initialIp !== snapshot.currentIp,
  );
  dom.ipChanged.hidden = !ipChanged;
  dom.ipChanged.title = ipChanged
    ? `IP inicial: ${snapshot.initialIp} · IP actual: ${snapshot.currentIp}`
    : '';

  setTimeElement(
    dom.lastCheckTime,
    snapshot.lastCheckAt,
    snapshot.lastCheckAt ? '—' : 'Sin comprobaciones',
  );

  const checkResult = snapshot.lastCheckResult;
  dom.lastCheckStatus.className = 'badge';
  dom.lastCheckStatus.title = '';
  if (!checkResult) {
    dom.lastCheckStatus.textContent = 'Sin datos';
    dom.lastCheckStatus.classList.add('badge-pending');
  } else {
    const status = checkResult.status || 'error';
    dom.lastCheckStatus.textContent = CHECK_STATUS_LABELS[status] || status;
    dom.lastCheckStatus.classList.add(`badge-${status}`);
    if (checkResult.error) dom.lastCheckStatus.title = checkResult.error;
  }

  setTimeElement(
    dom.nextCheckTime,
    snapshot.nextCheckAt,
    scheduler.enabled ? '—' : 'Desactivado',
  );
  dom.uptime.textContent = formatUptime(snapshot.uptimeSeconds);

  renderProviderInfo(snapshot);

  setChip(
    dom.schedulerState,
    scheduler.enabled,
    scheduler.enabled
      ? `Programador activo · cada ${formatInterval(scheduler.intervalSeconds)}`
      : 'Programador desactivado',
  );
  setChip(
    dom.ondemandState,
    ondemand.enabled,
    ondemand.enabled ? 'Bajo demanda activo' : 'Bajo demanda desactivado',
  );

  dom.checksCount.textContent = String(counters.checks || 0);
  dom.updatesCount.textContent = String(counters.updates || 0);
  dom.errorsCount.textContent = String(counters.errors || 0);
  dom.syncNow.hidden = !ondemand.enabled;

  renderAccounts(Array.isArray(snapshot.accounts) ? snapshot.accounts : []);
  renderFilters(Array.isArray(snapshot.accounts) ? snapshot.accounts : []);
}

function renderProviderInfo(snapshot) {
  const providerInfo = snapshot.ipProvider || {
    provider: null,
    lastDetectionAt: null,
    failures: [],
  };
  const failures = Array.isArray(providerInfo.failures) ? providerInfo.failures : [];

  dom.ipProvider.textContent = providerInfo.provider
    ? providerLabel(providerInfo.provider)
    : providerInfo.lastDetectionAt ? 'Ninguno' : '—';
  dom.ipProvider.title = providerInfo.provider || '';

  if (!providerInfo.lastDetectionAt) {
    dom.ipProviderMeta.textContent = 'Sin detecciones todavía';
    dom.ipProviderMeta.title = '';
  } else {
    const detection = `Detección ${formatRelative(providerInfo.lastDetectionAt)}`;
    dom.ipProviderMeta.textContent = failures.length > 0
      ? `${failures.length} ${failures.length === 1 ? 'fallo' : 'fallos'} · ${detection}`
      : detection;
    dom.ipProviderMeta.title = failures
      .map(failure => `${providerLabel(failure.provider)}: ${failure.error}`)
      .join('\n');
  }
}

function renderAccounts(accounts) {
  dom.accounts.replaceChildren();

  if (accounts.length === 0) {
    dom.accountsCount.textContent = '';
    dom.accounts.append(el('p', 'empty-state', 'No hay cuentas activas configuradas.'));
    return;
  }

  let totalRecords = 0;

  for (const account of accounts) {
    const card = el('article', 'account-card');
    const header = el('div', 'account-header');
    const titleWrap = el('div');
    titleWrap.append(el('h3', 'account-title', account.id));

    const recordCount = account.domains.reduce(
      (total, domain) => total + domain.records.length,
      0,
    );
    const domainCount = account.domains.length;
    totalRecords += recordCount;
    titleWrap.append(el(
      'p',
      'account-meta',
      `${recordCount} ${recordCount === 1 ? 'registro' : 'registros'} · ` +
      `${domainCount} ${domainCount === 1 ? 'dominio' : 'dominios'}`,
    ));
    header.append(titleWrap);
    card.append(header);

    if (recordCount === 0) {
      card.append(el('p', 'empty-state', 'Sin registros configurados.'));
      dom.accounts.append(card);
      continue;
    }

    const tableWrap = el('div', 'table-wrap');
    const table = el('table', 'records-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of [
      'Registro',
      'Estado',
      'Valor inicial',
      'Valor actual',
      'Última comprobación',
      'Último cambio',
      'Último error',
    ]) {
      headRow.append(el('th', null, label));
    }
    thead.append(headRow);

    const tbody = el('tbody');

    for (const domain of account.domains) {
      if (domain.records.length === 0) continue;

      const groupRow = el('tr', 'domain-group-row');
      const groupCell = el('th', null, domain.name);
      groupCell.colSpan = 7;
      groupCell.scope = 'colgroup';
      groupRow.append(groupCell);
      tbody.append(groupRow);

      for (const record of domain.records) {
        const row = el('tr');

        const fqdnCell = el('td', 'fqdn-cell');
        const fqdn = el('span', 'fqdn', record.fqdn);
        fqdn.title = record.subdomain === ''
          ? 'Registro raíz (@)'
          : `Subdominio: ${record.subdomain}`;
        fqdnCell.append(fqdn);
        fqdnCell.append(el('span', 'record-type', record.type || 'A'));
        row.append(fqdnCell);

        const statusCell = el('td');
        statusCell.append(statusBadge(record.status));
        row.append(statusCell);

        row.append(el('td', 'value-cell', textOrDash(record.initialValue)));
        row.append(el('td', 'value-cell', textOrDash(record.currentValue)));

        row.append(timeCell(record.lastCheckedAt));
        row.append(timeCell(record.lastChangedAt));

        const errorCell = el('td', 'error-cell');
        if (record.lastError) {
          errorCell.textContent = record.lastError;
          errorCell.title = record.lastError;
        } else {
          errorCell.textContent = '—';
          errorCell.classList.add('muted');
        }
        row.append(errorCell);

        tbody.append(row);
      }
    }

    table.append(thead, tbody);
    tableWrap.append(table);
    card.append(tableWrap);
    dom.accounts.append(card);
  }

  dom.accountsCount.textContent =
    `${accounts.length} ${accounts.length === 1 ? 'cuenta' : 'cuentas'} · ` +
    `${recordsLabel(totalRecords)}`;
}

function recordsLabel(total) {
  return `${total} ${total === 1 ? 'registro' : 'registros'}`;
}

function timeCell(iso) {
  const cell = el('td', 'time-cell');
  const time = el('time', 'time-value');
  if (iso) {
    time.dateTime = iso;
    time.dataset.relativeIso = iso;
    time.textContent = formatRelative(iso);
    time.title = formatDate(iso);
  } else {
    time.textContent = '—';
  }
  cell.append(time);
  return cell;
}

function renderFilters(accounts) {
  const accountIds = accounts.map(account => account.id);

  if (state.filters.account && !accountIds.includes(state.filters.account)) {
    state.filters.account = '';
  }

  const domainSource = state.filters.account
    ? accounts.filter(account => account.id === state.filters.account)
    : accounts;
  const domains = [...new Set(
    domainSource.flatMap(account => account.domains.map(domain => domain.name)),
  )].sort((left, right) => left.localeCompare(right));

  if (state.filters.domain && !domains.includes(state.filters.domain)) {
    state.filters.domain = '';
  }

  fillSelect(dom.filterAccount, accountIds, state.filters.account, 'Todas');
  fillSelect(dom.filterDomain, domains, state.filters.domain, 'Todos');
  dom.filterType.value = state.filters.type;
}

function renderEvents(total) {
  dom.events.replaceChildren();

  if (state.events.length === 0) {
    const hasFilters = Boolean(
      state.filters.account || state.filters.domain || state.filters.type,
    );
    dom.eventsCount.textContent = hasFilters ? 'Sin resultados' : 'Sin eventos';
    dom.events.append(el(
      'li',
      'empty-state',
      hasFilters
        ? 'No hay eventos con los filtros seleccionados.'
        : 'Todavía no se ha registrado ningún evento.',
    ));
    return;
  }

  const totalCount = Math.max(Number(total) || 0, state.events.length);
  dom.eventsCount.textContent = totalCount > state.events.length
    ? `Mostrando ${state.events.length} de ${totalCount}`
    : `${state.events.length} ${state.events.length === 1 ? 'evento' : 'eventos'}`;

  for (const event of state.events) {
    const item = el('li', `event event-${event.action}`);
    item.append(el('span', 'event-marker'));
    const content = el('div', 'event-content');

    const head = el('div', 'event-head');
    head.append(el('strong', 'event-title', ACTION_LABELS[event.action] || event.action));
    head.append(el(
      'span',
      'badge badge-neutral',
      TRIGGER_LABELS[event.trigger] || event.trigger,
    ));
    const time = el('time', 'event-time');
    time.dateTime = event.timestamp;
    time.dataset.relativeIso = event.timestamp;
    time.textContent = formatRelative(event.timestamp);
    time.title = formatDate(event.timestamp);
    head.append(time);
    content.append(head);

    let target = 'Global';
    if (event.action === 'public_ip_changed' && !event.accountId) {
      target = 'IP pública';
    } else if (event.accountId && event.fqdn) {
      target = `${event.accountId} · ${event.fqdn}`;
    } else if (event.accountId && event.domain) {
      target = `${event.accountId} · ${event.domain}`;
    } else if (event.fqdn || event.accountId) {
      target = event.fqdn || event.accountId;
    }
    content.append(el('div', 'event-target', target));

    if (event.oldValue !== null || event.newValue !== null) {
      const values = el('div', 'event-values');
      values.append(el('span', 'value-pill', textOrDash(event.oldValue)));
      values.append(el('span', 'arrow', '→'));
      values.append(el('span', 'value-pill', textOrDash(event.newValue)));
      content.append(values);
    }

    if (event.message) {
      content.append(el('p', 'event-message', event.message));
    }

    item.append(content);
    dom.events.append(item);
  }
}

async function syncNow() {
  if (state.syncing) return;

  state.syncing = true;
  dom.syncNow.disabled = true;
  dom.syncNow.textContent = 'Comprobando…';
  hideBanner();

  try {
    await apiFetch('/api/sync', { method: 'POST' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleApiError(error);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      showBanner(`No se pudo completar la comprobación: ${message}`);
    }
  } finally {
    state.syncing = false;
    dom.syncNow.disabled = false;
    dom.syncNow.textContent = 'Comprobar ahora';
  }

  if (state.apiKey && state.pollingFallback) {
    await refreshData({ initial: true });
    if (state.pollingFallback) schedulePoll();
  }
}

function onVisibilityChange() {
  state.visible = !document.hidden;

  if (!state.visible) {
    stopStream();
    stopTimers();
    state.streamState = 'idle';
    state.pollingFallback = false;
    return;
  }

  if (!state.apiKey) return;

  state.streamAttempts = 0;
  state.pollingFallback = false;
  startTickTimer();
  refreshClock();
  void startLiveUpdates();
}

async function onLogin(event) {
  event.preventDefault();
  const candidate = dom.apiKeyInput.value.trim();

  if (!candidate) {
    setLoginError('Introduce una API key.');
    return;
  }

  state.apiKey = candidate;
  setLoginError('');
  hideBanner();
  dom.loginSubmit.disabled = true;
  dom.loginSubmit.textContent = 'Comprobando…';

  try {
    await refreshData({ initial: true });
    if (state.apiKey) {
      void startLiveUpdates();
    }
  } finally {
    dom.loginSubmit.disabled = false;
    dom.loginSubmit.textContent = 'Entrar';
  }
}

function onChangeKey() {
  state.apiKey = '';
  state.snapshot = null;
  state.snapshotReceivedAt = null;
  state.events = [];
  state.eventsTotal = 0;
  state.lastUpdatedAt = null;
  clearStoredKey();
  hideBanner();
  showLogin();
}

function onFiltersChanged() {
  if (state.snapshot) {
    renderFilters(state.snapshot.accounts || []);
  }

  if (!state.apiKey) return;

  if (state.pollingFallback) {
    void refreshData().then(() => {
      if (state.pollingFallback) schedulePoll();
    });
    return;
  }

  void startLiveUpdates();
}

function init() {
  dom.loginForm.addEventListener('submit', onLogin);
  dom.apiKeyInput.addEventListener('input', () => {
    if (!dom.loginError.hidden) setLoginError('');
  });
  dom.changeKey.addEventListener('click', onChangeKey);
  dom.syncNow.addEventListener('click', () => {
    void syncNow();
  });
  dom.filterAccount.addEventListener('change', () => {
    state.filters.account = dom.filterAccount.value;
    if (state.snapshot) renderFilters(state.snapshot.accounts || []);
    onFiltersChanged();
  });
  dom.filterDomain.addEventListener('change', () => {
    state.filters.domain = dom.filterDomain.value;
    onFiltersChanged();
  });
  dom.filterType.addEventListener('change', () => {
    state.filters.type = dom.filterType.value;
    onFiltersChanged();
  });
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (state.apiKey) {
    updateLastUpdatedLabel();
    void refreshData({ initial: true }).then(() => {
      if (state.apiKey) {
        void startLiveUpdates();
      }
    });
  } else {
    showLogin();
  }
}

init();
