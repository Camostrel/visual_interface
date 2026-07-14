"""Storage layer for ARVID Visual Interface.

Модуль только загружает и сохраняет наши данные layout/config.
Он не вызывает сервисы Home Assistant и не читает состояния сущностей.

v0.2.0 — ЗАЩИТА ОТ ПОТЕРИ ДАННЫХ (долг A4):

1. **`asyncio.Lock`.** Раньше load→mutate→save был классическим read-modify-write без
   блокировки: корутина A читала кеш, засыпала на `async_save` (executor-job — реальный yield),
   в это время B читала СТАРЫЙ кеш (A ещё не обновила `self._data`), мутировала его и писала
   поверх A. Изменение A исчезало и с диска, и из кеша.

2. **Ревизия документа (`meta.rev`).** Полная запись (`async_save`) принимает `base_rev` —
   ревизию, на которой клиент строил свою копию. Не совпала → `LayoutConflict`, а не тихая
   перезапись. Сценарий, который это ловит: вкладка открыта с утра; кто-то расставил устройства
   с ноутбука; в старой вкладке жмут «Тема» — и весь документ уезжает поверх свежего.

3. **Точечные записи.** `async_update_ui` (тема) и `async_update_devices` (расстановка) трогают
   ТОЛЬКО свои ключи. Смена темы больше не перезаписывает координаты всех устройств.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import (
    DEFAULT_BUILDING_NAME,
    DEFAULT_CITY,
    DEFAULT_COMPANY_NAME,
    STORAGE_KEY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

LayoutData = dict[str, Any]


class LayoutConflict(Exception):
    """Клиент сохраняет layout, построенный на устаревшей ревизии.

    Несём с собой актуальный документ: клиенту нужно показать расхождение,
    а не гадать, что произошло.
    """

    def __init__(self, expected_rev: int, actual_rev: int, layout: LayoutData) -> None:
        """Store both revisions and the current layout for the client."""
        super().__init__(
            f"Layout был изменён другим клиентом: ожидалась ревизия {expected_rev}, "
            f"в хранилище {actual_rev}"
        )
        self.expected_rev = expected_rev
        self.actual_rev = actual_rev
        self.layout = layout


def _utc_now_iso() -> str:
    """Return current UTC time in ISO format for meta timestamps."""
    return datetime.now(timezone.utc).isoformat()


def default_layout() -> LayoutData:
    """Build default layout structure.

    Схема осознанно простая:
    - HA остаётся источником этажей, помещений, сущностей и friendly-имён;
    - этот стор хранит только визуальные/UI-данные (координаты устройств, тема).
    """
    now = _utc_now_iso()
    return {
        "version": 1,
        "building": {
            "company": DEFAULT_COMPANY_NAME,
            "name": DEFAULT_BUILDING_NAME,
            "city": DEFAULT_CITY,
            "logo": "assets/logo/arvid-logo.svg",
            "default_floor_id": None,
        },
        "floors": {},
        "rooms": {},
        "devices": {},
        "modes": [],
        "ui": {
            "theme": "dark",
            "left_panel_collapsed": False,
            "right_panel_collapsed": False,
        },
        "meta": {
            "created_at": now,
            "updated_at": now,
            # Ревизия документа: растёт на каждую запись, по ней ловим конфликт (A4).
            "rev": 0,
        },
    }


def merge_with_defaults(data: LayoutData | None) -> LayoutData:
    """Merge saved data with defaults to survive schema additions.

    Гибридный shallow/deep merge: сохраняет пользовательские данные при добавлении
    новых полей по умолчанию в будущих версиях схемы.
    """
    base = default_layout()

    if not isinstance(data, dict):
        _LOGGER.warning(
            "visual_interface storage is empty or invalid; using default layout"
        )
        return base

    for key, value in data.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key].update(value)
        else:
            # ⚠ Клиент мог прислать meta = null (или строку). Раньше это ложилось в стор как есть,
            # а следующий `layout["meta"][...]` падал с TypeError на валидной по схеме нагрузке.
            if key in ("meta", "ui", "building") and not isinstance(value, dict):
                _LOGGER.warning(
                    "visual_interface: поле %r пришло не словарём (%s) — берём значение по умолчанию",
                    key,
                    type(value).__name__,
                )
                continue
            base[key] = value

    return base


class VisualInterfaceStorage:
    """Small wrapper around Home Assistant Store with logging."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize storage wrapper."""
        self.hass = hass
        self._store: Store[LayoutData] = Store(
            hass,
            STORAGE_VERSION,
            STORAGE_KEY,
        )
        self._data: LayoutData | None = None
        # Один замок на все операции чтения-модификации-записи (A4).
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Чтение
    # ------------------------------------------------------------------

    async def async_load(self) -> LayoutData:
        """Load layout from Home Assistant storage."""
        async with self._lock:
            return await self._load_locked()

    async def _load_locked(self) -> LayoutData:
        """Загрузка под замком: холодный кеш читаем только один раз."""
        if self._data is not None:
            _LOGGER.debug("Returning cached visual_interface layout")
            return deepcopy(self._data)

        _LOGGER.info("Loading visual_interface layout from HA storage key=%s", STORAGE_KEY)
        raw = await self._store.async_load()
        self._data = merge_with_defaults(raw)
        _LOGGER.info(
            "Loaded visual_interface layout: floors=%s rooms=%s devices=%s rev=%s",
            len(self._data.get("floors", {})),
            len(self._data.get("rooms", {})),
            len(self._data.get("devices", {})),
            self._data.get("meta", {}).get("rev"),
        )
        return deepcopy(self._data)

    # ------------------------------------------------------------------
    # Запись (всё под одним замком)
    # ------------------------------------------------------------------

    async def _commit_locked(self, layout: LayoutData) -> LayoutData:
        """Записать документ, подняв ревизию. Вызывать только под `self._lock`."""
        meta = layout.setdefault("meta", {})
        meta["updated_at"] = _utc_now_iso()
        meta["rev"] = int(meta.get("rev") or 0) + 1

        await self._store.async_save(layout)
        self._data = deepcopy(layout)

        _LOGGER.info(
            "visual_interface layout saved: rev=%s floors=%s rooms=%s devices=%s",
            meta["rev"],
            len(layout.get("floors", {})),
            len(layout.get("rooms", {})),
            len(layout.get("devices", {})),
        )
        return deepcopy(layout)

    async def async_save(
        self,
        data: LayoutData,
        base_rev: int | None = None,
    ) -> LayoutData:
        """Replace complete layout in storage.

        `base_rev` — ревизия, на которой клиент строил свою копию. Если она отстала,
        значит документ уже изменили: отказываемся (LayoutConflict), а не затираем чужое.
        """
        if not isinstance(data, dict):
            _LOGGER.error("Refusing to save layout: expected dict, got %s", type(data))
            raise ValueError("Layout payload must be an object")

        async with self._lock:
            current = await self._load_locked()
            current_rev = int(current.get("meta", {}).get("rev") or 0)

            if base_rev is not None and int(base_rev) != current_rev:
                _LOGGER.warning(
                    "Отклоняем полную запись layout: клиент на ревизии %s, в хранилище %s",
                    base_rev,
                    current_rev,
                )
                raise LayoutConflict(int(base_rev), current_rev, current)

            layout = merge_with_defaults(data)
            # Ревизию задаёт сервер, а не клиент.
            layout.setdefault("meta", {})["rev"] = current_rev

            _LOGGER.info("Saving complete visual_interface layout (rev %s)", current_rev)
            return await self._commit_locked(layout)

    async def async_update_ui(self, ui_data: dict[str, Any]) -> LayoutData:
        """Точечно обновить UI-настройки (тема).

        Отдельная команда именно для того, чтобы смена темы НЕ отправляла весь документ:
        раньше она перезаписывала координаты всех устройств снимком из своей вкладки (A4).
        """
        if not isinstance(ui_data, dict):
            raise ValueError("ui payload must be an object")

        async with self._lock:
            layout = await self._load_locked()
            ui = layout.setdefault("ui", {})
            if not isinstance(ui, dict):
                ui = layout["ui"] = {}
            ui.update(ui_data)

            _LOGGER.info("Updating visual_interface UI settings: keys=%s", list(ui_data))
            return await self._commit_locked(layout)

    async def async_update_devices(
        self,
        devices: dict[str, Any] | None = None,
        remove: list[str] | None = None,
    ) -> LayoutData:
        """Точечно обновить расстановку устройств (координаты) и/или убрать их из layout.

        Пишем ТОЛЬКО переданные entity_id — параллельная правка других устройств
        (с другого планшета) не теряется.
        """
        devices = devices or {}
        remove = remove or []

        if not isinstance(devices, dict):
            raise ValueError("devices payload must be an object")

        async with self._lock:
            layout = await self._load_locked()
            stored = layout.setdefault("devices", {})
            if not isinstance(stored, dict):
                stored = layout["devices"] = {}

            for entity_id, device_data in devices.items():
                if not isinstance(device_data, dict):
                    _LOGGER.warning("Пропускаем устройство %s: ожидался объект", entity_id)
                    continue
                stored[entity_id] = {**stored.get(entity_id, {}), **device_data}

            for entity_id in remove:
                stored.pop(entity_id, None)

            _LOGGER.info(
                "Updating device layout: updated=%s removed=%s",
                len(devices),
                len(remove),
            )
            return await self._commit_locked(layout)

    async def async_update_room(self, area_id: str, room_data: dict[str, Any]) -> LayoutData:
        """Update one room visual config."""
        if not area_id:
            _LOGGER.error("Room update failed: empty area_id")
            raise ValueError("area_id is required")

        async with self._lock:
            layout = await self._load_locked()
            rooms = layout.setdefault("rooms", {})
            if not isinstance(rooms, dict):
                rooms = layout["rooms"] = {}
            rooms[area_id] = {**rooms.get(area_id, {}), **room_data}

            _LOGGER.info("Updating room layout: area_id=%s data_keys=%s", area_id, list(room_data))
            return await self._commit_locked(layout)
