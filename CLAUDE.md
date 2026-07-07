# CLAUDE.md — ARVID Visual Interface

## Что это за проект

Потребительский веб-интерфейс к системе умного здания на Home Assistant (ядро — DALI).
**Форк** старого `web_interface` (база v0.9.2): проверенная мобильная вёрстка сохранена,
функциональность вычищена под узкий скоуп. Текущая версия: **v0.1.0**.

Работаем **только** в этом каталоге: `/home/user/nicksha/visual_interface/`.
Старый `web_interface` — заморожен, используется только как справка (не менять!).
`arvid-web-interface` — предыдущая попытка с нуля, тоже только справка.

### Скоуп (строго, см. DESIGN.md)

- **Свет** — вкл/выкл/яркость (лампы `light.l_*` и DALI-группы)
- **Датчики движения и освещённости** — мониторинг (`sensor.ms_*` / `sensor.il_*`,
  одно физическое устройство = две сущности)
- **Кнопочные и поворотные панели** — активность/события (`event.kp_*`)

**НЕ тащим:** климат, температуру, CO₂, влажность, шторы, кондиционеры, сценарии,
энергомониторинг, здоровье, погоду — пока осознанно не решим иначе.
Слоты вёрстки «Сводка/Расписание/Предупреждения/Режимы» сохранены — наполняем их
только сигналами нашего скоупа.

### Связь с ядром DALI

Работаем поверх **стандартных HA-сущностей** (`subscribe_entities`, `light.*` сервисы)
+ узкого набора **read-only** WS-команд `arvid_dali_center/*`.
Карта источников и эндпоинтов — [WEB_INTERFACE_API.md](WEB_INTERFACE_API.md).
Контракт v1 и ключевые решения — [DESIGN.md](DESIGN.md).
Ядро DALI живёт в `/home/user/nicksha/arvid-ha-dali-center/` — только для чтения/справки.
Admin-ядро пусконаладки (`arvid-dali-panel`) не трогаем.

---

## Структура проекта

```
custom_components/web_interface/   ← backend: хранилище layout в HA storage
                                     (домен web_interface оставлен намеренно — общий
                                      layout со старым интерфейсом, без перенастройки HA;
                                      версию backend не трогаем, пока не меняем его код)
www/visual_interface/
  index.html             ← единственная HTML-страница (SPA)

  css/
    base.css
    themes.css
    shell.css            ← оболочка + анимации View Transitions
    floor.css            ← главная страница + Quick View
    room.css
    editor.css
    schedule.css         ← popup расписания

  js/
    config.js            ← VERSION, HA_TOKEN (заглушка на диске, НЕ деплоить с токеном)
    logger.js
    ha-ws.js             ← ArvidHaWebSocket
    floorplan-storage.js
    ha-registry.js       ← areas, floors, states, entities
    app-state.js         ← ARVID_APP, ARVID_RUNTIME (синглтон)
    spa-router.js        ← ArvidSpaApp (маршрутизатор)
    svg-utils.js
    device-ui.js         ← типы устройств СКОУПА: light / motion / illuminance / panel
    shell-ui.js
    floor-page.js
    room-page.js
    editor-page.js
    schedule-ui.js       ← ArvidScheduleUI (popup расписания)

  assets/
    logo/arvid-logo.svg
    floors/…  rooms/…    ← SVG-планы (тестовые)
    icons/light.svg, motion.svg   ← иконок для illuminance/panel пока нет (текстовый fallback)
```

---

## SPA-архитектура (унаследована от базы — НЕ ломать)

`index.html` содержит три view-контейнера: `data-spa-view="floor" | "room" | "editor"`.
Неактивные views скрыты через `hidden`. Переключение без перезагрузки страницы.
**На телефоне вся страница не прокручивается** — скроллятся только панели и overlay.

### Маршруты

```
index.html
index.html?floor_id=…
index.html?view=room&area_id=…&floor_id=…
index.html?view=editor&area_id=…&floor_id=…
```

### ARVID_APP / ARVID_RUNTIME (app-state.js)

```js
ARVID_APP.ha          // ArvidHaWebSocket — одно WS-соединение на всё SPA
ARVID_APP.storage     // ArvidFloorplanStorage
ARVID_APP.registry    // ArvidHaRegistry (areas, floors, states, entities)
ARVID_APP.layout      // layout из HA .storage

ARVID_RUNTIME.ensureData()        // ленивая инициализация, безопасно вызывать повторно
ARVID_RUNTIME.addStateHandler(fn) // подписка на state_changed (без дублей)
```

### Анимации переходов

Нативный **View Transitions API** (Chromium 111+), направления floor↔room (слайд),
floor/room↔editor (fade+slide). Атрибут `data-nav-transition` на `<html>`.

**Критичный нюанс CSS** — селектор без пробела:
```css
/* ПРАВИЛЬНО */  :root[data-nav-transition="floor-to-room"]::view-transition-old(root) { }
/* НЕПРАВИЛЬНО */ :root[…] ::view-transition-old(root) { }
```

### Quick View (мини-карточка помещения)

- Анимация через `opacity + transform + visibility` (не `display`)
- **Reflow trick:** при повторном клике `remove('is-open') → getBoundingClientRect() → add('is-open')`
- При `state_changed` без события мыши — сохранять позицию popup, не пересчитывать
- Карточка «Свет N/N» — первая в списке метрик и кликабельна (toggle света помещения)

### CSS-переменные (только реальные!)

```
--panel-strong  --panel-soft  --panel  --border  --shadow
--text  --muted  --faint  --accent  --accent-strong
--svg-plan-line   ← цвет линий SVG-планов, адаптирован под тему
```

### SVG-планы

- Помещения — элементы `.room-zone[data-room-id]`
- Устройства не захардкожены в SVG, создаются динамически по layout/registry;
  координаты — в SVG viewBox
- Целевой контракт v1 (DESIGN.md): элементы с `data-entity="<entity_id>"` прямо в SVG
  из DWG-конвейера — редактор координат станет запасным путём

---

## Backend

Хранит **только layout/config** в HA storage. Управление устройствами — стандартный
HA WebSocket API. **REST как основной путь не использовать.**

WS-команды интеграции: `web_interface/ping`, `layout/get`, `layout/save`,
`layout/room/update`, `layout/device/update`.

---

## Правила разработки

1. **Менять только нужное для текущей задачи**, ненужный код удалять (не комментировать).
2. **Комментарии в коде — на русском**, логировать ключевые места через `logger.js`.
3. **Сохранять стиль и отступы** исходных файлов.
4. **Версия:** формат `v0.1.0`; при изменении синхронно обновлять `js/config.js` и `CHANGELOG.md`
   (backend версионируется отдельно, только когда меняем его код).
5. **CHANGELOG.md вести при каждом изменении**; метки фиксов — латиницей (Fix A/B/C).
6. **Мобильная вёрстка — святое:** проверять floor/room/editor на телефоне при любых правках UI.
7. **Не возвращать вычищенное** (климат/шторы/CO₂/сценарии) и удалённые механики базы
   (sessionStorage HA cache, preview в редакторе, room.html/editor.html).
8. Большие задачи — сначала план, потом выполнение после подтверждения.
9. Не хардкодить токены; чувствительные данные не деплоить и не коммитить.

### Чеклист проверки SPA (после заметных правок)

- [ ] `index.html` открывается без ошибок в консоли
- [ ] Quick View: открытие, повторный клик (анимация), toggle света
- [ ] Переходы floor↔room↔editor + кнопка «Назад» (popstate)
- [ ] Pan/zoom SVG-плана не ломается после смены view
- [ ] WS-подписки не дублируются; overlay/popup закрываются при смене view
- [ ] Popup расписания открывается; смена темы работает
- [ ] Мобильный портрет: страница не скроллится, панели скроллятся

---

## Деплой (кратко — детали в [DEPLOY.md](DEPLOY.md))

```
Frontend → /config/www/NickSha/visual_interface/
Backend  → /config/custom_components/web_interface/
URL:       https://office.arvid-cloud.ru/local/NickSha/visual_interface/index.html
```

- SSH: `root@office.arvid-cloud.ru:2222`, ключ `~/.ssh/id_ed25519`,
  Cipher `aes256-ctr`, MAC `hmac-sha2-256-etm@openssh.com`
- **Обязателен `-O`** (нет SFTP) и полный путь назначения с именем файла
- **НЕ деплоить `js/config.js` с токеном** — на диске заглушка
- При деплое — только заливка файлов; HA не рестартить, логи не читать без задачи
- После деплоя фронтенда — Ctrl+Shift+R в браузере
