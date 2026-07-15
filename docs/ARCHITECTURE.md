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
| `js/ha-ws.js` | `ArvidHaWebSocket` | WS-соединение, auth, **реконнект + восстановление подписок** (v0.11.0), статус связи, `send`/`callService`/`subscribeCommand` | `ARVID_CONFIG`, `ARVID_LOG` |
| `js/floorplan-storage.js` | `ArvidFloorplanStorage` | клиент нашего backend; **точечные записи** `updateUi`/`updateDevices` (v0.11.0) | `ArvidHaWebSocket` |
| `js/ha-registry.js` | `ArvidHaRegistry` | реестры + states, **индексы `area_id`/`device_id`** (v0.11.0), подписка на изменения реестров, сигнал «состав изменился» | `ArvidHaWebSocket` |
| `js/health.js` | `ArvidHealth` | здоровье устройств от ядра DALI (`health_subscribe`, push): снимок, индексы area/device/entity, фолбэк-поллинг | `ArvidHaWebSocket`, `ArvidHaRegistry` |
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
ARVID_APP.health    ArvidHealth        — снимок здоровья от ядра DALI (push health_subscribe)

ARVID_APP.entitiesForArea(areaId)        — СОСТАВ комнаты (истина HA)
ARVID_APP.placedEntitiesForRoom(areaId)  — размещённые на плане (наш layout) → маркеры
ARVID_APP.entitiesForRoom(areaId)        — объединение, ТОЛЬКО фильтр «свои события»
ARVID_APP.isUnassignedInRoom(id, areaId) — стоит на плане, но в HA к комнате не привязано
ARVID_APP.lightGroupState(objectId)      — HA-группа света: light.<area_id|floor_id|all>

ARVID_RUNTIME.ensureData()             — ленивая инициализация (идемпотентна)
ARVID_RUNTIME.addStateHandler(fn)      — подписка на state_changed без дублей
```

## 3. Потоки данных

### 3.1 Запуск (v0.11.4 — мгновенная отрисовка из снапшота)
```
index.html
  → new ArvidSpaApp().init()
    → routeFromLocation() → showView(view) → getPage(view).init(params)
      → ARVID_RUNTIME.ensureData() → loadData():
          ArvidHaWebSocket.connect()          (auth по токену; быстро, всегда первым)
          ── есть снимок в localStorage? ─────────────────────────────────────
          ДА  → registry.applyData(снимок)    гидратация реестра + индексы
                ARVID_APP.layout = снимок      ARVID_APP.live = false
                return  ← СТРАНИЦА РИСУЕТ ПЛАН СРАЗУ
                refreshLive() в фоне: loadLive() → notifyComposition() → перерисовка живыми
          НЕТ → await loadLive()               (первый запуск/другая версия)
                ARVID_APP.live = true; return
      → page рендерит план и панели

loadLive():  storage.ping() → registry.loadAll() (get_states + 4 реестра ОДНИМ залпом)
             → subscribeRegistryUpdates() (один раз) → getLayout() → writeSnapshot()
```
**Снимок** (`arvid.snapshot.v1` в localStorage) = реестры + состояния + layout, привязан к
`ARVID_CONFIG.VERSION` (деплой инвалидирует). Только для ПЕРВОЙ отрисовки — живые данные из HA
тут же перекрывают. Переживает пересоздание iframe в дашборде HA (главный кейс). Превышен лимит
localStorage → снимок не пишется, работаем как раньше (полная загрузка). Кеш файлов (`?v=`) —
это отдельный слой (не скачивать байты повторно), снимок — про мгновенную ОТРИСОВКУ.

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

### 3.4 Подсветка зон и режимы карты (v0.8.0)

Ключевая идея: **JS не знает о режиме**. Он всегда вешает на зону все классы состояния,
а видимый слой выбирает CSS по `data-map-mode` на `.svg-stage`. Смена режима = один атрибут.

```
state_changed → ArvidFloorPage.handleStateChanged()   (rAF-коалесценция)
health-снимок → ArvidHealth._onUpdate → applyHealthToUi()
  → applyZoneStateClasses()
    → для каждой .room-zone[data-room-id] один вызов getRoomStats(areaId):
        hasLightOn    → .has-light-on   группа light.<area_id>, иначе «горит любая лампа состава»
        motionActive  → .has-motion     сработал ЛЮБОЙ датчик движения помещения
        offlineCount  → .has-offline    health: lamp_offline/lamp_unknown/sensor_unknown/panel_unknown
        anomalyCount  → .has-anomaly    health: motion_stuck/motion_idle/lux_stale
```

| Режим (`data-map-mode`) | Что видно |
|---|---|
| `light` | `.has-light-on` — прозрачный оранжевый |
| `presence` | `.has-motion` — зелёный (свет игнорируется) |
| `diagnostics` | линии плана серые; `.has-offline` — красный пульс; `.has-anomaly` — янтарный |

`gw_offline` к помещению не привязан → идёт строкой в «Предупреждения», не в зону.

> `bindRoomZones()` вызывается только при загрузке плана, НЕ по `state_changed`.

### 3.5 Здоровье устройств (режим «Диагностика», «Предупреждения»)
```
ArvidFloorPage.initHealth() → ARVID_APP.health.start()
  → WS arvid_dali_center/health_subscribe        (read-only, без require_admin, ядро ≥ v1.1.1)
      снимок сразу + push на каждый пересчёт оценщика ядра. Таймеров нет.
  → indexActive(): kind → severity (offline | anomaly | gateway)
      byAreaId (зоны) · byDeviceId (маркер, пара ms_/il_) · byEntityId (сущность)
  → _onUpdate → applyZoneStateClasses() + renderFloorWarnings()

фолбэк (unknown_command = старое ядро):
  → health_data + startPolling(300 с; 30 с в «Диагностике»; пауза при hidden)
временная ошибка (not_found / обрыв):
  → повтор подписки через 60 с
```

**Своей логики offline у интерфейса нет** — таксономию ведёт ядро (его `docs/HEALTH.md`).

Свойства контракта, которые определяют дизайн:
- **Подписка, а не поллинг.** `health_data` **форсирует полный пересчёт** здоровья на каждый
  запрос (обход всех устройств всех шлюзов + резолв трёх реестров на каждое, синхронно в петле HA).
  Две вкладки = два прохода. `health_subscribe` пересчёт не вызывает — отдаёт результат чужого.
- **Грейс `interval_min` (5 мин) — только для УСТРОЙСТВ.** У `gw_offline` грейса нет: оценщик
  ставит его через ~1.5 с после сигнала связи. Поэтому «шлюз упал» — срочное событие, и именно его
  поллинг задерживал сильнее всего (до 300 с). Это была фактическая ошибка в нашем D18.
- **Пара движение+люкс = одно устройство, две записи** (`0201`/`0202`): разные `entity_id`, общий
  `device_id`. Маркер на плане один → сопоставлять по **`device_id`**.
- **`area_id` есть** (ядро v1.1.1), но фолбэк резолва **по имени** оставлен: первые ≤15 с после
  рестарта HA `active` отдаётся из персиста в старой форме, без новых полей.

Ядра может не быть: `unknown_command` на обоих путях → модуль выключается, «Диагностика» без
данных, остальные режимы работают.

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
| `visual_interface/layout/get` | — | `{layout}` (несёт `meta.rev` — ревизию документа) |
| `visual_interface/layout/save` | admin | `{layout}`; принимает `base_rev` → при расхождении ошибка `layout_conflict` |
| `visual_interface/layout/ui/update` | admin | `{layout}` — **только `ui`** (тема). v0.2.0 |
| `visual_interface/layout/devices/update` | admin | `{layout}` — **только переданные устройства**. v0.2.0 |
| `visual_interface/layout/room/update` | admin | `{layout}` |

> **Почему точечные записи (v0.2.0, долг A4).** Раньше фронт всегда слал ВЕСЬ документ:
> смена темы на планшете со старой вкладкой затирала расстановку, сохранённую с ноутбука.
> Плюс backend делал read-modify-write без блокировки. Теперь: `asyncio.Lock`, ревизия `meta.rev`,
> и запись только своих ключей.

Стор `visual_interface.layout` (структура): `building`, `floors`, `rooms`, `devices` (координаты),
`ui.theme`, `meta`. HA остаётся источником этажей/комнат/сущностей — backend их НЕ дублирует.

## 5.5 Планы этажей: два пути координат (v0.10.0)

| Путь | Координаты | Элемент в DOM | Для чего |
|---|---|---|---|
| **Расстановка** | наш стор `layout.devices` | `.device-marker` | частные объекты (десятки устройств) |
| **План** | сам SVG (`data-entity`) | `.device-node` | продакшн: чертёж из CAD (сотни устройств) |

Пути независимы и сосуществуют на одном экране.

**Конвейер плана** (вне рантайма, `tools/`, см. [SVG_PLAN_SPEC.md](SVG_PLAN_SPEC.md)):
```
AutoCAD → PDF → SVG (Inkscape)
  → tools/plan_convert.py   имя из подписи «L 1.12.31» → data-entity="light.l_1_12_31"
                            цвета → currentColor; CAD-трансформации схлопнуты; мусор вычищен
  → assets/floors/<floor_id>.svg
  → tools/plan_rooms.py     мини-планы комнат по зонам → assets/rooms/<area_id>.svg
```
Зоны помещений (`.room-zone[data-room-id]`, id = `area_id`) рисуются **вручную**: из
несвязанных отрезков стен замкнутые контуры не выводятся, а соответствие «полигон ↔ area»
машине неоткуда взять.

**Зум (Фаза 3.5):** элементы устройств уже в DOM, поэтому «разбиение помещения на лампы» —
класс `is-zoomed` на `.svg-stage` по колбэку `onZoom`, а не перерисовка. Порог 2.2×.
Ниже порога помещение показывает агрегат (зона), выше — солируют устройства.

## 6. Внешние зависимости

- **HA WebSocket** `/api/websocket`: `auth`, `get_states`, `config/floor_registry/list`,
  `config/area_registry/list`, `config/entity_registry/list`, `config/device_registry/list`,
  `call_service`, `subscribe_events(state_changed)`.
- **Наш backend** `visual_interface/*` (см. §5).
- **arvid_dali_center** (ядро DALI, требуется **≥ v1.1.1** для push): в основном косвенно — через
  стандартные сущности `light./sensor./event.`. **Прямые вызовы:** `health_subscribe` (основной,
  push) и `health_data` (фолбэк для старого ядра) — оба read-only, без `require_admin`.
  Остальной read-only WS (`gateways`, `groups`, `energy_*`, `events_subscribe`) не вызываем.
  См. `WEB_INTERFACE_API.md` и `DEBT.md` (D14).
- Внешних JS-библиотек нет. View Transitions, WebSocket, SVG — нативные.

## 7. Ключевые инварианты

- **Одно WS-соединение** на весь SPA (в `ARVID_APP.ha`), одна подписка на `state_changed`.
- **Реальное состояние** из HA, без оптимистичного UI (DESIGN реш. 12).
- **DOM не перестраивается по `state_changed`** — только значения и классы (v0.6.0).
- **Состав комнаты — истина HA** (`entitiesForArea`), расстановка на плане — отдельно (v0.7.0).
- **Свет — только через HA-группы** `light.<area_id|floor_id|all>`, не поиском ламп (v0.6.x).
- **Группы света — не устройства** (v0.9.0): не лампы, не в карточках, не на плане.
  Признак — `model === "DALI Group"` у устройства либо список членов в атрибутах.
- **Здоровье устройств — истина ядра DALI** (push `health_subscribe`, фолбэк `health_data`).
  Свою логику offline/аварий не пишем: ядро уже следит за устройствами (v0.8.0).
- **Режим карты — только CSS-слой.** JS вешает все классы состояния всегда; `data-map-mode`
  выбирает видимый. Никакой ветки «если режим X — считать Y» в JS (v0.8.0).
- **Координаты** — в системе viewBox SVG, не в пикселях экрана.
- **REST** как основной путь не используем — только WebSocket.
- **Скоуп**: `light` / `sensor` (пара ms_+il_) / `panel`. Вне-скоупные сущности не рисуются
  (фильтр `getScopedEntities` / `isScopedState`).
- **Токен** не хранится в репозитории (в `config.js` заглушка, подставляется на HA при деплое).
- **Резолв area/device — через индексы реестра** (`entityIdsByArea`/`entityIdsByDevice`), не
  `states.filter(...)`: на объекте это O(N) в горячем пути, в цикле — O(N²) (v0.11.0, D20).
- **Состав ≠ состояние.** Значение меняется потоком (`state_changed`, без перестроения DOM);
  СОСТАВ (появление/пропажа сущности, смена area) — редко, через `addCompositionHandler`,
  и там полная перерисовка уместна (v0.11.0, D5).
- **Не отправлять весь layout.** Тема → `layout/ui/update`, расстановка → `layout/devices/update`
  (только изменённые `entity_id`). Полная запись обязана слать `base_rev` (v0.11.0, A4).
- **Связь с HA переживает обрыв** (v0.11.0, A3): реконнект, восстановление подписок, видимая
  плашка «нет связи». Застывшая картинка, которая выглядит рабочей, опаснее честного отказа.
- **Тап vs перетаскивание — по сдвигу пальца** (порог 8px), а не по цели нажатия (v0.11.1):
  зоны и лампы плана тапабельны И перетаскиваемы. Полламповый тап на плане КОМНАТЫ = toggle лампы.

## 8. Техдолг

Полный реестр долгов и открытых вопросов — **[DEBT.md](DEBT.md)** (с приоритетами P1–P3
и задачами на стороне HA).

Архитектурно-значимые (P1):
1. **D1 — загрузка «всё сразу»**: `loadAll()` + глобальный `subscribe_events(state_changed)`.
   На ~4400 устройств стоп-фактор. Целевое (DESIGN реш. 13): `subscribe_entities` по сегменту.
2. **D2 — `data-entity` из SVG не читается**: сейчас только зоны `data-room-id`.
   Нужен для Сценария 1 (конвейер DWG→SVG).

Фазы и приоритеты — в [ROADMAP.md](ROADMAP.md).
