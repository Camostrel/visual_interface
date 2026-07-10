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
| `js/app-state.js` | `ARVID_APP`, `ARVID_RUNTIME` | синглтон runtime; инициализация; подписка на события; `entitiesForRoom` | всё выше |
| `js/svg-utils.js` | `ArvidSvgUtils` | загрузка SVG, pan/zoom, экран↔viewBox, оверлей-слои | `ARVID_LOG` |
| `js/device-ui.js` | `ArvidDeviceUi` | классификация сущностей скоупа, иконки, тип маркера | — (чистые функции) |
| `js/shell-ui.js` | `ArvidShellUi` | тема, сворачивание панелей, часы, бренд | `ARVID_APP`, `ARVID_CONFIG` |
| `js/floor-page.js` | `ArvidFloorPage` | план этажа: зоны, Quick View, сводка, подсветка света | `ARVID_APP`, `ArvidShellUi`, `ArvidSvgUtils`, `ArvidDeviceUi` |
| `js/room-page.js` | `ArvidRoomPage` | план комнаты: маркеры, управление, **режим редактирования** | то же + `ArvidFloorplanStorage` (через `ARVID_APP.storage`) |
| `js/spa-router.js` | `ArvidSpaApp` | маршруты floor/room, History API, View Transitions | создаёт page-объекты |
| `js/schedule-ui.js` | `ArvidScheduleUI` | popup расписания (унаследовано, вне скоупа v1) | `ARVID_APP` |

**Единый синглтон** `ARVID_APP` (в `app-state.js`) — единственный держатель shared-состояния:

```
ARVID_APP.ha        ArvidHaWebSocket   — одно WS-соединение на весь SPA
ARVID_APP.storage   ArvidFloorplanStorage
ARVID_APP.registry  ArvidHaRegistry    — areas/floors/entities/devices/states
ARVID_APP.layout    object             — layout из нашего backend
ARVID_APP.entitiesForRoom(areaId)      — устройства комнаты: HA area ∪ размещённые в layout
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
клик по маркеру/карточке
  → ARVID_APP.ha.callService("light", "turn_on|off|toggle", …)
  → HA выполняет, шлёт event state_changed
  → ArvidHaRegistry.updateStateFromEvent()      (обновляет states)
  → зарегистрированные handler'ы (addStateHandler)
  → page.handleStateChanged() → перерисовка маркеров/карточек/подсветки
```

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
state_changed  → ArvidFloorPage.handleStateChanged() → syncRoomZones()
  → applyRoomLightHighlight()
    → для каждой .room-zone[data-room-id]:
        getRoomStats(areaId).hasLightOn  (свет = ARVID_APP.entitiesForRoom: area ∪ размещённые)
        → toggle класс .room-zone.has-light-on  → floor.css красит прозрачным оранжевым
```

## 4. Модель привязки «устройство → комната» (важно)

Два источника, объединяются в `ARVID_APP.entitiesForRoom(areaId)`:
1. **HA area** — `entity.area_id` / `device.area_id` (стандартно для HA).
2. **Наша расстановка** — `layout.devices[id].area_id`, проставляется при размещении на плане.

Зачем: на **частных объектах** (офис) area устройствам часто не заданы. Тогда связь «что в
комнате» возникает из нашей расстановки. На **больших объектах** сработает HA area. Объединение
поддерживает оба пути и обратно совместимо.

> Поэтому в режиме редактирования список — это **все** устройства скоупа HA (не по area),
> с поиском по названию. «Фильтр по помещению» отложен как идея (нужен, когда area будут заданы).

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
- **Координаты** — в системе viewBox SVG, не в пикселях экрана.
- **REST** как основной путь не используем — только WebSocket.
- **Скоуп**: `light` / `motion` / `illuminance` / `panel`. Вне-скоупные сущности не рисуются
  (фильтр `getScopedEntities` / `isScopedState`).
- **Токен** не хранится в репозитории (в `config.js` заглушка, подставляется на HA при деплое).

## 8. Известный техдолг (влияет на архитектуру)

1. **Загрузка «всё сразу»**: `ArvidHaRegistry.loadAll()` тянет все `get_states` + глобальный
   `subscribe_events(state_changed)`. На объекте ~4400 устройств — стоп-фактор. Целевое (DESIGN
   реш. 13): `subscribe_entities` только на сущности текущего сегмента (их объявит `data-entity` в SVG).
2. **`data-entity` из SVG не читается**: сейчас читаем только зоны `data-room-id`. Для Сценария 1
   (DWG→SVG) нужно читать `data-entity` и привязывать сущности напрямую из плана.
3. **arvid_dali_center** не подключён (см. §6).

Актуальный статус и приоритеты — в [CLAUDE.md](../CLAUDE.md) «Статус и дальнейший путь».
