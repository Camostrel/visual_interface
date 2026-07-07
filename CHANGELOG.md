# Changelog — ARVID Visual Interface

## v0.1.0 — 2026-07-07 — форк web_interface, чистка под скоуп «свет»

Новый проект: форк `web_interface` v0.9.2 с сохранением мобильной вёрстки и SPA-архитектуры.
Скоуп зафиксирован в DESIGN.md: свет · движение/освещённость · кнопочные/поворотные панели.

### Перенесено из базы (без изменений)

- SPA: `index.html` (floor/room/editor), spa-router, View Transitions, ARVID_APP/ARVID_RUNTIME
- Вёрстка: shell/floor/room/editor/schedule CSS, мобильные аккордеоны, Quick View, popup расписания
- Backend `custom_components/web_interface` (хранилище layout, домен оставлен прежним —
  общий layout со старым интерфейсом, без перенастройки HA)
- Правила деплоя (DEPLOY.md, пути обновлены на `visual_interface`)
- Скиллы из `.claude copy` → `.claude/skills`
- Спека API ядра `WEB_INTERFACE_API.md` и контракт `DESIGN.md` (из arvid-web-interface)

### Удалено (вне скоупа)

- **Климат**: карточка климата в комнате, климат в Quick View и сводке этажа,
  `climate.*` из типов устройств, попап управления климатом, CSS `.climate-*`
- **Шторы**: карточка штор, `cover.*` из типов, иконка cover.svg
- **Датчики температуры/влажности/CO₂**: детекторы в device-ui, метрики Quick View,
  пороговые предупреждения этажа (temperature/humidity/co2), иконка temperature.svg
- **Сценарии**: карточка «Быстрые сценарии», `scene.*`/`script.*` из типов, CSS `.scenario-*`
- Иконки climate/cover/temperature/fan, устаревшие `room.html`/`editor.html`,
  локальные бэкапы `assets/Версия claude/`, неиспользуемый `supportsPopupControl`

### Добавлено (закладка нового скоупа)

- `device-ui.js`: `isPanelEvent()` + `panelEventText()` — панели как `event.*`
  (click/double/hold/hold_end/rotate + key_no), тип маркера `panel`
- Комната: read-only карточка «Панели» (последнее событие по каждой панели),
  попап панели по клику/долгому тапу на маркер
- Quick View: метрика «Освещённость» (lx) вместо климата/CO₂/влажности
- Сводка этажа: карточка «Движение» (помещения с активным движением, переход в комнату)
- Слот «Предупреждения» сохранён с заглушкой — наполнение сигналами скоупа спроектируем отдельно
- Редактор: типы устройств ограничены `light./sensor./event.`, иконка «Панель»
- CSS: цвет маркера `device-kind-panel` (комната + редактор)

### Версии

- Frontend: `v0.1.0` (`js/config.js`), новый отсчёт
- Backend: не менялся, остаётся на версии базы (0.9.x)
