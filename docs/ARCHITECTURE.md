# ARCHITECTURE — ARVID Visual Interface

Карта проекта: из чего состоит, кто куда обращается, какие зависимости. Держим в актуальном
состоянии при изменениях (см. правило в [CLAUDE.md](../CLAUDE.md)).

## 1. Что это

Потребительский веб-интерфейс к системе умного здания на Home Assistant (ядро — DALI).
Три слоя:

```
┌─────────────────────────────────────────────────────────────────────┐
│  БРАУЗЕР (телефон/ПК)                                                │
│  Frontend SPA  —  www/visual_interface/  (ваниль JS, без сборки)     │
└───────────────┬─────────────────────────────────────────────────────┘
                │  один WebSocket /api/websocket (long-lived token)
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  HOME ASSISTANT                                                      │
│                                                                     │
│  (A) Стандартный HA WS API        (B) Наш backend                   │
│      get_states                       custom_components/            │
│      config/*_registry/list           visual_interface/            │
│      call_service (light.*)           visual_interface/layout/*     │
│      subscribe_events                  → стор visual_interface.layout│
│         (state_changed)                                             │
│                                                                     │
│  (C) Ядро DALI: arvid_dali_center  —  сущности light./sensor./event.│
│      + read-only WS (пока НЕ используем, план — точечно)            │
└─────────────────────────────────────────────────────────────────────┘
```

- **(A) Стандартный HA** — источник состояний, реестров (этажи/комнаты/устройства) и
  управления светом. Главный контракт.
- **(B) Наш backend** — хранит только layout (координаты устройств на планах, привязки SVG,
  тема). Ничего не знает про состояния и сервисы.
- **(C) DALI-ядро** — поставляет сами сущности (`light.l_*`, `sensor.ms_*/il_*`, `event.kp_*`).
  Его admin-функции (пусконаладка) интерфейс не трогает.

## 2. Frontend: модули и ответственность

Порядок = порядок подключения в `index.html` (важен: нижние зависят от верхних).
Всё вешается в глобальные `window.*`, сборщика нет.

| Файл | Экспорт | Ответственность | Зависит от |
|---|---|---|---|
| `js/config.js` | `ARVID_CONFIG` | версия, HA-токен, базовый путь, резолв asset-URL | — |
| `js/logger.js` | `ARVID_LOG` | логирование по уровням | `ARVID_CONFIG` |
| `js/ha-ws.js` | `ArvidHaWebSocket` | WS-соединение, auth, `send`/`callService`/`subscribeStateChanged` | `ARVID_CONFIG`, `ARVID_LOG` |
| `js/floorplan-storage.js` | `ArvidFloorplanStorage` | клиент нашего backend (`visual_interface/*`) | `ArvidHaWebSocket` |
| `js/ha-registry.js` | `ArvidHaRegistry` | загрузка реестров + states, резолв area, апдейт по событию | `ArvidHaWebSocket` |
| `js/app-state.js` | `ARVID_APP`, `ARVID_RUNTIME` | синглтон runtime; инициализация; подписка; состав комнаты и группы света | всё выше |
| `js/svg-utils.js` | `ArvidSvgUtils` | загрузка SVG, pan/zoom, экран↔viewBox, оверлей-слои | `ARVID_LOG` |
| `js/device-ui.js` | `ArvidDeviceUi` | классификация сущностей скоупа (`light` / `sensor` / `panel`), иконки | — (чистые функции) |
| `js/shell-ui.js` | `ArvidShellUi` | тема, сворачивание панелей, часы, бренд | `ARVID_APP`, `ARVID_CONFIG` |
| `js/floor-page.js` | `ArvidFloorPage` | план этажа: зоны, тап/двойной тап, подсветка, сводка, режим карты | `ARVID_APP`, `ArvidShellUi`, `ArvidSvgUtils`, `ArvidDeviceUi` |
| `js/room-page.js` | `ArvidRoomPage` | план комнаты: маркеры, управление, **режим редактирования** | то же + `ArvidFloorplanStorage` (через `ARVID_APP.storage`) |
| `js/spa-router.js` | `ArvidSpaApp` | маршруты floor/room, History API, View Transitions | создаёт page-объекты |
| `js/schedule-ui.js` | `ArvidScheduleUI` | popup расписания (унаследовано, вне скоупа v1) | `ARVID_APP` |

**Единый синглтон** `ARVID_APP` (в `app-state.js`) — единственный держатель shared-состояния:

```
ARVID_APP.ha        ArvidHaWebSocket   — одно WS-соединение на весь SPA
ARVID_APP.storage   ArvidFloorplanStorage
ARVID_APP.registry  ArvidHaRegistry    — areas/floors/entities/devices/states
ARVID_APP.layout    object             — layout из нашего backend

ARVID_APP.entitiesForArea(areaId)        — СОСТАВ комнаты (истина HA)
ARVID_APP.placedEntitiesForRoom(areaId)  — размещённые на плане (наш layout) → маркеры
ARVID_APP.entitiesForRoom(areaId)        — объединение, ТОЛЬКО фильтр «свои события»
ARVID_APP.isUnassignedInRoom(id, areaId) — стоит на плане, но в HA к комнате не привязано
ARVID_APP.lightGroupState(objectId)      — HA-группа света: light.<area_id|floor_id|all>

ARVID_RUNTIME.ensureData()             — ленивая инициализация (идемпотентна)
ARVID_RUNTIME.addStateHandler(fn)      — подписка на state_changed без дублей
```

## 3. Потоки данных

### 3.1 Запуск
```
index.html
  → new ArvidSpaApp().init()
    → routeFromLocation() → showView(view) → getPage(view).init(params)
      → ARVID_RUNTIME.ensureData()
        → ArvidHaWebSocket.connect()          (auth по токену)
        → ArvidHaRegistry.loadAll()           (get_states + 4 реестра, ОДНИМ залпом)
        → ArvidFloorplanStorage.getLayout()   (visual_interface/layout/get)
      → page рендерит план и панели
```

### 3.2 Управление светом (реальное состояние, без оптимистики)
```
тап по зоне комнаты / карточке / маркеру
  → ARVID_APP.lightGroupState(area|floor|"all")  — детерминированная HA-группа
  → ARVID_APP.ha.callService("light", "turn_on|off|toggle", …)
  → HA выполняет, шлёт event state_changed
  → ArvidHaRegistry.updateStateFromEvent()      (обновляет states)
  → зарегистрированные handler'ы (addStateHandler)
  → page.handleStateChanged(event)              (v0.6.0: НЕ перерисовка)
      фильтр «свои сущности» → коалесценция в кадр (rAF)
      → update*(): только значения и классы по якорям data-*
```

> **Правило (v0.6.0):** DOM не перестраивается по `state_changed`. Полный `render*` —
> только при смене комнаты/этажа, входе-выходе из редактирования и сохранении разметки.

### 3.3 Расстановка устройств (режим редактирования в комнате)
```
кнопка «Редактор» в шапке комнаты → ArvidRoomPage.setEditMode(true)
  → список ВСЕХ устройств скоупа HA (getAllScopedEntities) + поиск
  → выбор устройства → drag (ПК) / тап по плану (телефон)
    → layout.devices[entityId] = { x, y, area_id: <эта комната>, visible: true }
  → «Сохранить разметку»
    → ARVID_APP.storage.saveLayout(layout)      (visual_interface/layout/save, require_admin)
    → backend пишет в стор visual_interface.layout
```

### 3.4 Подсветка комнат по свету (на плане этажа)
```
state_changed → ArvidFloorPage.handleStateChanged()  (rAF-коалесценция)
  → applyRoomLightHighlight()
    → для каждой .room-zone[data-room-id]:
        getRoomStats(areaId).hasLightOn
          = группа light.<area_id>, если есть; иначе «горит хотя бы одна лампа состава»
          (состав = ARVID_APP.entitiesForArea — истина HA)
        → toggle класс .room-zone.has-light-on → floor.css красит прозрачным оранжевым
```
> `bindRoomZones()` вызывается только при загрузке плана, НЕ по `state_changed`.

## 4. Модель привязки «устройство → комната» (важно)

Два источника, объединяются в `ARVID_APP.entitiesForRoom(areaId)`:
**⟳ v0.7.0: истина о принадлежности — Home Assistant.** Два РАЗНЫХ понятия, не путать:

| Понятие | Источник | Метод | Для чего |
|---|---|---|---|
| **Состав комнаты** | HA (`entity/device.area_id`) | `ARVID_APP.entitiesForArea()` | карточки, счётчики «N/N», статистика |
| **Размещённые на плане** | наш layout (координаты + `area_id`) | `ARVID_APP.placedEntitiesForRoom()` | отрисовка маркеров |
| Объединение | оба | `ARVID_APP.entitiesForRoom()` | **только** фильтр «свои события» для подписки |

До v0.7.0 состав был объединением — и становился непрозрачным: устройство попадало в комнату
просто потому, что его расставили на плане.

Устройство, размещённое на плане, но не привязанное к комнате в HA
(`ARVID_APP.isUnassignedInRoom`), рисуется приглушённым (`.device-marker.is-unassigned`),
в состав и в группу света не входит, и о нём предупреждает плашка в карточках комнаты.

### 4.2 Группы света (детерминированные, v0.6.x)

```
комната → light.<area_id>    (light.ofis)
этаж    → light.<floor_id>   (light.3_etazh)
объект  → light.all
```

`ARVID_APP.lightGroupState(id)` → состояние группы или `null`. Нет группы → фолбэк-сборка ламп
+ `warn` в лог. Групповая сущность исключается из счётчиков ламп-членов. Управление светом
**не зависит** от состава комнаты.

> В режиме редактирования список — это **все** устройства скоупа HA (не по area),
> с поиском по названию: расставлять нужно уметь любое устройство.

### 4.1 Единый датчик движения+освещённости (v0.4.1)

Датчик DALI — это ДВЕ сущности с общим `device_id`: `sensor.ms_*` (движение,
`device_class` пустой → распознаём по префиксу `ms_`) и `sensor.il_*` (освещённость,
`device_class=illuminance`). В интерфейсе это **одна точка** (kind `sensor`):
- `room-page.collapseToUnits(states)` схлопывает пару в якорь (сущность движения) по
  `registry.getDeviceId` / `getEntitiesForDevice`;
- `getSensorReadings(anchor)` возвращает `{motion, lux}` того же устройства;
- на плане — один маркер, в показаниях — оба значения (движение · lx).

## 5. Backend (`custom_components/visual_interface/`)

| Файл | Роль |
|---|---|
| `const.py` | `DOMAIN`, `STORAGE_KEY=visual_interface.layout`, имена WS-команд, версия |
| `storage.py` | `VisualInterfaceStorage` — обёртка HA `Store`, дефолтный layout, merge |
| `websocket_api.py` | 5 WS-команд, регистрация |
| `__init__.py` | `async_setup` из `configuration.yaml` |
| `manifest.json` | домен, зависимость `websocket_api`, `config_flow: false` |

| Команда | Права | Возвращает |
|---|---|---|
| `visual_interface/ping` | — | `{ok, domain, version}` |
| `visual_interface/layout/get` | — | `{layout}` |
| `visual_interface/layout/save` | admin | `{layout}` |
| `visual_interface/layout/room/update` | admin | `{layout}` |
| `visual_interface/layout/device/update` | admin | `{layout}` |

Стор `visual_interface.layout` (структура): `building`, `floors`, `rooms`, `devices` (координаты),
`ui.theme`, `meta`. HA остаётся источником этажей/комнат/сущностей — backend их НЕ дублирует.

## 6. Внешние зависимости

- **HA WebSocket** `/api/websocket`: `auth`, `get_states`, `config/floor_registry/list`,
  `config/area_registry/list`, `config/entity_registry/list`, `config/device_registry/list`,
  `call_service`, `subscribe_events(state_changed)`.
- **Наш backend** `visual_interface/*` (см. §5).
- **arvid_dali_center** (ядро DALI): сейчас используется только косвенно — через стандартные
  сущности `light./sensor./event.`, которые оно создаёт. Его read-only WS (`gateways`, `groups`,
  `energy_*`, `health_*`, `events_subscribe`) **пока не вызываем**; план — точечно, когда
  понадобится специфика (состав DALI-группы, живой поток событий панелей). См. `WEB_INTERFACE_API.md`.
- Внешних JS-библиотек нет. View Transitions, WebSocket, SVG — нативные.

## 7. Ключевые инварианты

- **Одно WS-соединение** на весь SPA (в `ARVID_APP.ha`), одна подписка на `state_changed`.
- **Реальное состояние** из HA, без оптимистичного UI (DESIGN реш. 12).
- **DOM не перестраивается по `state_changed`** — только значения и классы (v0.6.0).
- **Состав комнаты — истина HA** (`entitiesForArea`), расстановка на плане — отдельно (v0.7.0).
- **Свет — только через HA-группы** `light.<area_id|floor_id|all>`, не поиском ламп (v0.6.x).
- **Координаты** — в системе viewBox SVG, не в пикселях экрана.
- **REST** как основной путь не используем — только WebSocket.
- **Скоуп**: `light` / `sensor` (пара ms_+il_) / `panel`. Вне-скоупные сущности не рисуются
  (фильтр `getScopedEntities` / `isScopedState`).
- **Токен** не хранится в репозитории (в `config.js` заглушка, подставляется на HA при деплое).

## 8. Техдолг

Полный реестр долгов и открытых вопросов — **[DEBT.md](DEBT.md)** (с приоритетами P1–P3
и задачами на стороне HA).

Архитектурно-значимые (P1):
1. **D1 — загрузка «всё сразу»**: `loadAll()` + глобальный `subscribe_events(state_changed)`.
   На ~4400 устройств стоп-фактор. Целевое (DESIGN реш. 13): `subscribe_entities` по сегменту.
2. **D2 — `data-entity` из SVG не читается**: сейчас только зоны `data-room-id`.
   Нужен для Сценария 1 (конвейер DWG→SVG).

Фазы и приоритеты — в [ROADMAP.md](ROADMAP.md).
