/* Służba – raportowanie czasu w służbie (PWA) */
(() => {
  'use strict';

  const STORAGE_KEY = 'sluzba.v1';

  const TYPES = {
    publisher: { label: 'Głosiciel', short: 'Głosiciel', goal: 0 },
    aux15: { label: 'Pionier pomocniczy (15 h)', short: 'Pom. 15 h', goal: 15 },
    aux30: { label: 'Pionier pomocniczy (30 h)', short: 'Pom. 30 h', goal: 30 },
    regular: { label: 'Pionier stały', short: 'Stały', goal: 50 },
  };

  const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
    'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
  const WEEKDAYS = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];

  // ---------- Stan ----------
  let state = load();
  let currentKey = monthKey(new Date());
  let editingId = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { settings: { defaultType: 'publisher', ...(parsed.settings || {}) }, months: parsed.months || {} };
      }
    } catch (e) { console.warn('Błąd odczytu danych', e); }
    return { settings: { defaultType: 'publisher' }, months: {} };
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function monthKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function parseKey(key) {
    const [y, m] = key.split('-').map(Number);
    return { y, m };
  }
  function shiftMonth(key, delta) {
    const { y, m } = parseKey(key);
    return monthKey(new Date(y, m - 1 + delta, 1));
  }
  function monthLabel(key) {
    const { y, m } = parseKey(key);
    return `${MONTHS[m - 1]} ${y}`;
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function getMonth(key, create = false) {
    let m = state.months[key];
    if (!m && create) {
      m = state.months[key] = { type: state.settings.defaultType, studies: 0, notes: '', entries: [] };
    }
    return m || { type: state.settings.defaultType, studies: 0, notes: '', entries: [] };
  }

  function totals(month) {
    let min = 0, kls = 0;
    for (const e of month.entries) { min += e.min || 0; kls += e.kls || 0; }
    return { min, kls };
  }
  function fmt(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  function fmtH(min) {
    // np. "31 h 15 min"
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    monthTitle: $('monthTitle'), summary: $('summary'), entries: $('entries'),
    typeSegments: $('typeSegments'), studiesValue: $('studiesValue'), monthNotes: $('monthNotes'),
    entryDialog: $('entryDialog'), entryForm: $('entryForm'), entryDialogTitle: $('entryDialogTitle'),
    entryDate: $('entryDate'), entryHours: $('entryHours'), entryMinutes: $('entryMinutes'),
    klsHours: $('klsHours'), klsMinutes: $('klsMinutes'), entryNote: $('entryNote'),
    deleteEntry: $('deleteEntry'), monthDialog: $('monthDialog'), monthPicker: $('monthPicker'),
    historyList: $('historyList'), serviceYear: $('serviceYear'), defaultType: $('defaultType'),
    toast: $('toast'),
  };

  // ---------- Render ----------
  function render() {
    renderMonth();
    renderHistory();
    els.defaultType.value = state.settings.defaultType;
  }

  function renderMonth() {
    const month = getMonth(currentKey);
    const t = totals(month);
    const type = TYPES[month.type] || TYPES.publisher;

    els.monthTitle.textContent = monthLabel(currentKey);
    els.typeSegments.querySelectorAll('button').forEach((b) => {
      const active = b.dataset.type === month.type;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    els.studiesValue.textContent = month.studies;
    if (document.activeElement !== els.monthNotes) els.monthNotes.value = month.notes || '';

    // Podsumowanie
    let html = '';
    if (type.goal) {
      const goalMin = type.goal * 60;
      const pct = Math.min(100, Math.round((t.min / goalMin) * 100));
      const left = Math.max(0, goalMin - t.min);
      const { y, m } = parseKey(currentKey);
      const now = new Date();
      const isCurrent = monthKey(now) === currentKey;
      const daysInMonth = new Date(y, m, 0).getDate();
      const daysLeft = isCurrent ? daysInMonth - now.getDate() + 1 : 0;
      const perDay = left && daysLeft ? Math.ceil(left / daysLeft) : 0;
      html += `<div class="big">${fmt(t.min)} <small>/ ${type.goal} h</small></div>`;
      html += `<div class="goal">${left === 0
        ? 'Cel osiągnięty 🎉'
        : `Brakuje ${fmtH(left)}${perDay ? ` · ok. ${fmtH(perDay)} dziennie przez ${daysLeft} dni` : ''}`}</div>`;
      html += `<div class="progress"><div class="${left === 0 ? 'done' : ''}" style="width:${pct}%"></div></div>`;
    } else {
      const participated = month.entries.length > 0;
      html += `<div class="big">${fmt(t.min)} <small>h</small></div>`;
      html += `<div class="participated">Uczestniczyłem w służbie: <span class="${participated ? 'yes' : 'no'}">${participated ? 'Tak' : 'Nie'}</span></div>`;
      html += `<div class="progress"><div style="width:0"></div></div>`;
    }
    html += `<div class="stats">
      <div class="stat"><div class="v">${fmt(t.min)}</div><div class="l">Służba</div></div>
      <div class="stat"><div class="v">${fmt(t.kls)}</div><div class="l">KŁS</div></div>
      <div class="stat"><div class="v">${month.studies}</div><div class="l">Studia</div></div>
    </div>`;
    els.summary.innerHTML = html;

    // Wpisy
    const sorted = [...month.entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (!sorted.length) {
      els.entries.innerHTML = '<li class="empty" style="display:block">Brak wpisów. Dodaj pierwszy.</li>';
    } else {
      els.entries.innerHTML = sorted.map((e) => {
        const d = new Date(e.date + 'T12:00:00');
        return `<li data-id="${e.id}">
          <div class="entry-date"><div class="d">${d.getDate()}</div><div class="w">${WEEKDAYS[d.getDay()]}</div></div>
          <div class="entry-body">
            <div class="entry-time">${e.min ? fmtH(e.min) : '—'}</div>
            ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ''}
          </div>
          ${e.kls ? `<span class="badge kls">KŁS ${fmtH(e.kls)}</span>` : ''}
        </li>`;
      }).join('');
    }
  }

  function renderHistory() {
    const keys = Object.keys(state.months).filter((k) => {
      const m = state.months[k];
      return m.entries.length || m.studies || m.notes || m.type !== 'publisher';
    }).sort().reverse();

    // Rok służbowy (wrzesień–sierpień)
    const { y, m } = parseKey(currentKey);
    const syStart = m >= 9 ? y : y - 1;
    let syMin = 0, syKls = 0, syMonths = 0;
    for (let i = 0; i < 12; i++) {
      const k = monthKey(new Date(syStart, 8 + i, 1));
      const mo = state.months[k];
      if (!mo) continue;
      const t = totals(mo);
      syMin += t.min; syKls += t.kls;
      if (mo.entries.length) syMonths++;
    }
    els.serviceYear.innerHTML = `
      <div class="field-label">Rok służbowy ${syStart}/${syStart + 1}</div>
      <div class="stats">
        <div class="stat"><div class="v">${fmt(syMin)}</div><div class="l">Służba</div></div>
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Raport (tekst) ----------
  function reportText() {
    const month = getMonth(currentKey);
    const t = totals(month);
    const type = TYPES[month.type] || TYPES.publisher;
    const lines = [`Raport ze służby – ${monthLabel(currentKey)}`];
    if (type.goal) {
      lines.push(type.label);
      lines.push(`Godziny: ${fmt(t.min)}`);
    } else {
      lines.push(`Uczestniczyłem w służbie: ${month.entries.length ? 'Tak' : 'Nie'}`);
      if (t.min) lines.push(`Godziny: ${fmt(t.min)}`);
    }
    lines.push(`Studia biblijne: ${month.studies}`);
    if (t.kls) lines.push(`KŁS: ${fmt(t.kls)}`);
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
      toast('Skopiowano raport');
    } catch {
      prompt('Skopiuj raport:', text);
    }
  }

  // ---------- Dialog wpisu ----------
  function openEntry(id = null) {
    editingId = id;
    const month = getMonth(currentKey);
    const e = id ? month.entries.find((x) => x.id === id) : null;
    els.entryDialogTitle.textContent = e ? 'Edytuj wpis' : 'Nowy wpis';
    els.deleteEntry.classList.toggle('hidden', !e);

    let date = todayISO();
    if (e) date = e.date;
    else if (!date.startsWith(currentKey)) date = `${currentKey}-01`;
    els.entryDate.value = date;
    els.entryDate.min = `${currentKey}-01`;
    const { y, m } = parseKey(currentKey);
    els.entryDate.max = `${currentKey}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

    setTime(els.entryHours, els.entryMinutes, e ? e.min : 0);
    setTime(els.klsHours, els.klsMinutes, e ? e.kls : 0);
    els.entryNote.value = e ? e.note || '' : '';
    els.entryDialog.showModal();
  }
  function setTime(hEl, mEl, min) {
    hEl.value = Math.floor(min / 60) || '';
    mEl.value = String(Math.round((min % 60) / 15) * 15 % 60);
  }
  function getTime(hEl, mEl) {
    return (parseInt(hEl.value, 10) || 0) * 60 + (parseInt(mEl.value, 10) || 0);
  }
  function saveEntry() {
    const month = getMonth(currentKey, true);
    const data = {
      date: els.entryDate.value,
      min: getTime(els.entryHours, els.entryMinutes),
      kls: getTime(els.klsHours, els.klsMinutes),
      note: els.entryNote.value.trim(),
    };
    if (!data.date) return;
    if (!data.date.startsWith(currentKey)) {
      // wpis w innym miesiącu – przenieś
      currentKey = data.date.slice(0, 7);
      getMonth(currentKey, true);
    }
    if (editingId) {
      // usuń ze starego miesiąca (gdyby zmieniono datę)
      for (const k of Object.keys(state.months)) {
        state.months[k].entries = state.months[k].entries.filter((x) => x.id !== editingId);
      }
      state.months[currentKey].entries.push({ id: editingId, ...data });
    } else {
      state.months[currentKey].entries.push({ id: uid(), ...data });
    }
    save();
    render();
    toast(editingId ? 'Zapisano' : 'Dodano wpis');
  }
  function deleteEntry() {
    if (!editingId) return;
    if (!confirm('Usunąć ten wpis?')) return;
    const month = getMonth(currentKey, true);
    month.entries = month.entries.filter((x) => x.id !== editingId);
    save();
    els.entryDialog.close();
    render();
    toast('Usunięto');
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  // ---------- Eksport / import ----------
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
        state = { settings: { defaultType: 'publisher', ...(parsed.settings || {}) }, months: parsed.months };
        save(); render(); toast('Zaimportowano');
      } catch { alert('Nie udało się odczytać pliku.'); }
    };
    reader.readAsText(file);
  }

  // ---------- Zdarzenia ----------
  $('prevMonth').onclick = () => { currentKey = shiftMonth(currentKey, -1); render(); };
  $('nextMonth').onclick = () => { currentKey = shiftMonth(currentKey, 1); render(); };
  els.monthTitle.onclick = () => { els.monthPicker.value = currentKey; els.monthDialog.showModal(); };
  els.monthDialog.querySelector('form').onsubmit = () => { if (els.monthPicker.value) { currentKey = els.monthPicker.value; render(); } };
  $('todayBtn').onclick = () => { currentKey = monthKey(new Date()); els.monthDialog.close(); render(); };

  els.typeSegments.onclick = (ev) => {
    const b = ev.target.closest('button[data-type]');
    if (!b) return;
    getMonth(currentKey, true).type = b.dataset.type;
    save(); render();
  };
  $('studiesPlus').onclick = () => { const m = getMonth(currentKey, true); m.studies++; save(); render(); };
  $('studiesMinus').onclick = () => { const m = getMonth(currentKey, true); m.studies = Math.max(0, m.studies - 1); save(); render(); };
  els.monthNotes.oninput = () => { getMonth(currentKey, true).notes = els.monthNotes.value; save(); };
  els.monthNotes.onblur = () => renderHistory();

  $('addEntry').onclick = () => openEntry();
  els.entries.onclick = (ev) => { const li = ev.target.closest('li[data-id]'); if (li) openEntry(li.dataset.id); };
  els.entryForm.onsubmit = (ev) => { ev.preventDefault(); saveEntry(); els.entryDialog.close(); };
  $('cancelEntry').onclick = () => els.entryDialog.close();
  els.deleteEntry.onclick = deleteEntry;
  els.entryDialog.querySelector('.quick').onclick = (ev) => {
    const b = ev.target.closest('button[data-add]');
    if (!b) return;
    setTime(els.entryHours, els.entryMinutes, getTime(els.entryHours, els.entryMinutes) + Number(b.dataset.add));
  };

  $('shareReport').onclick = shareReport;
  $('copyReport').onclick = copyReport;

  els.historyList.onclick = (ev) => {
    const li = ev.target.closest('li[data-key]');
    if (!li) return;
    currentKey = li.dataset.key;
    switchView('month');
    render();
  };

  els.defaultType.onchange = () => { state.settings.defaultType = els.defaultType.value; save(); };
  $('exportBtn').onclick = exportJSON;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (ev) => { if (ev.target.files[0]) importJSON(ev.target.files[0]); ev.target.value = ''; };
  $('wipeBtn').onclick = () => {
    if (!confirm('Na pewno usunąć wszystkie dane? Tej operacji nie można cofnąć.')) return;
    state = { settings: { defaultType: 'publisher' }, months: {} };
    save(); render(); toast('Usunięto dane');
  };

  // Zakładki
  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    window.scrollTo(0, 0);
  }
  document.querySelector('.tabbar').onclick = (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (b) switchView(b.dataset.view);
  };

  // Zamykanie dialogów kliknięciem w tło
  for (const d of [els.entryDialog, els.monthDialog]) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }

  // Service worker
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  render();
})();
