# ARVID Visual Interface — HA integration (backend)

Хранилище layout/config для отдельного HTML-фронтенда ARVID Visual Interface.

## Что делает

- Хранит визуальные данные в собственном сторе HA `.storage/visual_interface.layout`:
  координаты устройств на планах, привязки SVG к этажам/комнатам, тему.
- Отдаёт это хранилище через WebSocket-команды `visual_interface/*`.
- **Не** читает состояния сущностей и **не** вызывает сервисы — это делает фронтенд
  через стандартный HA WebSocket (см. DESIGN.md, решение 11).

Собственный домен и стор (не `web_interface`) — чтобы форк развивался независимо от
старого интерфейса и не делил с ним layout.

## Установка на HA

1. Скопировать папку в `/config/custom_components/visual_interface/`.
2. Добавить в `configuration.yaml`:
   ```yaml
   visual_interface:
   ```
3. Перезапустить Home Assistant (config_flow нет — регистрация через yaml).

## WebSocket-команды

| Команда | Права | Назначение |
|---|---|---|
| `visual_interface/ping` | — | health-check, версия backend |
| `visual_interface/layout/get` | — | получить layout |
| `visual_interface/layout/save` | admin | сохранить весь layout |
| `visual_interface/layout/room/update` | admin | обновить одну комнату |
| `visual_interface/layout/device/update` | admin | обновить одно устройство |

> Сохранение под `require_admin` — унаследовано. Тонкая модель прав
> (Viewer/Operator/Editor) — открытый вопрос дизайна (WEB_INTERFACE_API §6).
