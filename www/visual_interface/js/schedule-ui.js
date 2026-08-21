// schedule-ui.js
// Popup расписания: события (список/добавление/редактирование/удаление) + исключения (даты-выходные).
// Данные — из интеграции event_schedule через уже существующий ARVID WebSocket:
//   binary_sensor.schedule_*                 — по одному на событие (атрибуты + excluded_today)
//   binary_sensor.event_schedule_exceptions  — даты-исключения (список + «сегодня отключено»)
// Сервисы: event_schedule.add_event / update_event / delete_event / set_excluded_dates.
// ⚠ add/update ТЕПЕРЬ отклоняют наложение событий (ServiceValidationError) — ошибку показываем,
//   а не глотаем молча.

const EXCEPTIONS_ENTITY = 'binary_sensor.event_schedule_exceptions';
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

class ArvidScheduleUI {
  constructor() {
    this._overlay = null;
    this._events = [];
    this._editingId = null;
    this._formWeekdays = [];
    this._stateHandlerAdded = false;
    this.logArea = 'schedule';

    // Вкладки
    this._activeTab = 'events';

    // Исключения: сохранённое в HA и рабочая (несохранённая) копия
    this._excludedSaved = [];   // [{date:'YYYY-MM-DD', note:''}]
    this._excluded = [];        // рабочая копия
    this._excludedDirty = false;
    this._todayExcluded = false;
    this._todayNote = '';

    // Календарь: показываемый месяц + состояние протаскивания
    this._calYear = null;
    this._calMonth = null;      // 0..11
    this._drag = null;          // {start, mode:'add'|'remove', current}
  }

  init() {
    this._overlay = document.querySelector('[data-schedule-overlay]');
    if (!this._overlay) {
      ARVID_LOG.warn(this.logArea, 'Overlay расписания не найден в DOM');
      return;
    }

    // Закрытие
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) this.close();
    });
    this._overlay.querySelector('[data-schedule-close]').addEventListener('click', () => this.close());

    // Вкладки события / исключения
    this._overlay.querySelectorAll('[data-schedule-tab]').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.scheduleTab));
    });

    // Навигация внутри событий
    this._overlay.querySelector('[data-schedule-show-add]').addEventListener('click', () => this._startAdd());
    this._overlay.querySelector('[data-schedule-back]').addEventListener('click', () => this._showView('list'));

    // Форма события
    this._overlay.querySelector('[data-schedule-form]').addEventListener('submit', e => {
      e.preventDefault();
      this._handleFormSubmit();
    });
    this._overlay.querySelectorAll('[data-sf-weekdays] [data-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        const day = btn.dataset.day;
        btn.classList.toggle('is-active');
        if (this._formWeekdays.includes(day)) {
          this._formWeekdays = this._formWeekdays.filter(d => d !== day);
        } else {
          this._formWeekdays.push(day);
        }
      });
    });

    // Исключения: навигация по месяцам, сохранить/отменить
    this._calGrid = this._overlay.querySelector('[data-cal-grid]');
    this._overlay.querySelector('[data-cal-prev]').addEventListener('click', () => this._shiftMonth(-1));
    this._overlay.querySelector('[data-cal-next]').addEventListener('click', () => this._shiftMonth(1));
    this._overlay.querySelector('[data-exc-save]').addEventListener('click', () => this._saveExclusions());
    this._overlay.querySelector('[data-exc-cancel]').addEventListener('click', () => this._cancelExclusions());
    this._bindCalendarDrag();

    // Кнопки открытия расписания
    document.querySelectorAll('[data-open-schedule]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.open();
        setTimeout(() => btn.blur(), 0);
      });
    });

    ARVID_LOG.info(this.logArea, 'Schedule UI инициализирован');
  }

  open() {
    if (!this._overlay) return;
    this._overlay.classList.add('is-open');
    this._switchTab('events');
    this._showView('list');
    this._ensureStateHandler();
    this._loadFromHA();
  }

  close() {
    this._overlay?.classList.remove('is-open');
  }

  // Обновляем при изменении сенсоров событий ИЛИ сенсора исключений
  _ensureStateHandler() {
    if (this._stateHandlerAdded) return;
    this._stateHandlerAdded = true;
    ARVID_RUNTIME.addStateHandler(event => {
      if (!this._overlay.classList.contains('is-open')) return;
      const entityId = event.data?.new_state?.entity_id;
      if (!entityId) return;
      if (entityId.startsWith('binary_sensor.schedule_') || entityId === EXCEPTIONS_ENTITY) {
        this._loadFromHA();
      }
    });
  }

  async _loadFromHA() {
    try {
      const states = await ARVID_APP.ha.send({ type: 'get_states' });

      // --- события ---
      const schedStates = states.filter(s => s.entity_id.startsWith('binary_sensor.schedule_'));
      this._events = schedStates.map(s => ({
        id: s.attributes.event_id,
        name: s.attributes.event_name || '',
        type: s.attributes.event_type || 'lesson',
        start_time: s.attributes.start_time || '',
        end_time: s.attributes.end_time || '',
        weekdays: s.attributes.weekdays || [],
        description: s.attributes.description || '',
        is_on: s.state === 'on',
        excluded_today: !!s.attributes.excluded_today,
      }));

      // --- исключения ---
      const exc = states.find(s => s.entity_id === EXCEPTIONS_ENTITY);
      if (exc) {
        this._todayExcluded = exc.state === 'on';
        this._todayNote = exc.attributes.today_note || '';
        const dates = exc.attributes.excluded_dates || [];
        const notes = exc.attributes.excluded_notes || {};
        this._excludedSaved = dates.map(d => ({ date: d, note: notes[d] || '' }));
        // Несохранённые правки НЕ затираем фоновым обновлением (решение из EXCLUDED_DATES).
        if (!this._excludedDirty) this._excluded = this._cloneExcluded(this._excludedSaved);
      }

      this._renderList();
      this._renderBanner();
      if (this._activeTab === 'exceptions') this._renderExceptions();
    } catch (err) {
      ARVID_LOG.error(this.logArea, 'Ошибка загрузки расписания из HA', err);
    }
  }

  // ------------------------------------------------------------------
  // Вкладки
  // ------------------------------------------------------------------

  _switchTab(tab) {
    this._activeTab = tab;
    this._overlay.querySelectorAll('[data-schedule-tab]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.scheduleTab === tab);
    });
    this._overlay.querySelectorAll('[data-schedule-pane]').forEach(pane => {
      pane.hidden = pane.dataset.schedulePane !== tab;
    });
    // «+ Добавить» — только на событиях
    const addBtn = this._overlay.querySelector('[data-schedule-show-add]');
    if (addBtn) addBtn.hidden = tab !== 'events';

    if (tab === 'events') {
      this._showView('list');
    } else {
      this._syncCalMonth();
      this._renderExceptions();
    }
  }

  // ------------------------------------------------------------------
  // События
  // ------------------------------------------------------------------

  _showView(view) {
    const formPanel = this._overlay.querySelector('[data-schedule-view="form"]');
    formPanel.classList.toggle('is-open', view === 'form');
    const addBtn = this._overlay.querySelector('[data-schedule-show-add]');
    if (addBtn) addBtn.hidden = !(view === 'list' && this._activeTab === 'events');
  }

  _renderList() {
    const listEl = this._overlay.querySelector('[data-schedule-list]');
    if (!listEl) return;

    const sorted = [...this._events].sort((a, b) => a.start_time.localeCompare(b.start_time));

    if (!sorted.length) {
      listEl.innerHTML = '<div class="schedule-empty">Нет событий. Нажмите «+ Добавить».</div>';
      return;
    }

    const WEEKDAY = { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс' };
    const TYPE_NAME = { lesson: 'Урок', break: 'Перемена', window: 'Окошко', off: 'Нерабочее' };

    listEl.innerHTML = sorted.map(ev => `
      <div class="schedule-event ${ev.is_on ? 'is-active' : ''} ${ev.excluded_today ? 'is-excluded-today' : ''}">
        <div class="schedule-event__info">
          <div class="schedule-event__name">
            ${ev.is_on ? '<span class="schedule-active-dot"></span>' : ''}
            <span>${this._esc(ev.name)}</span>
            <span class="schedule-type-badge schedule-type-${ev.type}">${TYPE_NAME[ev.type] || ev.type}</span>
          </div>
          <div class="schedule-event__time">⏰ ${ev.start_time} – ${ev.end_time}</div>
          <div class="schedule-event__days">
            ${ev.weekdays.map(d => `<span class="schedule-day-chip">${WEEKDAY[d] || d}</span>`).join('')}
          </div>
          ${ev.description ? `<div class="schedule-event__desc">${this._esc(ev.description)}</div>` : ''}
        </div>
        <div class="schedule-event__actions">
          <button type="button" class="schedule-icon-btn" data-edit-event="${ev.id}" title="Редактировать">✎</button>
          <button type="button" class="schedule-icon-btn is-danger" data-delete-event="${ev.id}" title="Удалить">✕</button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-edit-event]').forEach(btn => {
      btn.addEventListener('click', () => this._startEdit(Number(btn.dataset.editEvent)));
    });
    listEl.querySelectorAll('[data-delete-event]').forEach(btn => {
      btn.addEventListener('click', () => this._confirmDelete(Number(btn.dataset.deleteEvent)));
    });
  }

  _renderBanner() {
    const banner = this._overlay.querySelector('[data-schedule-excluded-banner]');
    if (!banner) return;
    if (this._todayExcluded) {
      banner.hidden = false;
      banner.textContent = this._todayNote
        ? `Сегодня расписание отключено — ${this._todayNote}`
        : 'Сегодня расписание отключено';
    } else {
      banner.hidden = true;
      banner.textContent = '';
    }
  }

  _startAdd() {
    this._editingId = null;
    this._formWeekdays = [];
    this._fillForm(null);
    this._showFormError('');
    this._overlay.querySelector('[data-sf-form-title]').textContent = 'Новое событие';
    this._overlay.querySelector('[data-sf-submit]').textContent = 'Добавить';
    this._showView('form');
  }

  _startEdit(id) {
    const ev = this._events.find(e => e.id === id);
    if (!ev) return;
    this._editingId = id;
    this._formWeekdays = [...ev.weekdays];
    this._fillForm(ev);
    this._showFormError('');
    this._overlay.querySelector('[data-sf-form-title]').textContent = 'Редактировать событие';
    this._overlay.querySelector('[data-sf-submit]').textContent = 'Сохранить';
    this._showView('form');
  }

  _fillForm(ev) {
    this._overlay.querySelector('[data-sf-name]').value = ev?.name ?? '';
    this._overlay.querySelector('[data-sf-type]').value = ev?.type ?? 'lesson';
    this._overlay.querySelector('[data-sf-start]').value = ev?.start_time ?? '';
    this._overlay.querySelector('[data-sf-end]').value = ev?.end_time ?? '';
    this._overlay.querySelector('[data-sf-description]').value = ev?.description ?? '';
    this._overlay.querySelectorAll('[data-sf-weekdays] [data-day]').forEach(btn => {
      btn.classList.toggle('is-active', this._formWeekdays.includes(btn.dataset.day));
    });
  }

  _readForm() {
    return {
      name: this._overlay.querySelector('[data-sf-name]').value.trim(),
      type: this._overlay.querySelector('[data-sf-type]').value,
      start_time: this._overlay.querySelector('[data-sf-start]').value,
      end_time: this._overlay.querySelector('[data-sf-end]').value,
      weekdays: [...this._formWeekdays],
      description: this._overlay.querySelector('[data-sf-description]').value.trim(),
    };
  }

  _showFormError(msg) {
    const el = this._overlay.querySelector('[data-sf-error]');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  async _handleFormSubmit() {
    const data = this._readForm();
    this._showFormError('');
    if (!data.name || !data.start_time || !data.end_time) return;
    if (!data.weekdays.length) {
      this._showFormError('Выберите хотя бы один день недели');
      return;
    }
    try {
      if (this._editingId !== null) {
        await this._updateEvent(this._editingId, data);
      } else {
        await this._addEvent(data);
      }
      this._showView('list');
    } catch (err) {
      // Интеграция отклоняет наложение событий — показываем причину, форму НЕ закрываем.
      const msg = err?.message || 'Не удалось сохранить событие';
      this._showFormError(msg);
      ARVID_LOG.warn(this.logArea, 'Событие отклонено интеграцией', err);
    }
  }

  async _addEvent(data) {
    await ARVID_APP.ha.callService('event_schedule', 'add_event', data);
    setTimeout(() => this._loadFromHA(), 1100);
  }

  async _updateEvent(id, data) {
    await ARVID_APP.ha.callService('event_schedule', 'update_event', { event_id: id, ...data });
    // Оптимистичное обновление — только ПОСЛЕ успешного вызова.
    const idx = this._events.findIndex(e => e.id === id);
    if (idx !== -1) this._events[idx] = { ...this._events[idx], ...data };
    this._renderList();
    setTimeout(() => this._loadFromHA(), 1500);
  }

  async _confirmDelete(id) {
    const ev = this._events.find(e => e.id === id);
    if (!ev || !confirm(`Удалить "${ev.name}"?`)) return;
    try {
      await ARVID_APP.ha.callService('event_schedule', 'delete_event', { event_id: id });
      this._events = this._events.filter(e => e.id !== id);
      this._renderList();
      setTimeout(() => this._loadFromHA(), 1100);
    } catch (err) {
      ARVID_LOG.error(this.logArea, 'Ошибка удаления события', err);
      alert(err?.message || 'Не удалось удалить событие');
    }
  }

  // ------------------------------------------------------------------
  // Исключения (даты-выходные)
  // ------------------------------------------------------------------

  _cloneExcluded(arr) {
    return arr.map(e => ({ date: e.date, note: e.note || '' }));
  }

  // Множество дат рабочей копии (быстрый поиск) + карта подписей.
  _excludedIndex() {
    const set = new Set();
    const notes = {};
    this._excluded.forEach(e => { set.add(e.date); notes[e.date] = e.note || ''; });
    return { set, notes };
  }

  _syncCalMonth() {
    if (this._calYear !== null) return;
    const now = new Date();
    this._calYear = now.getFullYear();
    this._calMonth = now.getMonth();
  }

  _shiftMonth(delta) {
    this._syncCalMonth();
    let m = this._calMonth + delta;
    let y = this._calYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    this._calMonth = m;
    this._calYear = y;
    this._renderCalendar();
  }

  _renderExceptions() {
    this._syncCalMonth();
    this._renderCalendar();
    this._renderExcList();
    this._renderDirty();
  }

  _renderCalendar() {
    if (!this._calGrid) return;
    this._overlay.querySelector('[data-cal-title]').textContent =
      `${MONTHS_RU[this._calMonth]} ${this._calYear}`;

    const { set } = this._excludedIndex();
    const todayStr = this._todayStr();

    const firstDay = new Date(this._calYear, this._calMonth, 1);
    const offset = (firstDay.getDay() + 6) % 7;             // Пн=0
    const daysInMonth = new Date(this._calYear, this._calMonth + 1, 0).getDate();

    // Предпросмотр протаскивания
    let preview = null;
    if (this._drag) {
      const [a, b] = [this._drag.start, this._drag.current].sort();
      preview = { a, b, mode: this._drag.mode };
    }

    let html = '';
    for (let i = 0; i < offset; i++) html += '<span class="schedule-cal__cell is-blank"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const date = this._dateStr(this._calYear, this._calMonth, d);
      let cls = 'schedule-cal__cell';
      let excluded = set.has(date);
      if (preview && date >= preview.a && date <= preview.b) {
        // во время протаскивания показываем итоговое состояние
        excluded = preview.mode === 'add';
        cls += ' is-preview';
      }
      if (excluded) cls += ' is-excluded';
      if (date === todayStr) cls += ' is-today';
      html += `<button type="button" class="${cls}" data-date="${date}">${d}</button>`;
    }
    this._calGrid.innerHTML = html;
  }

  _renderExcList() {
    const listEl = this._overlay.querySelector('[data-exc-list]');
    if (!listEl) return;

    const ranges = this._collapseRanges(this._excluded);
    if (!ranges.length) {
      listEl.innerHTML = '<div class="schedule-exc-empty">Исключений нет. Отметьте даты в календаре.</div>';
      return;
    }

    listEl.innerHTML = ranges.map((r, i) => `
      <div class="schedule-exc-row" data-exc-range="${i}">
        <div class="schedule-exc-row__dates">${this._rangeLabel(r)}</div>
        <input type="text" class="schedule-exc-row__note" data-exc-note="${i}"
          value="${this._esc(r.note)}" placeholder="подпись (необязательно)">
        <button type="button" class="schedule-exc-row__del" data-exc-del="${i}" title="Убрать">✕</button>
      </div>
    `).join('');

    // храним диапазоны для обработчиков
    this._ranges = ranges;

    listEl.querySelectorAll('[data-exc-note]').forEach(inp => {
      inp.addEventListener('change', () => {
        const r = this._ranges[Number(inp.dataset.excNote)];
        this._setRangeNote(r, inp.value.trim());
      });
    });
    listEl.querySelectorAll('[data-exc-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = this._ranges[Number(btn.dataset.excDel)];
        this._removeRange(r);
      });
    });
  }

  _renderDirty() {
    const el = this._overlay.querySelector('[data-exc-dirty]');
    if (el) el.hidden = !this._excludedDirty;
  }

  // Подряд идущие даты с ОДИНАКОВОЙ подписью схлопываем в диапазон.
  _collapseRanges(items) {
    const sorted = this._cloneExcluded(items).sort((a, b) => a.date.localeCompare(b.date));
    const ranges = [];
    for (const it of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && it.note === last.note && this._addDays(last.end, 1) === it.date) {
        last.end = it.date;
        last.count += 1;
      } else {
        ranges.push({ start: it.date, end: it.date, note: it.note, count: 1 });
      }
    }
    return ranges;
  }

  _rangeLabel(r) {
    if (r.start === r.end) return this._fmtDate(r.start);
    return `${this._fmtDate(r.start)} — ${this._fmtDate(r.end)}, ${r.count} дн.`;
  }

  _setRangeNote(r, note) {
    let changed = false;
    for (const e of this._excluded) {
      if (e.date >= r.start && e.date <= r.end) {
        if (e.note !== note) { e.note = note; changed = true; }
      }
    }
    if (changed) this._setDirty();
    this._renderExcList();
    this._renderDirty();
  }

  _removeRange(r) {
    this._excluded = this._excluded.filter(e => !(e.date >= r.start && e.date <= r.end));
    this._setDirty();
    this._renderCalendar();
    this._renderExcList();
    this._renderDirty();
  }

  // Применить add/remove к диапазону дат [a..b].
  _applyRange(a, b, mode) {
    const [lo, hi] = [a, b].sort();
    const { set } = this._excludedIndex();
    let cur = lo;
    // защита от бесконечного цикла — не больше 3 лет
    for (let i = 0; i < 1200 && cur <= hi; i++) {
      if (mode === 'add' && !set.has(cur)) {
        this._excluded.push({ date: cur, note: '' });
        set.add(cur);
      } else if (mode === 'remove' && set.has(cur)) {
        this._excluded = this._excluded.filter(e => e.date !== cur);
        set.delete(cur);
      }
      cur = this._addDays(cur, 1);
    }
    this._setDirty();
  }

  _setDirty() {
    this._excludedDirty = true;
  }

  async _saveExclusions() {
    const payload = this._excluded.map(e => (e.note ? { date: e.date, note: e.note } : e.date));
    try {
      await ARVID_APP.ha.callService('event_schedule', 'set_excluded_dates', { excluded_dates: payload });
      // Оптимистично фиксируем; фоновый _loadFromHA подтвердит из HA.
      this._excludedSaved = this._cloneExcluded(this._excluded);
      this._excludedDirty = false;
      this._renderDirty();
      setTimeout(() => this._loadFromHA(), 800);
    } catch (err) {
      ARVID_LOG.error(this.logArea, 'Ошибка сохранения исключений', err);
      alert(err?.message || 'Не удалось сохранить исключения');
    }
  }

  _cancelExclusions() {
    this._excluded = this._cloneExcluded(this._excludedSaved);
    this._excludedDirty = false;
    this._renderExceptions();
  }

  // --- протаскивание по календарю (клик = диапазон из одной даты) ---

  _bindCalendarDrag() {
    if (!this._calGrid) return;

    const cellDate = ev => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const cell = el?.closest?.('[data-date]');
      return cell ? cell.dataset.date : null;
    };

    this._calGrid.addEventListener('pointerdown', ev => {
      const cell = ev.target.closest?.('[data-date]');
      if (!cell) return;
      ev.preventDefault();
      const date = cell.dataset.date;
      const { set } = this._excludedIndex();
      // Режим задаёт стартовая ячейка: с отмеченной — снимаем, с пустой — отмечаем.
      this._drag = { start: date, current: date, mode: set.has(date) ? 'remove' : 'add' };
      try { this._calGrid.setPointerCapture(ev.pointerId); } catch (_) { /* нет капчера — не критично */ }
      this._renderCalendar();
    });

    this._calGrid.addEventListener('pointermove', ev => {
      if (!this._drag) return;
      const date = cellDate(ev);
      if (date && date !== this._drag.current) {
        this._drag.current = date;
        this._renderCalendar();
      }
    });

    const finish = ev => {
      if (!this._drag) return;
      const { start, current, mode } = this._drag;
      this._drag = null;
      this._applyRange(start, current, mode);
      this._renderCalendar();
      this._renderExcList();
      this._renderDirty();
    };
    this._calGrid.addEventListener('pointerup', finish);
    this._calGrid.addEventListener('pointercancel', finish);
  }

  // --- дата-хелперы: строго ЛОКАЛЬНАЯ дата (без UTC-сдвига) ---

  _pad(n) { return String(n).padStart(2, '0'); }

  _dateStr(y, mZeroBased, d) {
    return `${y}-${this._pad(mZeroBased + 1)}-${this._pad(d)}`;
  }

  _todayStr() {
    const n = new Date();
    return this._dateStr(n.getFullYear(), n.getMonth(), n.getDate());
  }

  _addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return this._dateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  _fmtDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}.${m}.${y}`;
  }

  _esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
}

window.ARVID_SCHEDULE = new ArvidScheduleUI();
