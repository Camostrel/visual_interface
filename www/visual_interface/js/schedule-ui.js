// schedule-ui.js
// Popup расписания: список событий, добавление, редактирование, удаление.
// Данные берём из binary_sensor.schedule_* через уже существующий ARVID WebSocket.

class ArvidScheduleUI {
  constructor() {
    this._overlay = null;
    this._events = [];
    this._editingId = null;
    this._formWeekdays = [];
    this._stateHandlerAdded = false;
    this.logArea = 'schedule';
  }

  init() {
    this._overlay = document.querySelector('[data-schedule-overlay]');
    if (!this._overlay) {
      ARVID_LOG.warn(this.logArea, 'Overlay расписания не найден в DOM');
      return;
    }

    // Закрытие: клик по фону или кнопка ×
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) this.close();
    });
    this._overlay.querySelector('[data-schedule-close]').addEventListener('click', () => this.close());

    // Навигация внутри popup
    this._overlay.querySelector('[data-schedule-show-add]').addEventListener('click', () => this._startAdd());
    this._overlay.querySelector('[data-schedule-back]').addEventListener('click', () => this._showView('list'));

    // Форма сохранения
    this._overlay.querySelector('[data-schedule-form]').addEventListener('submit', e => {
      e.preventDefault();
      this._handleFormSubmit();
    });

    // Кнопки выбора дней
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

    // Все кнопки открытия расписания на странице
    document.querySelectorAll('[data-open-schedule]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.open();
        // setTimeout нужен: blur до focus бессмысленен — браузер ставит focus после click
        setTimeout(() => btn.blur(), 0);
      });
    });

    ARVID_LOG.info(this.logArea, 'Schedule UI инициализирован');
  }

  open() {
    if (!this._overlay) return;
    this._overlay.classList.add('is-open');
    this._showView('list');
    this._ensureStateHandler();
    this._loadFromHA();
  }

  close() {
    this._overlay?.classList.remove('is-open');
  }

  // Подписываемся на state_changed один раз — обновляем список при изменении binary_sensor.schedule_*
  _ensureStateHandler() {
    if (this._stateHandlerAdded) return;
    this._stateHandlerAdded = true;
    ARVID_RUNTIME.addStateHandler(event => {
      if (!this._overlay.classList.contains('is-open')) return;
      const entityId = event.data?.new_state?.entity_id;
      if (!entityId?.startsWith('binary_sensor.schedule_')) return;
      this._loadFromHA();
    });
  }

  async _loadFromHA() {
    try {
      const states = await ARVID_APP.ha.send({ type: 'get_states' });
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
      }));
      this._renderList();
    } catch (err) {
      ARVID_LOG.error(this.logArea, 'Ошибка загрузки расписания из HA', err);
    }
  }

  _showView(view) {
    // Форма выезжает поверх списка — управляем только классом is-open на панели
    const formPanel = this._overlay.querySelector('[data-schedule-view="form"]');
    formPanel.classList.toggle('is-open', view === 'form');
    // Кнопка добавления видна только в режиме списка
    const addBtn = this._overlay.querySelector('[data-schedule-show-add]');
    if (addBtn) addBtn.hidden = view !== 'list';
  }

  _renderList() {
    const listEl = this._overlay.querySelector('[data-schedule-list]');
    if (!listEl) return;

    const sorted = [...this._events].sort((a, b) => a.start_time.localeCompare(b.start_time));

    if (!sorted.length) {
      listEl.innerHTML = '<div class="schedule-empty">Нет событий. Нажмите «+ Добавить событие».</div>';
      return;
    }

    const WEEKDAY = { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс' };
    const TYPE_NAME = { lesson: 'Урок', break: 'Перемена', window: 'Окошко', off: 'Нерабочее' };

    listEl.innerHTML = sorted.map(ev => `
      <div class="schedule-event ${ev.is_on ? 'is-active' : ''}">
        <div class="schedule-event__info">
          <div class="schedule-event__name">
            ${ev.is_on ? '<span class="schedule-active-dot"></span>' : ''}
            <span>${ev.name}</span>
            <span class="schedule-type-badge schedule-type-${ev.type}">${TYPE_NAME[ev.type] || ev.type}</span>
          </div>
          <div class="schedule-event__time">⏰ ${ev.start_time} – ${ev.end_time}</div>
          <div class="schedule-event__days">
            ${ev.weekdays.map(d => `<span class="schedule-day-chip">${WEEKDAY[d] || d}</span>`).join('')}
          </div>
          ${ev.description ? `<div class="schedule-event__desc">${ev.description}</div>` : ''}
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

  _startAdd() {
    this._editingId = null;
    this._formWeekdays = [];
    this._fillForm(null);
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

  async _handleFormSubmit() {
    const data = this._readForm();
    if (!data.name || !data.start_time || !data.end_time) return;
    if (!data.weekdays.length) {
      alert('Выберите хотя бы один день недели');
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
      ARVID_LOG.error(this.logArea, 'Ошибка сохранения события', err);
    }
  }

  async _addEvent(data) {
    await ARVID_APP.ha.callService('event_schedule', 'add_event', data);
    // HA создаёт binary_sensor через секунду, подтягиваем
    setTimeout(() => this._loadFromHA(), 1100);
  }

  async _updateEvent(id, data) {
    await ARVID_APP.ha.callService('event_schedule', 'update_event', { event_id: id, ...data });
    // Мгновенное локальное обновление
    const idx = this._events.findIndex(e => e.id === id);
    if (idx !== -1) this._events[idx] = { ...this._events[idx], ...data };
    this._renderList();
    // Синхронизация с реальными данными HA
    setTimeout(() => this._loadFromHA(), 1500);
  }

  async _confirmDelete(id) {
    const ev = this._events.find(e => e.id === id);
    if (!ev || !confirm(`Удалить "${ev.name}"?`)) return;
    await ARVID_APP.ha.callService('event_schedule', 'delete_event', { event_id: id });
    this._events = this._events.filter(e => e.id !== id);
    this._renderList();
    setTimeout(() => this._loadFromHA(), 1100);
  }
}

window.ARVID_SCHEDULE = new ArvidScheduleUI();
