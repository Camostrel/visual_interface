"""Constants for ARVID Web Interface integration."""

from __future__ import annotations

DOMAIN = "web_interface"
INTEGRATION_NAME = "ARVID Web Interface"
VERSION = "0.9.2"

# Storage key inside Home Assistant .storage directory.
STORAGE_KEY = f"{DOMAIN}.layout"
STORAGE_VERSION = 1

# WebSocket command names used by the standalone frontend.
WS_TYPE_LAYOUT_GET = f"{DOMAIN}/layout/get"
WS_TYPE_LAYOUT_SAVE = f"{DOMAIN}/layout/save"
WS_TYPE_ROOM_UPDATE = f"{DOMAIN}/layout/room/update"
WS_TYPE_DEVICE_UPDATE = f"{DOMAIN}/layout/device/update"
WS_TYPE_PING = f"{DOMAIN}/ping"

# Default UI values. Frontend can override them from saved layout.
DEFAULT_COMPANY_NAME = "ARVID"
DEFAULT_BUILDING_NAME = "ARVID Smart Building"
DEFAULT_CITY = "Москва"
