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
| Backend (хранилище layout) | `custom_components/web_interface/` | `/config/custom_components/web_interface/` |

Рабочая папка проекта: `/home/user/nicksha/visual_interface/`

> Backend намеренно остаётся под доменом `web_interface` — это то же хранилище layout,
> что и у старого интерфейса (переезд без перенастройки интеграции в HA и без потери layout).
> Целевая модель v1 по DESIGN.md — вообще без своего backend (координаты из SVG);
> до тех пор backend трогаем только при необходимости.

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
  /home/user/nicksha/visual_interface/custom_components/web_interface/ИМЯ \
  root@office.arvid-cloud.ru:/config/custom_components/web_interface/ИМЯ
```

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

## Файлы которые НЕ деплоить

- `js/config.js` с реальным токеном — на диске и в репозитории лежит заглушка
  (`PASTE_LONG_LIVED_ACCESS_TOKEN_HERE`); токен подставляется только на HA.

---

## После деплоя backend

Если менялись файлы `custom_components/web_interface/` (кроме manifest.json и const.py) — перезапустить интеграцию:

**HA → Settings → Devices & Services → ARVID Web Interface → Перезапустить**

---

## Правила процесса (из памяти проекта)

- При деплое — **только заливка файлов**: HA не рестартить, логи не читать без отдельной задачи.
- Запуск прогонов/захватов на железе делает пользователь (SSH может флапать).

---

## Браузер

После деплоя фронтенда — **Ctrl + Shift + R** (хард-рефреш) чтобы сбросить кеш.

Адрес интерфейса: `https://office.arvid-cloud.ru/local/NickSha/visual_interface/index.html`
