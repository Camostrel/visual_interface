"""WebSocket API commands for ARVID Web Interface."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import (
    DOMAIN,
    VERSION,
    WS_TYPE_DEVICE_UPDATE,
    WS_TYPE_LAYOUT_GET,
    WS_TYPE_LAYOUT_SAVE,
    WS_TYPE_PING,
    WS_TYPE_ROOM_UPDATE,
)
from .storage import WebInterfaceStorage

_LOGGER = logging.getLogger(__name__)


def _get_storage(hass: HomeAssistant) -> WebInterfaceStorage:
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
        _LOGGER.exception("Failed to load web_interface layout")
        connection.send_error(msg["id"], "layout_load_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_LAYOUT_SAVE,
        vol.Required("layout"): dict,
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
    _LOGGER.info("WebSocket layout save requested")

    try:
        layout = await _get_storage(hass).async_save(msg["layout"])
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to save web_interface layout")
        connection.send_error(msg["id"], "layout_save_failed", str(err))
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


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_DEVICE_UPDATE,
        vol.Required("entity_id"): str,
        vol.Required("device"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_device_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update one device visual config."""
    entity_id = msg["entity_id"]
    _LOGGER.info("WebSocket device update requested: entity_id=%s", entity_id)

    try:
        layout = await _get_storage(hass).async_update_device(entity_id, msg["device"])
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to update device layout: entity_id=%s", entity_id)
        connection.send_error(msg["id"], "device_update_failed", str(err))
        return

    connection.send_result(msg["id"], {"layout": layout})


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register all WebSocket commands exposed by the integration."""
    _LOGGER.info("Registering web_interface WebSocket commands")
    websocket_api.async_register_command(hass, ws_ping)
    websocket_api.async_register_command(hass, ws_layout_get)
    websocket_api.async_register_command(hass, ws_layout_save)
    websocket_api.async_register_command(hass, ws_room_update)
    websocket_api.async_register_command(hass, ws_device_update)
    _LOGGER.info("web_interface WebSocket commands registered")
