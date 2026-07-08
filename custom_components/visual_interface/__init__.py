"""ARVID Visual Interface integration.

Задачи backend:
- хранить layout/config отдельного HTML-фронтенда в HA storage (собственный стор);
- отдавать это хранилище через кастомные WebSocket-команды visual_interface/*;
- НЕ читать состояния сущностей и НЕ вызывать сервисы — это делает фронтенд
  через стандартный HA WebSocket (см. DESIGN.md, решение 11).
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, VERSION
from .storage import VisualInterfaceStorage
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up ARVID Visual Interface from configuration.yaml."""
    _LOGGER.info("Setting up %s v%s", DOMAIN, VERSION)

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["storage"] = VisualInterfaceStorage(hass)

    async_register_websocket_commands(hass)

    _LOGGER.info("%s setup completed", DOMAIN)
    return True
