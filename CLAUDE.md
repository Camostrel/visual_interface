# CLAUDE.md — ARVID Visual Interface

## Что это за проект

Потребительский веб-интерфейс к системе умного здания на Home Assistant (ядро — DALI).
**Форк** старого `web_interface` (база v0.9.2): проверенная мобильная вёрстка сохранена,
функциональность вычищена под узкий скоуп. Текущая версия фронта: **v0.4.0**, backend **v0.1.0**.

Карта проекта (модули, потоки данных, зависимости, кто куда обращается) — [ARCHITECTURE.md](ARCHITECTURE.md).

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
custom_components/visual_interface/  ← backend: своя HA-интеграция (домен visual_interface),
                                       чистый стор visual_interface.layout. Хранит только
                                       layout/config (координаты устройств, привязки SVG, тема).
                                       Регистрация: строка visual_interface: в configuration.yaml
                                       (config_flow нет) + рестарт HA.
www/visual_interface/
  index.html             ← единственная HTML-страница (SPA)

  css/
    base.css
    themes.css
    shell.css            ← оболочка + анимации View Transitions
    floor.css            ← главная страница + Quick View
    room.css             ← комната + режим редактирования расстановки
    schedule.css         ← popup расписания

  js/
    config.js            ← VERSION, HA_TOKEN (заглушка на диске, НЕ деплоить с токеном)
    logger.js
    ha-ws.js             ← ArvidHaWebSocket
    floorplan-storage.js
    ha-registry.js       ← areas, floors, states, entities
    app-state.js         ← ARVID_APP, ARVID_RUNTIME (синглтон)
    spa-router.js        ← ArvidSpaApp (маршрутизатор: floor / room)
    svg-utils.js
    device-ui.js         ← типы устройств СКОУПА: light / motion / illuminance / panel
    shell-ui.js
    floor-page.js
    room-page.js         ← комната + режим редактирования (v0.2.0, отдельной страницы нет)
    schedule-ui.js       ← ArvidScheduleUI (popup расписания)

  assets/
    logo/arvid-logo.svg
    floors/…  rooms/…    ← SVG-планы (тестовые)
    icons/light.svg, motion.svg, illuminance.svg, panel.svg
                         ← единый стиль: панель-градиент + гравировка, viewBox 120
```

---

## SPA-архитектура (унаследована от базы — НЕ ломать)

`index.html` содержит два view-контейнера: `data-spa-view="floor" | "room"`.
Неактивные views скрыты через `hidden`. Переключение без перезагрузки страницы.
**На телефоне вся страница не прокручивается** — скроллятся только панели и overlay.

### Маршруты

```
index.html
index.html?floor_id=…
index.html?view=room&area_id=…&floor_id=…
```

### Режим редактирования расстановки (v0.2.0, DESIGN решение 20)

Отдельной страницы редактора НЕТ. Кнопка «Редактор» в шапке комнаты включает режим
(`is-room-editing` на shell): вместо панелей управления — карточка «Расстановка устройств»
(фильтры Все/Свет/Датчики/Панели, список с едиными иконками, «В центр плана»,
«Убрать с плана», «Сохранить разметку»). Перенос: drag на компьютере, тап по плану
на телефоне. При выходе с несохранёнными изменениями — confirm: сохранить или отменить
(перечитка layout из HA). Иконка маркера назначается автоматически по типу устройства.

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

Нативный **View Transitions API** (Chromium 111+), направления floor↔room (слайд).
Атрибут `data-nav-transition` на `<html>`.

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

- Помещения — элементы `.room-zone[data-room-id]`; подсветка (hover / активная /
  `has-light-on` оранжевый при включённом свете) — в `floor.css`, стилей внутри SVG нет.
- Устройства не захардкожены в SVG, создаются динамически по layout/registry;
  координаты — в SVG viewBox.
- Линии планов наследуют цвет темы через `currentColor` (`.arvid-svg-plan { color: var(--svg-plan-line) }`).
- Актуальные планы: `floors/default-floor.svg` (реалистичный этаж, активная зона `ofis`),
  `rooms/ofis.svg` (кабинет ~2:1), `rooms/default-room.svg` (fallback). Пробные удалены.
- Целевой контракт v1 (DESIGN.md): элементы с `data-entity="<entity_id>"` прямо в SVG
  из DWG-конвейера; режим редактирования в комнате — путь для самостоятельной расстановки.

### Привязка «устройство → комната» (v0.4.0)

`ARVID_APP.entitiesForRoom(areaId)` = HA area (`entity/device.area_id`) ∪ размещённые нами
(`layout.devices[*].area_id`). Работает и с назначенными area, и без них (частные объекты).
Свет комнаты, подсветка зон и карточки управления считаются по этому объединению.
Режим редактирования показывает **все** устройства скоупа HA (для расстановки) + поиск.

---

## Backend (своя интеграция `visual_interface`, v0.1.0)

Хранит **только layout/config** в собственном сторе `visual_interface.layout`
(координаты устройств, привязки SVG, тема). Управление устройствами и состояния —
стандартный HA WebSocket API. **REST как основной путь не использовать.**

WS-команды: `visual_interface/ping`, `visual_interface/layout/get`,
`visual_interface/layout/save`, `visual_interface/layout/room/update`,
`visual_interface/layout/device/update`. Права: get/ping — свободно, save/room/device —
`require_admin` (тонкая модель прав — открытый вопрос, WEB_INTERFACE_API §6).

Установка: папка в `/config/custom_components/visual_interface/`, строка
`visual_interface:` в `configuration.yaml`, рестарт HA (config_flow нет).
Стор чистый и независимый от старого `web_interface` — форк развивается сам по себе.

---

## Правила разработки

1. **Менять только нужное для текущей задачи**, ненужный код удалять (не комментировать).
2. **Комментарии в коде — на русском**, логировать ключевые места через `logger.js`.
3. **Сохранять стиль и отступы** исходных файлов.
4. **Версия:** формат `v0.1.0`; при изменении синхронно обновлять `js/config.js` и `CHANGELOG.md`
   (backend версионируется отдельно, только когда меняем его код).
5. **CHANGELOG.md вести при каждом изменении**; метки фиксов — латиницей (Fix A/B/C).
   При структурных изменениях (модули, потоки данных, backend, зависимости) — обновлять
   **[ARCHITECTURE.md](ARCHITECTURE.md)**.
6. **Мобильная вёрстка — святое:** проверять floor/room (+ режим редактирования) на телефоне при любых правках UI.
7. **Не возвращать вычищенное** (климат/шторы/CO₂/сценарии) и удалённые механики базы
   (sessionStorage HA cache, preview в редакторе, room.html/editor.html).
8. Большие задачи — сначала план, потом выполнение после подтверждения.
9. Не хардкодить токены; чувствительные данные не деплоить и не коммитить.

### Чеклист проверки SPA (после заметных правок)

- [ ] `index.html` открывается без ошибок в консоли
- [ ] Quick View: открытие, повторный клик (анимация), toggle света
- [ ] Переходы floor↔room + кнопка «Назад» (popstate)
- [ ] Режим редактирования: вход/выход, фильтры, drag (desktop) и тап (телефон),
      «Убрать с плана», сохранение, confirm при несохранённых изменениях
- [ ] Pan/zoom SVG-плана не ломается после смены view
- [ ] WS-подписки не дублируются; overlay/popup закрываются при смене view
- [ ] Popup расписания открывается; смена темы работает
- [ ] Мобильный портрет: страница не скроллится, панели скроллятся

---

## Деплой (кратко — детали в [DEPLOY.md](DEPLOY.md))

```
Frontend → /config/www/NickSha/visual_interface/
Backend  → /config/custom_components/visual_interface/
URL:       https://office.arvid-cloud.ru/local/NickSha/visual_interface/index.html
```

- SSH: `root@office.arvid-cloud.ru:2222`, ключ `~/.ssh/id_ed25519`,
  Cipher `aes256-ctr`, MAC `hmac-sha2-256-etm@openssh.com`
- **Обязателен `-O`** (нет SFTP) и полный путь назначения с именем файла
- **НЕ деплоить `js/config.js` с токеном** — на диске заглушка
- При деплое — только заливка файлов; HA не рестартить, логи не читать без задачи
- После деплоя фронтенда — Ctrl+Shift+R в браузере
- **Исключение — установка/обновление backend:** новая интеграция требует строки
  `visual_interface:` в `configuration.yaml` и рестарта HA. Рестарт делает пользователь
  (не автоматизируем), это разовое действие установки, а не обычный деплой.

---

## Статус и дальнейший путь (2026-07-08)

**Где мы:** v0.3.0. Свой backend (домен `visual_interface`, чистый стор). Скоуп
свет/датчики/панели закрыт по вёрстке и управлению. Режим редактирования в комнате.

**Модель координат — гибрид (осознанно):**
- **Частные объекты (офис, тест сейчас):** ручная расстановка через режим редактирования,
  координаты в нашем сторе. Это ПОЛНОЦЕННЫЙ путь, не временный.
- **Большие объекты (продакшн, будет 100%):** конвейер DWG→SVG с `data-entity` в SVG,
  авто-привязка по имени (DESIGN Сценарий 1). Пока не реализован.

**Долг/следующее (в порядке важности):**
1. Читать `data-entity` из SVG (сейчас читаем только `data-room-id` зон) — основа Сценария 1.
2. Перейти с `loadAll()` + глобального `state_changed` на `subscribe_entities` по сегменту
   (DESIGN реш. 13) — критично для реального объекта ~4400 устройств.
3. Опора на `arvid_dali_center` read-only WS — точечно, где не хватает стандартных сущностей
   (состав DALI-группы, живой поток событий панелей).
4. Фичи: CCT (тип 0102), честная обработка `unavailable`/зомби (реш. 17), «живой» индикатор
   панелей, индикатор «ожидание» при действии (реш. 12).
