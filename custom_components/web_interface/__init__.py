"""ARVID Web Interface integration.

v0.1 goal:
- provide HA storage for standalone HTML frontend layout/config;
- expose this storage via custom Home Assistant WebSocket commands;
- keep Home Assistant entity data and service calls on the frontend side.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, VERSION
from .storage import WebInterfaceStorage
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up ARVID Web Interface from configuration.yaml."""
    _LOGGER.info("Setting up %s v%s", DOMAIN, VERSION)

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["storage"] = WebInterfaceStorage(hass)

    async_register_websocket_commands(hass)

    _LOGGER.info("%s setup completed", DOMAIN)
    return True
