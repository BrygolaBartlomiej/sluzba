/* Służba – raportowanie czasu w służbie (PWA) */
(() => {
  'use strict';

  const STORAGE_KEY = 'sluzba.v1';
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
      if (changed) mo.entries = next;
    }
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
      mo = state.months[key] = { type: state.settings.defaultType, studies: 0, notes: '', entries: [] };
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

  function saveDraftEntry() {
    if (draftMin <= 0) { toast('Ustaw czas służby'); return; }
    const key = monthKeyFromDay(currentDay);
    const month = getMonth(key, true);
    month.entries.push({ id: uid(), date: currentDay, min: draftMin, cat: draftCat, note: '' });
    state.settings.lastMin = draftMin;
    state.settings.lastCat = draftCat;
    save();
    render();
    toast(draftCat === 'kls' ? 'Zapisano KŁS' : 'Zapisano teren');
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
    for (const mo of Object.values(state.months)) {
      const e = (mo.entries || []).find((x) => x.id === editingId);
      if (e) {
        e.min = min;
        e.cat = editCat;
        e.note = els.entryNote.value.trim();
        break;
      }
    }
    save();
    render();
    toast('Zapisano');
  }
  function deleteEntry() {
    if (!editingId) return;
    if (!confirm('Usunąć ten wpis?')) return;
    for (const mo of Object.values(state.months)) {
      mo.entries = (mo.entries || []).filter((x) => x.id !== editingId);
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

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sluzba-${todayISO()}.json`;
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
        const data = { settings: { defaultType: 'publisher', lastMin: 60, lastCat: 'teren', ...(parsed.settings || {}) }, months: parsed.months };
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
    getMonth(monthKeyFromDay(currentDay), true).type = b.dataset.type;
    save(); render();
  };
  $('studiesPlus').onclick = () => { getMonth(monthKeyFromDay(currentDay), true).studies++; save(); render(); };
  $('studiesMinus').onclick = () => {
    const mo = getMonth(monthKeyFromDay(currentDay), true);
    mo.studies = Math.max(0, mo.studies - 1);
    save(); render();
  };
  els.monthNotes.oninput = () => { getMonth(monthKeyFromDay(currentDay), true).notes = els.monthNotes.value; save(); };

  $('shareReport').onclick = shareReport;
  $('copyReport').onclick = copyReport;

  els.historyList.onclick = (ev) => {
    const li = ev.target.closest('li[data-key]');
    if (!li) return;
    currentDay = `${li.dataset.key}-01`;
    switchView('summary');
    render();
  };

  $('openSettings').onclick = () => switchView('settings');
  els.defaultType.onchange = () => { state.settings.defaultType = els.defaultType.value; save(); };
  $('exportBtn').onclick = exportJSON;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (ev) => { if (ev.target.files[0]) importJSON(ev.target.files[0]); ev.target.value = ''; };
  $('wipeBtn').onclick = () => {
    if (!confirm('Na pewno usunąć wszystkie dane? Tej operacji nie można cofnąć.')) return;
    state = { settings: { defaultType: 'publisher', lastMin: 60, lastCat: 'teren' }, months: {} };
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

  for (const d of [els.timeDialog, els.dateDialog, els.entryDialog]) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  render();
})();
