"""Constants for ARVID Visual Interface integration."""

from __future__ import annotations

DOMAIN = "visual_interface"
INTEGRATION_NAME = "ARVID Visual Interface"
VERSION = "0.2.0"

# Storage key inside Home Assistant .storage directory.
# Собственный стор (не web_interface.layout) — чистый старт, без мусора старого интерфейса.
STORAGE_KEY = f"{DOMAIN}.layout"
STORAGE_VERSION = 1

# WebSocket command names used by the standalone frontend.
WS_TYPE_LAYOUT_GET = f"{DOMAIN}/layout/get"
WS_TYPE_LAYOUT_SAVE = f"{DOMAIN}/layout/save"
WS_TYPE_ROOM_UPDATE = f"{DOMAIN}/layout/room/update"
# v0.2.0 (долг A4): точечные записи вместо перезаписи всего документа.
# Смена темы больше не отправляет координаты всех устройств, а сохранение расстановки
# пишет только изменённые entity_id — параллельная правка с другого устройства не теряется.
WS_TYPE_DEVICES_UPDATE = f"{DOMAIN}/layout/devices/update"
WS_TYPE_UI_UPDATE = f"{DOMAIN}/layout/ui/update"
WS_TYPE_PING = f"{DOMAIN}/ping"

# Default UI values. Frontend can override them from saved layout.
DEFAULT_COMPANY_NAME = "ARVID"
DEFAULT_BUILDING_NAME = "ARVID Smart Building"
DEFAULT_CITY = "Москва"
