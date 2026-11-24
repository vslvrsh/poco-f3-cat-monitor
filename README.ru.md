<div align="center">

# PurrCam («КотоНяня»)

**Домашняя видеоняня для кота на базе Poco F3 (или любого Android-смартфона): переключение всех объективов включая ширик `0.6×`, сверхнизкая задержка WebRTC, приложение Android в стиле Material 3 Expressive, веб-монитор и нативный лаунчер `PurrCam.exe` для Windows.**

**[🇺🇸 English](README.md) · [🇷🇺 Русский гайд](README.ru.md)**

[![Kotlin](https://img.shields.io/badge/Android-Kotlin%20%2B%20Compose%20M3%20Expressive-7F52FF?logo=kotlin&logoColor=white)](android/)
[![WebRTC](https://img.shields.io/badge/Streaming-Camera2%20%2B%20WebRTC-10B981?logo=webrtc&logoColor=white)](protocol/PROTOCOL.md)
[![React](https://img.shields.io/badge/Web%20UI-React%2019%20%2B%20TypeScript-61DAFB?logo=react&logoColor=black)](web/)
[![Windows](https://img.shields.io/badge/Desktop-Windows%20PurrCam.exe-0078D6?logo=windows&logoColor=white)](server/desktop-launcher/)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B.svg)](LICENSE)

</div>

---

## Возможности

- **Один APK для обоих телефонов (Режим камеры + Режим монитора)**
  Установите одно приложение в стиле **Material 3 Expressive** (Dynamic Color на Android 12+, удобные вкладки, пинч-зум, обратная голосовая связь, сохранение фото в Галерею) и на **Poco F3** (Камера), и на **основной смартфон** (Монитор).
- **Настоящий ширик `0.6×` на Poco F3 / Xiaomi через Camera2**
  Вместо стандартного WebRTC-перечислителя используется собственный движок Camera2, напрямую опрашивающий вспомогательные (aux) ID и физические камеры (`physicalCameraIds`) с классификацией по **35-мм эквиваленту фокусного расстояния** (`36 × f / sensorWidth`). Доступно мгновенное переключение **`0.6× Wide` (ширик)**, **`1× Main`**, **`Macro`** и **`Front`** прямо во время стрима без разрыва WebRTC.
- **Защита AMOLED-экрана 24/7 и опциональный Root-контроль**
  - Полностью чёрный `#000000` режим **AMOLED Blackout** с защитой от лап кота (разблокировка долгим нажатием 1,5 сек или тройным тапом).
  - С root (**KernelSU / Magisk**): аппаратное отключение подсветки в **0 нит** (`/sys/class/backlight/*/brightness` с автовосстановлением) и **ограничение заряда 80%** (пауза зарядки на 80%, возобновление на 70% через sysfs контроллера батареи).
- **Нативный центр управления Windows (`PurrCam.exe`) + трей**
  Запуск сервера в фоне одним кликом, защита от засыпания ПК (`Keep PC Awake`), окно монитора, управление удалённым доступом без VPN, USB `adb reverse` и сворачивание в системный трей.
- **Удалённый доступ по 4G/5G в 1 клик — без VPN, без аккаунтов и без обрывов**
  - **Мультипровайдерный туннель `Auto (No VPN)`**: использует встроенный в Windows OpenSSH (`localhost.run` → автопереключение на `Pinggy :443` → `Cloudflare HTTP/2`) с проверкой доступности каждые 30 сек и автоматическим перезапуском при обрывах.
  - **Зашифрованный авто-маяк (Auto-Sync Beacon)**: публикует новый адрес туннеля в шифрованном виде **AES-256-GCM** (ключ из вашего 192-битного токена) на `ntfy.sh` и `ntfy.envs.net` — привязанные телефоны и браузер сам находят обновлённый URL без повторной привязки!
  - **Автоматический HTTPS/WebSocket видео-релей (`ws_relay`)**: если мобильный оператор (строгий CGNAT) блокирует WebRTC/UDP, PurrCam за 6 секунд сам переключается на передачу видео через тот же TCP 443 HTTPS-туннель (`LIVE · HTTPS Relay`) — без TURN-аккаунтов и без VPN!
- **Стабильность 24/7**: убран 6-часовой системный таймаут Android 15–17 (`DATA_SYNC`), добавлено мгновенное переподключение при смене сети (`NetworkCallback`), исключение из оптимизации батареи (автоматически с KernelSU root), автоперезапуск зависшей Camera2 и 45-секундный допуск heartbeat.

---

## Быстрая установка (из GitHub Releases)

### 1. ПК-сервер для Windows (`PurrCam-Windows-v1.1.0.zip`)
> **Требование**: установленный [Node.js 20+](https://nodejs.org/).

1. Скачайте архив [**`PurrCam-Windows-v1.1.0.zip`**](https://github.com/vslvrsh/poco-f3-cat-monitor/releases/latest/download/PurrCam-Windows-v1.1.0.zip) и распакуйте в любую папку (например, `C:\PurrCam`).
2. Запустите **`PurrCam.exe`** — сервер поднимется на порту `8787`, включит защиту ПК от сна, добавит значок в трей и автоматически откроет окно монитора.
3. *(Опционально)* Скрипт `server\start-remote.cmd` сразу запускает сервер вместе с удалённым доступом `Auto (No VPN)`.

### 2. Android-приложение (`PurrCam-Android-v1.1.0.apk`)
1. Скачайте [**`PurrCam-Android-v1.1.0.apk`**](https://github.com/vslvrsh/poco-f3-cat-monitor/releases/latest/download/PurrCam-Android-v1.1.0.apk) и установите:
   - на **Poco F3** (или любой Android 9+) → выберите **Camera Mode**;
   - на **основной телефон** → выберите **Monitor Mode**.
2. Выдайте разрешения на **Камеру**, **Микрофон** и **Уведомления**, а на телефоне-камере разрешите работу без ограничений батареи (при наличии KernelSU root добавляется в белый список автоматически).
3. Подключитесь по домашнему **Wi-Fi**, отсканировав QR-код во вкладке **Connect** на ПК (или по USB-кабелю через `adb reverse tcp:8787 tcp:8787` и адрес `ws://127.0.0.1:8787/ws`).

### 3. Настройка Poco F3 и Root (KernelSU / Magisk) — опционально
Root **не нужен** для стриминга, работы ширика `0.6× Wide`, чёрного AMOLED-экрана и мониторинга температуры CPU/батареи. Чтобы включить **аппаратное отключение подсветки (0 нит)**, **лимит заряда 80%** и авто-исключение из Doze:
1. Откройте **KernelSU Manager** (или **Magisk**) на Poco F3.
2. Выдайте права суперпользователя приложению **PurrCam** (`com.purrcam.app`).
3. Перезапустите стрим и активируйте **Root Display Off** и **80% Charge Guard** на вкладке **Health** (на самом телефоне или удалённо с ПК/монитора).

---

## Удалённый доступ вне дома (4G/5G — без VPN и без аккаунтов)

Смотрите за котом с работы или из поездки без белого IP, без VPN и без регистрации в сторонних сервисах:

### Шаг 1. Запустите удалённый туннель `Auto (No VPN)` на ПК
1. Откройте PurrCam на ПК → вкладка **Connect** → оставьте режим **`Auto (No VPN)`** → нажмите **Start Remote Tunnel**.
2. Сервер запустит HTTPS/WSS-туннель без регистрации через встроенный OpenSSH (`localhost.run` с автопереключением на `Pinggy :443` и `Cloudflare HTTP/2`), сгенерирует **32-символьный (192-битный) токен доступа** и включит **зашифрованный авто-маяк (Auto-Sync Beacon)** на `ntfy.sh` и `ntfy.envs.net`.
3. Встроенный сторожевой таймер проверяет туннель каждые 30 секунд: при любом обрыве или смене адреса туннель сам перезапускается и публикует зашифрованный AES-256-GCM новый URL.

### Шаг 2. Привяжите основной телефон один раз (1 клик через `purrcam://` или QR)
1. Во вкладке **Connect** переключитесь на **Remote (4G/5G)**.
2. Отсканируйте QR-код **или** нажмите **Copy `purrcam://` Pairing Link** и отправьте ссылку на основной телефон (например, себе в Telegram).
3. Нажмите на ссылку (или вставьте её в PurrCam через **Paste Pairing Link**) и подтвердите применение настроек в диалоговом окне.
4. Приложение сохранит **оба** адреса (локальный Wi-Fi и удалённый `wss://` + токен): дома подключение идёт напрямую по Wi-Fi, вне дома по 4G/5G — через туннель, а при смене адреса туннеля телефон сам расшифрует свежий URL с маяка и переподключится!

### Шаг 3. Автоматический HTTPS видео-релей (TURN не нужен)
В режиме потока **`Auto`** сначала пробуется WebRTC с минимальной задержкой. Если мобильный оператор блокирует UDP WebRTC, PurrCam через 6 секунд автоматически переключается на **HTTPS Relay (`ws_relay`)** — видео плавно идёт поверх того же TCP 443 туннеля (`LIVE · HTTPS Relay`).
*(При желании вы всё ещё можете указать свой или бесплатный TURN-сервер — [Metered.ca](https://www.metered.ca/tools/openrelay/), [Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/) или `coturn` — в блоке **TURN Relay**.)*

### Шаг 4. Просмотр из любого браузера
Откройте ваш удалённый HTTPS-адрес с `/?token=<ВАШ_ТОКЕН>` на телефоне или ноутбуке. Веб-интерфейс сохранит токен в `localStorage` и сразу удалит `?token=...` из адресной строки браузера.

> **Безопасность**: снаружи через любой туннель (`localhost.run`, `Pinggy`, `Cloudflare` или свой прокси) все защищённые запросы и WebSocket требуют 192-битный токен (`401` / WS `4001`, с защитой от перебора `429` / `4029`), локальные админ-маршруты ПК (`/api/remote/*`, `/api/system/*`) жёстко возвращают **`403 Forbidden`** даже при валидном токене, а авто-маяк передаёт только шифротекст AES-256-GCM. Подробнее — в [SECURITY.md](SECURITY.md).

---

## Сборка из исходников

```bash
git clone https://github.com/vslvrsh/poco-f3-cat-monitor.git
cd poco-f3-cat-monitor
```

### 1. Веб-клиент (`web/`)
> В Windows PowerShell используйте `npm.cmd` и `npx.cmd`, если политика выполнения блокирует `npm.ps1`.

```bash
cd web
npm install
npx tsc --noEmit
npm run build
```

### 2. ПК-сервер и Windows `.exe` (`server/`)
```bash
cd server
npm install
npm run typecheck
npm run build
npm test
npm start
```
Сборка нативного Windows-лаунчера `PurrCam.exe` (использует встроенный в Windows `csc.exe` из .NET Framework):
```bash
# Локальная сборка
npm run build:exe

# Портативная сборка без привязки к локальным путям (ищет ./server/dist/index.js и node.exe из PATH)
node desktop-launcher/build-exe.mjs --portable
```

### 3. Android APK (`android/`)
Требуются **JDK 21** (или JDK 17) и **Android SDK** (`compileSdk 36`, `build-tools 36.0.0`):
```bash
cd android
# Debug APK и юнит-тесты
./gradlew assembleDebug testDebugUnitTest

# Подписанный Release APK (передайте свой keystore через переменные окружения или Gradle properties)
# PURRCAM_KEYSTORE_PATH, PURRCAM_KEYSTORE_PASSWORD, PURRCAM_KEY_ALIAS, PURRCAM_KEY_PASSWORD
./gradlew assembleRelease
```

---

## Документация и лицензия

- **Спецификация протокола**: [protocol/PROTOCOL.md](protocol/PROTOCOL.md)
- **Политика безопасности**: [SECURITY.md](SECURITY.md)
- **English README**: [README.md](README.md)
- **Лицензия**: [MIT](LICENSE) © 2026 [vslvrsh](https://github.com/vslvrsh)
