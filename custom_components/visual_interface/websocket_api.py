"""WebSocket API commands for ARVID Visual Interface."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import (
    DOMAIN,
    VERSION,
    WS_TYPE_DEVICES_UPDATE,
    WS_TYPE_LAYOUT_GET,
    WS_TYPE_LAYOUT_SAVE,
    WS_TYPE_PING,
    WS_TYPE_ROOM_UPDATE,
    WS_TYPE_UI_UPDATE,
)
from .storage import LayoutConflict, VisualInterfaceStorage

_LOGGER = logging.getLogger(__name__)


def _get_storage(hass: HomeAssistant) -> VisualInterfaceStorage:
    """Return integration storage instance."""
    return hass.data[DOMAIN]["storage"]


@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_PING})
@callback
def ws_ping(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Health check command for frontend diagnostics."""
    _LOGGER.debug("WebSocket ping received from ARVID frontend")
    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "domain": DOMAIN,
            "version": VERSION,
        },
    )


@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_LAYOUT_GET})
@websocket_api.async_response
async def ws_layout_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return saved ARVID layout/config."""
    _LOGGER.info("WebSocket layout get requested")

    try:
        layout = await _get_storage(hass).async_load()
    except Exception as err:  # noqa: BLE001 - HA should receive clean WS error.
        _LOGGER.exception("Failed to load visual_interface layout")
        connection.send_error(msg["id"], "layout_load_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_LAYOUT_SAVE,
        vol.Required("layout"): dict,
        # Ревизия, на которой клиент строил свою копию (A4). Не совпала — отказ, а не затирание.
        vol.Optional("base_rev"): vol.Any(int, None),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_layout_save(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Save complete ARVID layout/config.

    Admin permission is required because this changes persistent UI data.
    """
    _LOGGER.info("WebSocket layout save requested (base_rev=%s)", msg.get("base_rev"))

    try:
        layout = await _get_storage(hass).async_save(msg["layout"], msg.get("base_rev"))
    except LayoutConflict as conflict:
        # Конфликт — это НЕ сбой: документ изменил другой клиент. Отдаём актуальную версию,
        # чтобы фронт мог показать расхождение, а не молча потерять чужую работу.
        _LOGGER.warning("Layout conflict: %s", conflict)
        connection.send_error(
            msg["id"],
            "layout_conflict",
            str(conflict),
        )
        return
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to save visual_interface layout")
        connection.send_error(msg["id"], "layout_save_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_DEVICES_UPDATE,
        vol.Optional("devices", default=dict): dict,
        vol.Optional("remove", default=list): [str],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_devices_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Точечно обновить расстановку устройств (A4).

    Пишем только переданные entity_id, поэтому параллельная правка других устройств
    (с другого планшета) не теряется — в отличие от layout/save, который писал документ целиком.
    """
    devices = msg.get("devices") or {}
    remove = msg.get("remove") or []
    _LOGGER.info(
        "WebSocket devices update requested: updated=%s removed=%s",
        len(devices),
        len(remove),
    )

    try:
        layout = await _get_storage(hass).async_update_devices(devices, remove)
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to update device layout")
        connection.send_error(msg["id"], "devices_update_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_UI_UPDATE,
        vol.Required("ui"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ui_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Точечно сохранить UI-настройки (тема).

    Раньше смена темы отправляла ВЕСЬ layout из своей вкладки и могла затереть
    расстановку, сохранённую с другого устройства (A4).
    """
    _LOGGER.info("WebSocket UI update requested: keys=%s", list(msg["ui"]))

    try:
        layout = await _get_storage(hass).async_update_ui(msg["ui"])
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to update visual_interface UI settings")
        connection.send_error(msg["id"], "ui_update_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_ROOM_UPDATE,
        vol.Required("area_id"): str,
        vol.Required("room"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_room_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update one room visual config."""
    area_id = msg["area_id"]
    _LOGGER.info("WebSocket room update requested: area_id=%s", area_id)

    try:
        layout = await _get_storage(hass).async_update_room(area_id, msg["room"])
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to update room layout: area_id=%s", area_id)
        connection.send_error(msg["id"], "room_update_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register all WebSocket commands exposed by the integration."""
    _LOGGER.info("Registering visual_interface WebSocket commands")
    websocket_api.async_register_command(hass, ws_ping)
    websocket_api.async_register_command(hass, ws_layout_get)
    websocket_api.async_register_command(hass, ws_layout_save)
    websocket_api.async_register_command(hass, ws_devices_update)
    websocket_api.async_register_command(hass, ws_ui_update)
    websocket_api.async_register_command(hass, ws_room_update)
    _LOGGER.info("visual_interface WebSocket commands registered")
