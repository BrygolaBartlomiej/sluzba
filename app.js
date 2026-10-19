/* Służba – raportowanie czasu w służbie (PWA) */
(() => {
  'use strict';

  const STORAGE_KEY = 'sluzba.v1';
  const SYNC_KEY = 'sluzba.sync';
  const GIST_ID = 'cc0454ad89f51a930bd15d4491003c70';
  const GIST_FILE = 'sluzba-sync.json';
  const GIST_RAW = `https://gist.githubusercontent.com/BrygolaBartlomiej/${GIST_ID}/raw/${GIST_FILE}`;
  const CATS = { teren: { label: 'Teren', short: 'Teren' }, kls: { label: 'KŁS', short: 'KŁS' } };
  const TYPES = {
    publisher: { label: 'Głosiciel', short: 'Głosiciel', goal: 0 },
    aux15: { label: 'Pionier pomocniczy (15 h)', short: 'Pom. 15 h', goal: 15 },
    aux30: { label: 'Pionier pomocniczy (30 h)', short: 'Pom. 30 h', goal: 30 },
    regular: { label: 'Pionier stały', short: 'Stały', goal: 50 },
  };
  const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
    'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
  const MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
    'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  const WEEKDAYS = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];
  const RING_R = 54;
  const RING_C = 2 * Math.PI * RING_R;

  let cloudReady = false;
  let lastSyncAt = 0;
  let lastSyncError = '';
  let pushing = false;
  let syncInfo = { password: '', token: '' };
  try {
    const rawSync = localStorage.getItem(SYNC_KEY);
    if (rawSync) syncInfo = JSON.parse(rawSync);
  } catch (e) { /* ignore */ }

  let state = load();
  let currentDay = todayISO();
  let draftMin = state.settings.lastMin || 60;
  let draftCat = state.settings.lastCat || 'teren';
  let editingId = null;
  let editCat = 'teren';

  function load() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { raw = null; }
    const data = {
      settings: { defaultType: 'publisher', lastMin: 60, lastCat: 'teren', ...(raw && raw.settings) },
      months: (raw && raw.months) || {},
      removed: (raw && raw.removed) || {},
      updatedAt: (raw && raw.updatedAt) || 0,
    };
    migrate(data);
    return data;
  }
  function migrate(data) {
    let changed = false;
    for (const mo of Object.values(data.months)) {
      const next = [];
      for (const e of mo.entries || []) {
        if (e.cat === 'teren' || e.cat === 'kls') { next.push(e); continue; }
        changed = true;
        if (e.min) next.push({ id: e.id, date: e.date, min: e.min, cat: 'teren', note: e.note || '' });
        if (e.kls) {
          next.push({
            id: e.min ? uid() : e.id,
            date: e.date,
            min: e.kls,
            cat: 'kls',
            note: e.min ? '' : (e.note || ''),
          });
        }
        if (!e.min && !e.kls) next.push({ id: e.id, date: e.date, min: 0, cat: 'teren', note: e.note || '' });
      }
      data.removed = data.removed || {};
      const collapsed = collapseEntries(next.length ? next : (mo.entries || []), data.removed);
      if (JSON.stringify(collapsed) !== JSON.stringify(mo.entries)) changed = true;
      mo.entries = collapsed;
    }
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
  function collapseEntries(entries, removed) {
    const map = new Map();
    const order = [];
    for (const e of entries) {
      const cat = entryCat(e);
      const key = `${e.date}|${cat}`;
      if (!map.has(key)) {
        map.set(key, { id: e.id, date: e.date, min: e.min || 0, cat, note: e.note || '', updatedAt: e.updatedAt || 0 });
        order.push(key);
      } else {
        const cur = map.get(key);
        if (e.id && e.id !== cur.id && removed) removed[e.id] = Date.now();
        cur.min += e.min || 0;
        if (e.note) cur.note = cur.note ? `${cur.note}; ${e.note}` : e.note;
        if ((e.updatedAt || 0) > (cur.updatedAt || 0)) cur.updatedAt = e.updatedAt;
      }
    }
    return order.map((k) => map.get(k));
  }
  function save() {
    state.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (cloudReady) schedulePush();
  }
  function touchMonth(key) {
    const mo = getMonth(key, true);
    mo.updatedAt = Date.now();
    return mo;
  }
  function markRemoved(id) {
    if (!id) return;
    state.removed = state.removed || {};
    state.removed[id] = Date.now();
  }

  function saveSync() {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ password: syncInfo.password || '', token: syncInfo.token || '' }));
  }
  const syncOn = () => !!(syncInfo && syncInfo.password);

  function b64enc(u8) {
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  }
  function b64dec(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function deriveKey(password, salt) {
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function encryptPayload(password, obj) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { v: 1, s: b64enc(salt), i: b64enc(iv), c: b64enc(new Uint8Array(ct)) };
  }
  async function decryptPayload(password, blob) {
    if (!blob || !blob.c) return null;
    const key = await deriveKey(password, b64dec(blob.s));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(blob.i) }, key, b64dec(blob.c));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function mergeList(a, b, removed) {
    const m = new Map();
    for (const e of [...(b || []), ...(a || [])]) {
      if (!e || !e.id) continue;
      const rem = removed[e.id];
      if (rem && (!e.updatedAt || e.updatedAt <= rem)) continue;
      const prev = m.get(e.id);
      if (!prev || (e.updatedAt || 0) >= (prev.updatedAt || 0)) m.set(e.id, e);
    }
    return collapseEntries([...m.values()], removed);
  }
  function mergeMonth(localMo, remoteMo, removed) {
    const a = localMo || { type: 'publisher', studies: 0, notes: '', entries: [], updatedAt: 0 };
    const b = remoteMo || { type: 'publisher', studies: 0, notes: '', entries: [], updatedAt: 0 };
    const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
    return {
      type: newer.type || 'publisher',
      studies: newer.studies || 0,
      notes: newer.notes || '',
      updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
      entries: mergeList(a.entries, b.entries, removed),
    };
  }
  function mergeState(local, remote) {
    if (!remote) return local;
    if (!local) return remote;
    const removed = { ...(remote.removed || {}), ...(local.removed || {}) };
    const keys = new Set([...Object.keys(local.months || {}), ...Object.keys(remote.months || {})]);
    const months = {};
    for (const k of keys) months[k] = mergeMonth((local.months || {})[k], (remote.months || {})[k], removed);
    const settings = (local.updatedAt || 0) >= (remote.updatedAt || 0) ? local.settings : remote.settings;
    return {
      settings: settings || { defaultType: 'publisher', lastMin: 60, lastCat: 'teren' },
      months,
      removed,
      updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    };
  }
  function payloadOf(s) {
    return {
      settings: s.settings,
      months: s.months,
      removed: s.removed || {},
      updatedAt: s.updatedAt || Date.now(),
      gistToken: syncInfo.token || '',
    };
  }
  async function cloudPull() {
    if (!syncOn()) return;
    let text = '';
    try {
      const raw = await fetch(`${GIST_RAW}?t=${Date.now()}`, { cache: 'no-store' });
      if (raw.ok) text = await raw.text();
      else if (syncInfo.token) {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${syncInfo.token}` },
        });
        if (!res.ok) throw new Error('odczyt ' + res.status);
        const g = await res.json();
        text = (g.files && g.files[GIST_FILE] && g.files[GIST_FILE].content) || '';
      } else if (raw.status === 404) return;
      else throw new Error('odczyt ' + raw.status);
    } catch (e) {
      if (syncInfo.token) throw e;
      return;
    }
    text = (text || '').trim();
    if (!text || text === '{"v":1,"blob":""}') return;
    let blob;
    try { blob = JSON.parse(text); } catch (e) { return; }
    if (!blob.c) return;
    let remote;
    try {
      remote = await decryptPayload(syncInfo.password, blob);
    } catch (e) {
      throw new Error('złe hasło');
    }
    if (!remote) throw new Error('złe hasło');
    if (remote.gistToken && !syncInfo.token) {
      syncInfo.token = remote.gistToken;
      saveSync();
    }
    state = mergeState(state, remote);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    lastSyncAt = Date.now();
    lastSyncError = '';
  }
  async function cloudPush() {
    if (!syncOn() || !syncInfo.token || pushing) return;
    pushing = true;
    try {
      const enc = await encryptPayload(syncInfo.password, payloadOf(state));
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${syncInfo.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(enc) } } }),
      });
      if (res.status === 401 || res.status === 403) throw new Error('klucz GitHub nieważny');
      if (!res.ok) throw new Error('zapis ' + res.status);
      lastSyncAt = Date.now();
      lastSyncError = '';
    } finally {
      pushing = false;
    }
  }
  let pushTimer;
  function schedulePush() {
    if (!syncOn() || !syncInfo.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      cloudPush().catch((e) => { lastSyncError = e.message || 'błąd zapisu'; renderSync(); });
    }, 800);
  }
  async function startCloud() {
    if (!syncOn()) { cloudReady = true; return; }
    try {
      await cloudPull();
    } catch (e) {
      lastSyncError = e.message || 'błąd odczytu';
    }
    cloudReady = true;
    if (syncInfo.token) {
      try { await cloudPush(); } catch (e) { lastSyncError = e.message || 'błąd zapisu'; }
    }
    render();
    setInterval(() => {
      if (!syncOn() || document.hidden) return;
      cloudPull().then(() => render()).catch((e) => { lastSyncError = e.message || 'błąd odczytu'; });
    }, 25000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !syncOn()) return;
      cloudPull().then(() => render()).catch((e) => { lastSyncError = e.message || 'błąd odczytu'; });
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function monthKeyFromDay(iso) { return iso.slice(0, 7); }
  function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d };
  }
  function toISO(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
  function shiftDay(iso, delta) {
    const { y, m, d } = parseISO(iso);
    const dt = new Date(y, m - 1, d + delta);
    return toISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function shiftMonthDay(iso, delta) {
    const { y, m, d } = parseISO(iso);
    const last = new Date(y, m - 1 + delta + 1, 0).getDate();
    const dt = new Date(y, m - 1 + delta, Math.min(d, last));
    return toISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function monthLabel(key) {
    const { y, m } = parseISO(key + '-01');
    return `${MONTHS[m - 1]} ${y}`;
  }
  function dayLabel(iso) {
    const { y, m, d } = parseISO(iso);
    return `${d} ${MONTHS_GEN[m - 1]} ${y}`;
  }
  function getMonth(key, create = false) {
    let mo = state.months[key];
    if (!mo && create) {
      mo = state.months[key] = { type: state.settings.defaultType, studies: 0, notes: '', entries: [], updatedAt: Date.now() };
    }
    return mo || { type: state.settings.defaultType, studies: 0, notes: '', entries: [] };
  }
  function entryCat(e) { return e.cat === 'kls' ? 'kls' : 'teren'; }
  function totals(month) {
    let min = 0, kls = 0;
    for (const e of month.entries || []) {
      if (entryCat(e) === 'kls') kls += e.min || 0;
      else min += e.min || 0;
    }
    return { min, kls };
  }
  function dayTotals(iso) {
    const month = getMonth(monthKeyFromDay(iso));
    let min = 0, kls = 0;
    const list = [];
    for (const e of month.entries || []) {
      if (e.date !== iso) continue;
      list.push(e);
      if (entryCat(e) === 'kls') kls += e.min || 0;
      else min += e.min || 0;
    }
    return { min, kls, list };
  }
  function fmt(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return `${h}:${pad(m)}`;
  }
  function fmtH(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  function fmtPill(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!m) return `${h}<small> h</small>`;
    return `${h}:${pad(m)}<small> h</small>`;
  }
  function fmtDec(min) {
    if (!min) return '';
    const h = min / 60;
    const rounded = Math.round(h * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}h` : `${rounded}h`;
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function setTimeInputs(hEl, mEl, min) {
    hEl.value = Math.floor(min / 60);
    mEl.value = String(Math.round((min % 60) / 15) * 15 % 60);
  }
  function getTimeInputs(hEl, mEl) {
    return Math.max(0, (parseInt(hEl.value, 10) || 0) * 60 + (parseInt(mEl.value, 10) || 0));
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    dayTitle: $('dayTitle'), timePill: $('timePill'), cats: $('cats'),
    dayEntries: $('dayEntries'), ringCard: $('ringCard'),
    todayCard: $('todayCard'), calMonthTitle: $('calMonthTitle'), calSum: $('calSum'),
    calGrid: $('calGrid'), monthCard: $('monthCard'),
    typeSegments: $('typeSegments'), studiesValue: $('studiesValue'), monthNotes: $('monthNotes'),
    historyList: $('historyList'), serviceYear: $('serviceYear'), defaultType: $('defaultType'),
    timeDialog: $('timeDialog'), dateDialog: $('dateDialog'), datePicker: $('datePicker'),
    pickHours: $('pickHours'), pickMinutes: $('pickMinutes'),
    entryDialog: $('entryDialog'), editHours: $('editHours'), editMinutes: $('editMinutes'),
    editCats: $('editCats'), entryNote: $('entryNote'), editMeta: $('editMeta'),
    toast: $('toast'),
  };

  function render() {
    renderReport();
    renderSummary();
    renderHistory();
    els.defaultType.value = state.settings.defaultType;
    renderSync();
  }
  function renderSync() {
    const hint = $('syncHint');
    const actions = $('syncActions');
    if (!hint || !actions) return;
    const connected = syncOn();
    hint.textContent = connected
      ? 'To samo hasło wpisz na telefonie i komputerze – wpisy same się zsynchronizują.'
      : 'Włącz, żeby mieć te same godziny na telefonie i komputerze.';
    if (!connected) {
      actions.innerHTML = '<button type="button" class="btn block" id="syncOnBtn">Włącz synchronizację</button>';
      $('syncOnBtn').onclick = openSyncDlg;
      return;
    }
    const status = lastSyncError
      ? `Problem: ${lastSyncError}`
      : lastSyncAt
        ? `Połączono · ${new Date(lastSyncAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`
        : 'Połączono · czekam na sieć';
    actions.innerHTML = `
      <button type="button" class="btn block" id="syncNowBtn">${escapeHtml(status)}</button>
      <button type="button" class="btn block danger" id="syncOffBtn">Wyłącz synchronizację na tym urządzeniu</button>`;
    $('syncNowBtn').onclick = syncNow;
    $('syncOffBtn').onclick = syncOff;
  }

  function renderReport() {
    els.dayTitle.textContent = dayLabel(currentDay);
    els.timePill.innerHTML = fmtPill(draftMin);
    els.cats.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.cat === draftCat;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });

    const { list } = dayTotals(currentDay);
    if (!list.length) {
      els.dayEntries.innerHTML = '';
    } else {
      els.dayEntries.innerHTML = list.map((e) => `
        <li data-id="${e.id}">
          <span class="badge ${entryCat(e)}">${CATS[entryCat(e)].short}</span>
          <span class="t">${fmtH(e.min)}</span>
          ${e.note ? `<span class="n">${escapeHtml(e.note)}</span>` : ''}
        </li>`).join('');
    }
    els.ringCard.innerHTML = ringHtml(monthKeyFromDay(currentDay));
    $('jumpToday').classList.toggle('hidden', currentDay === todayISO());
  }

  function ringHtml(key) {
    const month = getMonth(key);
    const t = totals(month);
    const type = TYPES[month.type] || TYPES.publisher;
    if (!type.goal) {
      const ok = t.min > 0;
      return `
        <div class="ring-head"><span class="l">Ten miesiąc</span><span class="r">${fmt(t.min)}</span></div>
        <div class="ring-wrap">
          ${ringSvg(ok ? 100 : 0, ok)}
          <div class="ring-center">
            <div class="pct">${fmt(t.min)}</div>
            <div class="left">${ok ? 'Uczestniczyłem: tak' : 'Brak godzin terenu'}</div>
          </div>
        </div>`;
    }
    const goalMin = type.goal * 60;
    const pct = Math.min(100, Math.round((t.min / goalMin) * 100));
    const left = Math.max(0, goalMin - t.min);
    const done = left === 0;
    return `
      <div class="ring-head">
        <span class="l">Cel miesięczny</span>
        <span class="r">${fmtDec(t.min) || '0h'} / ${type.goal}h</span>
      </div>
      <div class="ring-wrap">
        ${ringSvg(pct, done)}
        <div class="ring-center">
          <div class="pct">${pct}%</div>
          <div class="left">${done ? 'Cel osiągnięty' : `Pozostało: ${fmtDec(left)}`}</div>
        </div>
      </div>`;
  }
  function ringSvg(pct, done) {
    const off = RING_C * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return `<svg viewBox="0 0 140 140" aria-hidden="true">
      <circle class="bg" cx="70" cy="70" r="${RING_R}"></circle>
      <circle class="fg${done ? ' done' : ''}" cx="70" cy="70" r="${RING_R}"
        stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"></circle>
    </svg>`;
  }

  function renderSummary() {
    const today = todayISO();
    const td = dayTotals(today);
    els.todayCard.innerHTML = `
      <div class="l">Godziny</div>
      <div class="v">${fmtDec(td.min) || '0h'}</div>
      ${td.kls ? `<div class="l" style="margin-top:8px">KŁS ${fmtDec(td.kls)}</div>` : ''}`;

    const key = monthKeyFromDay(currentDay);
    const month = getMonth(key);
    const t = totals(month);
    const type = TYPES[month.type] || TYPES.publisher;
    els.calMonthTitle.textContent = monthLabel(key);
    els.calSum.textContent = `Suma: ${fmtDec(t.min) || '0h'}`;
    els.calGrid.innerHTML = calendarHtml(key);

    els.typeSegments.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.type === month.type;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    els.studiesValue.textContent = month.studies;
    if (document.activeElement !== els.monthNotes) els.monthNotes.value = month.notes || '';

    const goal = type.goal ? `${fmtDec(t.min) || '0h'} / ${type.goal}h` : fmtDec(t.min) || '0h';
    els.monthCard.innerHTML = `
      <div class="month-title-row">
        <div class="m">${monthLabel(key)}</div>
        <span class="goal-pill">${goal}</span>
      </div>
      <div class="month-break">
        <div><div class="l">Teren</div><div class="v">${fmtDec(t.min) || '0h'}</div></div>
        <div><div class="l">KŁS</div><div class="v">${fmtDec(t.kls) || '0h'}</div></div>
        <div><div class="l">Studia</div><div class="v">${month.studies}</div></div>
      </div>`;
  }

  function calendarHtml(key) {
    const { y, m } = parseISO(key + '-01');
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    let start = first.getDay() - 1; // Monday = 0
    if (start < 0) start = 6;
    const byDay = {};
    for (const e of getMonth(key).entries || []) {
      const d = parseISO(e.date).d;
      if (!byDay[d]) byDay[d] = { min: 0, kls: 0 };
      if (entryCat(e) === 'kls') byDay[d].kls += e.min || 0;
      else byDay[d].min += e.min || 0;
    }
    const today = todayISO();
    const cells = [];
    for (let i = 0; i < start; i++) cells.push('<div class="cal-cell empty"></div>');
    for (let d = 1; d <= days; d++) {
      const iso = toISO(y, m, d);
      const rec = byDay[d];
      const cls = ['cal-cell'];
      if (rec && rec.min) cls.push('has');
      if (rec && rec.kls) cls.push('has-kls');
      if (iso === today) cls.push('today');
      if (iso === currentDay) cls.push('sel');
      const hours = rec && rec.min ? fmtDec(rec.min) : (rec && rec.kls ? 'KŁS' : '');
      cells.push(`<button type="button" class="${cls.join(' ')}" data-day="${iso}">
        <span class="n">${d}</span>${hours ? `<span class="h">${hours}</span>` : ''}
      </button>`);
    }
    return cells.join('');
  }

  function renderHistory() {
    const keys = Object.keys(state.months).filter((k) => {
      const mo = state.months[k];
      return (mo.entries && mo.entries.length) || mo.studies || mo.notes || mo.type !== 'publisher';
    }).sort().reverse();

    const { y, m } = parseISO(currentDay);
    const syStart = m >= 9 ? y : y - 1;
    let syMin = 0, syKls = 0, syMonths = 0;
    for (let i = 0; i < 12; i++) {
      const dt = new Date(syStart, 8 + i, 1);
      const mk = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
      const mo = state.months[mk];
      if (!mo) continue;
      const t = totals(mo);
      syMin += t.min; syKls += t.kls;
      if (mo.entries && mo.entries.length) syMonths++;
    }
    els.serviceYear.innerHTML = `
      <div class="field-label">Rok służbowy ${syStart}/${syStart + 1}</div>
      <div class="stats">
        <div class="stat"><div class="v">${fmt(syMin)}</div><div class="l">Teren</div></div>
        <div class="stat"><div class="v">${fmt(syKls)}</div><div class="l">KŁS</div></div>
        <div class="stat"><div class="v">${syMonths}</div><div class="l">Miesięcy</div></div>
      </div>`;

    if (!keys.length) {
      els.historyList.innerHTML = '<li class="empty" style="display:block">Brak historii.</li>';
      return;
    }
    els.historyList.innerHTML = keys.map((k) => {
      const mo = state.months[k];
      const t = totals(mo);
      const type = TYPES[mo.type] || TYPES.publisher;
      const goalOk = type.goal && t.min >= type.goal * 60;
      return `<li data-key="${k}">
        <div>
          <div class="m">${monthLabel(k)}</div>
          <div class="sub"><span class="badge type">${type.short}</span> · ${mo.studies} st.${t.kls ? ` · KŁS ${fmt(t.kls)}` : ''}</div>
        </div>
        <div class="h" style="color:${goalOk ? 'var(--ok)' : 'inherit'}">${fmt(t.min)}</div>
      </li>`;
    }).join('');
  }

  function reportText() {
    const key = monthKeyFromDay(currentDay);
    const month = getMonth(key);
    const t = totals(month);
    const type = TYPES[month.type] || TYPES.publisher;
    const lines = [`*Sprawozdanie ze służby: ${monthLabel(key)}*`];
    if (type.goal) lines.push(type.label);
    else lines.push(`Uczestniczyłem w służbie: *${t.min ? 'Tak' : 'Nie'}*`);
    lines.push(`*Teren:* ${fmt(t.min)}`);
    lines.push(`*KŁS:* ${fmt(t.kls)}`);
    lines.push(`*Studia biblijne:* ${month.studies}`);
    if (month.notes) lines.push(`Uwagi: ${month.notes}`);
    return lines.join('\n');
  }
  async function shareReport() {
    const text = reportText();
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    copyReport();
  }
  async function copyReport() {
    const text = reportText();
    try {
      await navigator.clipboard.writeText(text);
      toast('Skopiowano sprawozdanie');
    } catch {
      prompt('Skopiuj sprawozdanie:', text);
    }
  }

  let saving = false;
  function saveDraftEntry() {
    if (saving) return;
    if (draftMin <= 0) { toast('Ustaw czas służby'); return; }
    saving = true;
    const cat = draftCat;
    const add = draftMin;
    const month = getMonth(monthKeyFromDay(currentDay), true);
    month.updatedAt = Date.now();
    const existing = month.entries.find((e) => e.date === currentDay && entryCat(e) === cat);
    if (existing) {
      existing.min += add;
      existing.updatedAt = Date.now();
    } else {
      month.entries.push({ id: uid(), date: currentDay, min: add, cat, note: '', updatedAt: Date.now() });
    }
    draftCat = 'teren';
    state.settings.lastMin = add;
    state.settings.lastCat = 'teren';
    save();
    render();
    toast(existing
      ? `${CATS[cat].short}: ${fmtH(existing.min)}`
      : (cat === 'kls' ? 'Zapisano KŁS' : 'Zapisano teren'));
    setTimeout(() => { saving = false; }, 280);
  }

  function openEdit(id) {
    const key = monthKeyFromDay(currentDay);
    const e = getMonth(key).entries.find((x) => x.id === id);
    if (!e) return;
    editingId = id;
    editCat = entryCat(e);
    els.editMeta.textContent = `${dayLabel(e.date)} · ${CATS[editCat].label}`;
    setTimeInputs(els.editHours, els.editMinutes, e.min);
    els.entryNote.value = e.note || '';
    els.editCats.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.cat === editCat));
    els.entryDialog.showModal();
  }
  function saveEdit() {
    if (!editingId) return;
    const min = getTimeInputs(els.editHours, els.editMinutes);
    if (min <= 0) { toast('Ustaw czas'); return; }
    const note = els.entryNote.value.trim();
    for (const mo of Object.values(state.months)) {
      const e = (mo.entries || []).find((x) => x.id === editingId);
      if (!e) continue;
      e.min = min;
      e.cat = editCat;
      e.note = note;
      e.updatedAt = Date.now();
      mo.updatedAt = Date.now();
      const other = (mo.entries || []).find((x) => x.id !== e.id && x.date === e.date && entryCat(x) === editCat);
      if (other) {
        other.min += e.min;
        if (e.note) other.note = other.note ? `${other.note}; ${e.note}` : e.note;
        other.updatedAt = Date.now();
        markRemoved(e.id);
        mo.entries = mo.entries.filter((x) => x.id !== e.id);
      }
      break;
    }
    save();
    render();
    toast('Zapisano');
  }
  function deleteEntry() {
    if (!editingId) return;
    if (!confirm('Usunąć ten wpis?')) return;
    markRemoved(editingId);
    for (const mo of Object.values(state.months)) {
      mo.entries = (mo.entries || []).filter((x) => x.id !== editingId);
      mo.updatedAt = Date.now();
    }
    save();
    els.entryDialog.close();
    render();
    toast('Usunięto');
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  async function exportJSON() {
    const text = JSON.stringify(state, null, 2);
    const filename = `sluzba-${todayISO()}.json`;
    const file = new File([text], filename, { type: 'application/json' });
    if (navigator.share) {
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Kopia Służba' });
          return;
        }
        await navigator.share({ text, title: filename });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Skopiowano kopię zapasową');
      return;
    } catch { /* fallback poniżej */ }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed.months !== 'object') throw new Error('zły format');
        if (!confirm('Zastąpić obecne dane danymi z pliku?')) return;
        const data = {
          settings: { defaultType: 'publisher', lastMin: 60, lastCat: 'teren', ...(parsed.settings || {}) },
          months: parsed.months,
          removed: parsed.removed || {},
          updatedAt: parsed.updatedAt || Date.now(),
        };
        migrate(data);
        state = data;
        save(); render(); toast('Zaimportowano');
      } catch { alert('Nie udało się odczytać pliku.'); }
    };
    reader.readAsText(file);
  }

  $('prevDay').onclick = () => { currentDay = shiftDay(currentDay, -1); render(); };
  $('nextDay').onclick = () => { currentDay = shiftDay(currentDay, 1); render(); };
  els.dayTitle.onclick = () => { els.datePicker.value = currentDay; els.dateDialog.showModal(); };
  els.dateDialog.querySelector('form').onsubmit = () => {
    if (els.datePicker.value) currentDay = els.datePicker.value;
    render();
  };
  $('todayBtn').onclick = () => { currentDay = todayISO(); els.dateDialog.close(); render(); };
  $('jumpToday').onclick = () => { currentDay = todayISO(); render(); };

  els.timePill.onclick = () => {
    setTimeInputs(els.pickHours, els.pickMinutes, draftMin);
    els.timeDialog.showModal();
  };
  $('timeForm').onsubmit = () => {
    draftMin = getTimeInputs(els.pickHours, els.pickMinutes);
    render();
  };
  $('cancelTime').onclick = () => els.timeDialog.close();
  $('timeQuick').onclick = (ev) => {
    const b = ev.target.closest('button[data-add]');
    if (!b) return;
    draftMin = Math.max(0, Math.min(24 * 60, draftMin + Number(b.dataset.add)));
    render();
  };
  els.cats.onclick = (ev) => {
    const b = ev.target.closest('button[data-cat]');
    if (!b) return;
    draftCat = b.dataset.cat;
    render();
  };
  $('saveReport').onclick = saveDraftEntry;
  els.dayEntries.onclick = (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (li) openEdit(li.dataset.id);
  };

  $('prevCalMonth').onclick = () => { currentDay = shiftMonthDay(currentDay, -1); render(); };
  $('nextCalMonth').onclick = () => { currentDay = shiftMonthDay(currentDay, 1); render(); };
  els.calGrid.onclick = (ev) => {
    const b = ev.target.closest('button[data-day]');
    if (!b) return;
    currentDay = b.dataset.day;
    switchView('report');
    render();
  };

  els.typeSegments.onclick = (ev) => {
    const b = ev.target.closest('button[data-type]');
    if (!b) return;
    touchMonth(monthKeyFromDay(currentDay)).type = b.dataset.type;
    save(); render();
  };
  $('studiesPlus').onclick = () => { touchMonth(monthKeyFromDay(currentDay)).studies++; save(); render(); };
  $('studiesMinus').onclick = () => {
    const mo = touchMonth(monthKeyFromDay(currentDay));
    mo.studies = Math.max(0, mo.studies - 1);
    save(); render();
  };
  els.monthNotes.oninput = () => { touchMonth(monthKeyFromDay(currentDay)).notes = els.monthNotes.value; save(); };

  $('shareReport').onclick = shareReport;
  $('copyReport').onclick = copyReport;

  els.historyList.onclick = (ev) => {
    const li = ev.target.closest('li[data-key]');
    if (!li) return;
    currentDay = `${li.dataset.key}-01`;
    switchView('summary');
    render();
  };

  let syncNeedToken = false;
  function openSyncDlg() {
    const form = $('syncForm');
    form.reset();
    syncNeedToken = false;
    $('syncTokenWrap').hidden = true;
    $('syncPassword2Wrap').hidden = false;
    $('syncOk').textContent = 'Dalej';
    $('syncDialog').showModal();
    setTimeout(() => $('syncPassword').focus(), 50);
  }
  async function syncNow() {
    toast('Odświeżam…');
    try {
      await cloudPull();
      await cloudPush();
      render();
      toast('Zsynchronizowano');
    } catch (e) {
      lastSyncError = e.message || 'błąd';
      render();
      toast(lastSyncError);
    }
  }
  function syncOff() {
    if (!confirm('Wyłączyć synchronizację na TYM urządzeniu? Dane zostaną tu lokalnie. Inne urządzenia dalej będą zsynchronizowane.')) return;
    syncInfo = { password: '', token: '' };
    saveSync();
    render();
    toast('Synchronizacja wyłączona tutaj');
  }
  $('syncForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = $('syncForm');
    const p = form.password.value;
    if (p.length < 6) { toast('Hasło min. 6 znaków'); return; }
    if (!syncNeedToken && p !== form.password2.value) { toast('Hasła nie są takie same'); return; }
    const okBtn = $('syncOk');
    okBtn.disabled = true;
    try {
      if (!syncNeedToken) {
        syncInfo = { password: p, token: syncInfo.token || '' };
        try {
          await cloudPull();
          if (syncInfo.token) {
            saveSync();
            cloudReady = true;
            $('syncDialog').close();
            render();
            toast('Połączono – dane jak na innych urządzeniach');
            cloudPush().catch(() => {});
            return;
          }
        } catch (e) {
          if (/złe hasło/.test(e.message || '')) { toast('Złe hasło'); return; }
        }
        syncNeedToken = true;
        $('syncTokenWrap').hidden = false;
        $('syncPassword2Wrap').hidden = true;
        okBtn.textContent = 'Połącz';
        toast('Jeszcze jeden krok, tylko na tym urządzeniu');
        return;
      }
      const token = form.token.value.trim();
      if (!/^(ghp_|gho_|github_pat_)/.test(token)) {
        toast('Wklej klucz z GitHuba (zaczyna się od ghp_)');
        return;
      }
      syncInfo = { password: p, token };
      saveSync();
      cloudReady = true;
      await cloudPull();
      await cloudPush();
      $('syncDialog').close();
      render();
      toast('Synchronizacja włączona');
    } catch (e) {
      toast(e.message || 'Nie udało się połączyć');
    } finally {
      okBtn.disabled = false;
    }
  };
  $('cancelSync').onclick = () => $('syncDialog').close();
  $('openSettings').onclick = () => switchView('settings');
  els.defaultType.onchange = () => { state.settings.defaultType = els.defaultType.value; save(); };
  $('exportBtn').onclick = exportJSON;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (ev) => { if (ev.target.files[0]) importJSON(ev.target.files[0]); ev.target.value = ''; };
  $('wipeBtn').onclick = () => {
    if (!confirm('Na pewno usunąć wszystkie dane? Tej operacji nie można cofnąć.')) return;
    state = { settings: { defaultType: 'publisher', lastMin: 60, lastCat: 'teren' }, months: {}, removed: {} };
    draftMin = 60; draftCat = 'teren';
    save(); render(); toast('Usunięto dane');
  };

  els.editCats.onclick = (ev) => {
    const b = ev.target.closest('button[data-cat]');
    if (!b) return;
    editCat = b.dataset.cat;
    els.editCats.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.cat === editCat));
  };
  $('entryForm').onsubmit = (ev) => { ev.preventDefault(); saveEdit(); els.entryDialog.close(); };
  $('cancelEntry').onclick = () => els.entryDialog.close();
  $('deleteEntry').onclick = deleteEntry;

  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    window.scrollTo(0, 0);
  }
  document.querySelector('.tabbar').onclick = (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (b) switchView(b.dataset.view);
  };

  for (const d of [els.timeDialog, els.dateDialog, els.entryDialog, $('syncDialog')]) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  render();
  startCloud();
})();
