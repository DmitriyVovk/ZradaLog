# ZradaLog

**ZradaLog** — приложение для записи таймлапса экрана с автоматическим склеиванием видео, дедупликацией фреймов и минимальными настройками.

## 🎯 Возможности

- **Видео режим** — запись экрана с низкой FPS, mpdecimate фильтр для удаления дубликатов
- **Режим картинок** — запись скриншотов с фильтрацией по размеру/хешу
- **Автоматическое склеивание** — сегменты объединяются при остановке записи
- **Сессионные логи** — один лог на сеанс (не per-segment)
- **Ротация логов** — максимум 10 файлов логов на диске, старые удаляются

---

## 📋 Требования

### Обязательное

**FFmpeg** — включен в инсталлятор (не требует отдельной установки).

Если запускаете из исходного кода в режиме разработки, установите FFmpeg:
- **Windows**: `choco install ffmpeg` или скачайте с [ffmpeg.org](https://ffmpeg.org/download.html)
- **Mac**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

Проверка установки:
```bash
ffmpeg -version
```

### Для разработки

- Node.js 16+
- npm

---

## 🚀 Быстрый старт

### Установка для пользователей

1. Скачайте инсталлятор `ZradaLog Setup X.X.X.exe` из [релизов](https://github.com/your-repo/zradalog/releases)
2. Запустите инсталлятор и следуйте инструкциям
3. Приложение установится в Program Files и создаст ярлыки на рабочем столе и в меню Пуск
4. FFmpeg уже включен в инсталлятор — готово к использованию!

### Установка для разработчиков

### 1. Установка

```bash
npm install
```

### 2. Запуск в режиме разработки

```bash
npm run dev
```

Это запустит Vite dev-сервер и откроет Electron приложение.

### 3. Сборка для production

```bash
npm run build:electron
npm run build
npm start
```

---

## 📖 Использование

### Видео режим (таймлапс)

1. Выберите режим **"Video"** в левой панели
2. Установите **Capture FPS** (частота снятия кадров, например 0.1-1 для таймлапса)
3. Установите **Output Speed** (финальная скорость видео, обычно 24-60)
4. Настройте **mpdecimate** параметры для удаления дубликатов:
   - **hi** — порог чувствительности (по умолчанию 20000)
   - **lo** — низший порог (по умолчанию 1500)
   - **frac** — доля кадров (по умолчанию 0.3)
5. Нажмите **Start**
6. При завершении нажмите **Stop** — видео автоматически склеится

### Режим картинок

1. Выберите режим **"Image"**
2. Установите **Capture FPS** — частота скриншотов
3. Настройте **деdup**:
   - **Algorithm** — метод (None/pHash/SSIM)
   - **Threshold** — чувствительность
4. Скриншоты сохранятся в `~/.ZradaLog/segments/images/`

---

## 📁 Расположение файлов

Все данные сохраняются в зависимости от ОС:

- **Windows**: `C:\Users\<User>\AppData\Local\ZradaLog\`
- **Mac**: `~/Library/Application Support/ZradaLog/`
- **Linux**: `~/.config/ZradaLog/`

Структура:
```
~/.ZradaLog/
├── logs/              # Логи приложения
├── segments/          # Видео сегменты и session-логи
│   ├── segment_*.mp4
│   ├── ffmpeg-session-*.log  # Логи FFmpeg (макс 10 файлов)
│   └── images/        # Скриншоты в режиме картинок
└── settings.json      # Сохраненные настройки
```

---

## ⚙️ Конфигурация

Все настройки автоматически сохраняются в `settings.json`:

```json
{
  "mode": "video",
  "fps": 1,
  "outputFps": 24,
  "mpdecimateSettings": {
    "enabled": true,
    "hi": 20000,
    "lo": 1500,
    "frac": 0.3
  },
  "dedupSettings": {
    "algorithm": "phash",
    "enabled": false,
    "threshold": 12
  }
}
```

---

## 🔧 Разработка — для C++/Visual Studio разработчиков

**Node.js / npm** — как package manager (vcpkg, nuget)  
**TypeScript** — типизированный JavaScript, компилируется в JS  
**Electron** — кроссплатформенное приложение (Chromium + Node.js)  
**Vite** — быстрый dev-сервер для React

### Сборка инсталлятора

Для создания инсталлятора Windows (.exe):

```bash
# Установка electron-builder
npm install --save-dev electron-builder

# Сборка инсталлятора
npm run dist:win
```

Инсталлятор появится в `dist-electron/ZradaLog Setup X.X.X.exe`

### Добавление иконки

1. Создайте иконку `build/icon.ico` (256x256)
2. Добавьте пути к иконке в `package.json` в секции `build.win` и `build.nsis`  

### Структура проекта

```
ZradaLog/
├── electron/
│   ├── main.ts            # Главный процесс (точка входа)
│   ├── preload.ts         # Безопасный IPC мост
│   ├── services/
│   │   ├── RecorderEngine.ts    # FFmpeg запись
│   │   ├── MergerService.ts     # Склеивание сегментов
│   │   └── LoggerService.ts     # Структурированное логирование
│   └── build/             # Скомпилированный JS (после npm run build:electron)
├── src/
│   ├── App.tsx            # Главный React компонент
│   └── components/        # UI компоненты
├── dist/                  # Build output (после npm run build)
├── package.json
└── tsconfig.*.json        # TypeScript конфигурации
```

### Команды

| Команда | Описание |
|---------|---------|
| `npm install` | Установка зависимостей |
| `npm run dev` | Запуск dev-сервера + Electron |
| `npm run build:electron` | Компиляция TypeScript (electron/) → JS |
| `npm run build` | Сборка React (Vite) → dist/ |
| `npm start` | Запуск production версии |

---

## 🐛 Устранение проблем

### FFmpeg не найден

Ошибка: `FFmpeg not found in PATH`

**Решение:**
1. Установите FFmpeg (см. раздел "Требования")
2. Убедитесь, что `ffmpeg` доступен в PATH:
   ```bash
   ffmpeg -version
   ```
3. Перезапустите приложение

### Видео не склеивается

Проверьте:
1. Логи приложения (вкладка "Logs")
2. Файл логов: `~/.ZradaLog/segments/ffmpeg-session-*.log`
3. Убедитесь, что сегменты созданы: `~/.ZradaLog/segments/segment_*.mp4`

### Медленная запись / высокая нагрузка на CPU

- Снизьте **Capture FPS**
- Увеличьте **mpdecimate.hi** (менее агрессивная дедуплификация)
- При необходимости отключите**mpdecimate**

---

## 📝 Разработка и сборка

### Первичная сборка после clone

```bash
npm install
npm run build:electron
```

### Continuous development

```bash
npm run dev     # Запустите в одном терминале
# Кодите, изменения подхватятся автоматически
```

### Packaging (если нужен инсталлятор)

Инсталлятор еще не настроен, но может быть добавлен с `electron-builder`:

```bash
npm install -D electron-builder
npm run build
npm run electron-builder
```

---

## 📄 Лицензия

MIT
