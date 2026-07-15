# Инструкция по деплою — ARVID Visual Interface

## Подключение к HA

### Схема

```
Claude Code хост (этот)
    └── SSH / SCP
          └── office.arvid-cloud.ru:2222  (публичный домен)
                └── VPS → DNAT
                      └── 10.10.0.2:22  (Home Assistant)
```

### Параметры

```
Host:    office.arvid-cloud.ru
Port:    2222
User:    root
Key:     ~/.ssh/id_ed25519
Cipher:  aes256-ctr
MAC:     hmac-sha2-256-etm@openssh.com
```

Проверка соединения:
```bash
ssh -i ~/.ssh/id_ed25519 \
  -p 2222 \
  -o Ciphers=aes256-ctr \
  -o MACs=hmac-sha2-256-etm@openssh.com \
  -o StrictHostKeyChecking=no \
  root@office.arvid-cloud.ru "echo OK"
```

---

## Директории

| Тип | Локально (этот хост) | На HA |
|-----|----------------------|-------|
| Frontend | `www/visual_interface/` | `/config/www/NickSha/visual_interface/` |
| Backend (своя интеграция) | `custom_components/visual_interface/` | `/config/custom_components/visual_interface/` |

Рабочая папка проекта: `/home/user/nicksha/visual_interface/`

> Backend — собственная HA-интеграция (домен `visual_interface`, свой стор
> `visual_interface.layout`), независимая от старого `web_interface`. Хранит только
> layout (координаты устройств для частных объектов, привязки SVG, тема).

---

## Команда scp — критически важно

HA SSH-сервер **не поддерживает SFTP** → обязателен флаг `-O` (legacy SCP protocol).
Явные `Ciphers`/`MACs` обязательны — дефолтные алгоритмы ломаются через WireGuard («Corrupted MAC on input»).

**ВСЕГДА указывать полный путь назначения включая имя файла**, иначе scp создаст мусорный файл с именем локального пути.

```bash
# ПРАВИЛЬНО — явное имя файла в назначении
scp -O -P 2222 \
  -i ~/.ssh/id_ed25519 \
  -o Ciphers=aes256-ctr \
  -o MACs=hmac-sha2-256-etm@openssh.com \
  -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/www/visual_interface/js/файл.js \
  root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/js/файл.js

# НЕПРАВИЛЬНО — только директория в назначении (создаст мусорный файл)
scp -O ... файл.js root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/js/
```

---

## Шаблоны команд по типу файла

### CSS
```bash
scp -O -P 2222 -i ~/.ssh/id_ed25519 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/www/visual_interface/css/ИМЯ.css \
  root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/css/ИМЯ.css
```

### JS
```bash
scp -O -P 2222 -i ~/.ssh/id_ed25519 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/www/visual_interface/js/ИМЯ.js \
  root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/js/ИМЯ.js
```

### HTML
```bash
scp -O -P 2222 -i ~/.ssh/id_ed25519 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/www/visual_interface/index.html \
  root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/index.html
```

### SVG (assets/rooms)
```bash
scp -O -P 2222 -i ~/.ssh/id_ed25519 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/www/visual_interface/assets/rooms/ИМЯ.svg \
  root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/assets/rooms/ИМЯ.svg
```

### SVG (assets/floors)
```bash
scp -O -P 2222 -i ~/.ssh/id_ed25519 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/www/visual_interface/assets/floors/ИМЯ.svg \
  root@office.arvid-cloud.ru:/config/www/NickSha/visual_interface/assets/floors/ИМЯ.svg
```

### Backend (manifest.json / const.py / *.py)
```bash
scp -O -P 2222 -i ~/.ssh/id_ed25519 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  /home/user/nicksha/visual_interface/custom_components/visual_interface/ИМЯ \
  root@office.arvid-cloud.ru:/config/custom_components/visual_interface/ИМЯ
```

### Первичная установка backend (разово, делает пользователь)

Интеграция без config_flow — регистрируется через `configuration.yaml`:

1. Залить папку `custom_components/visual_interface/` на HA (scp/tar).
2. Добавить в `/config/configuration.yaml` строку:
   ```yaml
   visual_interface:
   ```
3. Перезапустить Home Assistant (Settings → System → Restart).
4. Проверить: фронтенд открывается, в консоли нет ошибки `visual_interface/ping`.

---

## Проверка после деплоя

```bash
# Проверить версию фронтенда
ssh -i ~/.ssh/id_ed25519 -p 2222 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  root@office.arvid-cloud.ru "grep VERSION /config/www/NickSha/visual_interface/js/config.js"

# Проверить содержимое файла (например, последние строки CSS)
ssh -i ~/.ssh/id_ed25519 -p 2222 -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256-etm@openssh.com -o StrictHostKeyChecking=no \
  root@office.arvid-cloud.ru "tail -5 /config/www/NickSha/visual_interface/css/shell.css"
```

---

## `js/config.js` — деплой с сохранением токена (v0.11.3)

В репозитории/на диске лежит **заглушка** токена (`PASTE_LONG_LIVED_ACCESS_TOKEN_HERE`), на HA —
реальный. Раньше config.js вообще не заливали (правили только `VERSION` через `sed`), из-за чего
**код** config.js на сервере оставался старым (например, `LOG_LEVEL` не обновлялся). Теперь
заливаем нормально, но **токен берём из уже лежащего на сервере файла** — он не покидает сервер
и не печатается:

```bash
DST=/config/www/NickSha/visual_interface/js
scp -O …опции… www/visual_interface/js/config.js root@office.arvid-cloud.ru:$DST/config.js.new
ssh …опции… root@office.arvid-cloud.ru "python3 - <<'PY'
import re
d='$DST'
new=open(d+'/config.js.new').read(); old=open(d+'/config.js').read()
m=re.search(r'HA_TOKEN:\s*\"([^\"]*)\"', old)
assert m and 'PASTE_' not in m.group(1), 'нет реального токена в текущем config.js — прерываю'
new=re.sub(r'(HA_TOKEN:\s*\")[^\"]*(\")', lambda x: x.group(1)+m.group(1)+x.group(2), new, count=1)
open(d+'/config.js','w').write(new)
PY
rm -f $DST/config.js.new"
```
Проверка после: `grep -q PASTE_LONG_LIVED $DST/config.js && echo ЗАГЛУШКА-!!! || echo OK`.

## Кеширование в HA (важно): `?v=версия`

HA отдаёт `/local/` с `Cache-Control: public, max-age=2678400` (**31 день**) — браузер держит
старые JS/CSS/SVG месяц, поэтому в iframe HA виснет старая версия (лечилось только Ctrl+Shift+R /
инкогнито). Заголовок ставит сам HA, из наших файлов не убрать.

**Решение — разбиватель кеша по версии.** У всех ассетов в URL стоит `?v=<версия>`:
- `js/config.js → APP_VERSION` (единственный источник; `localAsset` вешает `?v` на SVG/иконки/лого);
- `index.html` — метки `?v=vX.Y.Z` на каждом `<link>`/`<script>`;
- планы больше НЕ грузятся с `force-cache` (это держало план старым).

**При каждом деплое** синхронно поднять версию в двух местах (иначе часть ассетов не обновится):
```bash
V=v0.11.4   # новая версия
sed -i -E "s/(APP_VERSION = \")v[0-9.]+(\")/\1$V\2/" www/visual_interface/js/config.js
sed -i -E "s/(\?v=)v[0-9.]+/\1$V/g"                 www/visual_interface/index.html
sed -i -E "s/(VERSION: \")v[0-9.]+(\")/\1$V\2/"     www/visual_interface/js/config.js  # если где-то ещё
```
(и обычный bump в CHANGELOG). Дальше — залить `index.html` и `config.js` (с токеном, см. выше).

**Как это видно у пользователя:**
- **Первый раз после включения схемы** — один Ctrl+Shift+R (текущий кешированный index.html без `?v`).
- **Дальше:** после деплоя перезагрузить страницу HA (**F5**) — iframe ревалидирует index.html,
  видит новые `?v` и тянет свежие ассеты. Таймеров/автоперезагрузки нет (по требованию).
- Гарантированный ручной рычаг: добавить `?v=` в `url` iframe дашборда и менять его, либо Ctrl+Shift+R.

---

## После деплоя backend

Если менялись Python-файлы `custom_components/visual_interface/` — перезапустить HA
(интеграция без config_flow, отдельной «перезагрузки» в UI нет). Рестарт делает пользователь.

---

## Правила процесса (из памяти проекта)

- При деплое — **только заливка файлов**: HA не рестартить, логи не читать без отдельной задачи.
- Запуск прогонов/захватов на железе делает пользователь (SSH может флапать).

---

## Браузер

После деплоя фронтенда — **Ctrl + Shift + R** (хард-рефреш) чтобы сбросить кеш.

Адрес интерфейса: `https://office.arvid-cloud.ru/local/NickSha/visual_interface/index.html`
