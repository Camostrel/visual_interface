# ARVID Web Interface custom integration v0.1

Минимальная интеграция Home Assistant для хранения layout/config отдельного HTML-интерфейса ARVID.

## Что делает

- хранит JSON layout в HA storage;
- отдаёт layout через WebSocket;
- сохраняет layout через WebSocket;
- пишет логи в журнал Home Assistant.

## Команды WebSocket

- `web_interface/ping`
- `web_interface/layout/get`
- `web_interface/layout/save`
- `web_interface/layout/room/update`
- `web_interface/layout/device/update`

## Подключение

Добавить в `configuration.yaml`:

```yaml
web_interface:
```

После установки папки `custom_components/web_interface` перезапустить Home Assistant.
