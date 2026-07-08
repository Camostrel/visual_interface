"""Storage layer for ARVID Visual Interface.

Модуль только загружает и сохраняет наши данные layout/config.
Он не вызывает сервисы Home Assistant и не читает состояния сущностей.
"""

from __future__ import annotations

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

    async def async_load(self) -> LayoutData:
        """Load layout from Home Assistant storage."""
        if self._data is not None:
            _LOGGER.debug("Returning cached visual_interface layout")
            return deepcopy(self._data)

        _LOGGER.info("Loading visual_interface layout from HA storage key=%s", STORAGE_KEY)
        raw = await self._store.async_load()
        self._data = merge_with_defaults(raw)
        _LOGGER.info(
            "Loaded visual_interface layout: floors=%s rooms=%s devices=%s",
            len(self._data.get("floors", {})),
            len(self._data.get("rooms", {})),
            len(self._data.get("devices", {})),
        )
        return deepcopy(self._data)

    async def async_save(self, data: LayoutData) -> LayoutData:
        """Replace complete layout in storage."""
        if not isinstance(data, dict):
            _LOGGER.error("Refusing to save layout: expected dict, got %s", type(data))
            raise ValueError("Layout payload must be an object")

        layout = merge_with_defaults(data)
        layout.setdefault("meta", {})["updated_at"] = _utc_now_iso()

        _LOGGER.info(
            "Saving complete visual_interface layout: floors=%s rooms=%s devices=%s",
            len(layout.get("floors", {})),
            len(layout.get("rooms", {})),
            len(layout.get("devices", {})),
        )
        await self._store.async_save(layout)
        self._data = deepcopy(layout)
        _LOGGER.info("visual_interface layout saved successfully")
        return deepcopy(layout)

    async def async_update_room(self, area_id: str, room_data: dict[str, Any]) -> LayoutData:
        """Update one room visual config."""
        if not area_id:
            _LOGGER.error("Room update failed: empty area_id")
            raise ValueError("area_id is required")

        layout = await self.async_load()
        layout.setdefault("rooms", {})[area_id] = {
            **layout.setdefault("rooms", {}).get(area_id, {}),
            **room_data,
        }
        layout["meta"]["updated_at"] = _utc_now_iso()

        _LOGGER.info("Updating room layout: area_id=%s data_keys=%s", area_id, list(room_data))
        await self._store.async_save(layout)
        self._data = deepcopy(layout)
        return deepcopy(layout)

    async def async_update_device(
        self,
        entity_id: str,
        device_data: dict[str, Any],
    ) -> LayoutData:
        """Update one device visual config."""
        if not entity_id:
            _LOGGER.error("Device update failed: empty entity_id")
            raise ValueError("entity_id is required")

        layout = await self.async_load()
        layout.setdefault("devices", {})[entity_id] = {
            **layout.setdefault("devices", {}).get(entity_id, {}),
            **device_data,
        }
        layout["meta"]["updated_at"] = _utc_now_iso()

        _LOGGER.info(
            "Updating device layout: entity_id=%s data_keys=%s",
            entity_id,
            list(device_data),
        )
        await self._store.async_save(layout)
        self._data = deepcopy(layout)
        return deepcopy(layout)
