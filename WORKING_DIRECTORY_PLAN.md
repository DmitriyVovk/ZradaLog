# План: выбор рабочей директории (workspace)

> Временный планировочный документ. Можно удалить после реализации.
> Дата: 2026-06-12. Ветка: image-sequence.

## Цель

1. **Первый запуск** — спросить у пользователя, где разместить рабочую директорию
   (сейчас это `C:\Users\Senior\AppData\Roaming\zradalog` со всеми кешами, сегментами,
   записями, логами, настройками).
2. **Кнопка в интерфейсе** — переназначить рабочую папку с **полным переносом всех файлов**
   в новое место.

«Рабочая директория» = текущий `app.getPath("userData")`. Внутри неё:
`settings.json`, `logs/`, `segments/` (+ `segments/images/`), `output/`.

---

## Архитектурная основа

Сейчас путь к данным везде вычисляется как `app.getPath("userData")`:

- [electron/main.ts](electron/main.ts): `settingsPath` (стр. 107), `logDir` (стр. 369),
  `output`/`segments`/`images` в авто-мердже и во всех IPC-хендлерах
  (`zrada:open-output`, `zrada:delete-all`, `zrada:merge-all`, `zrada:check-segments`,
  `zrada:preview-dedup-scan`, `loadSavedCount`).
- [electron/services/RecorderEngine.ts:100](electron/services/RecorderEngine.ts#L100):
  `segmentsDir` в конструкторе.
- [electron/services/LoggerService.ts](electron/services/LoggerService.ts): `logDir` приходит аргументом.
- [electron/services/MergerService.ts](electron/services/MergerService.ts): пути приходят аргументами (свои пути не вычисляет — менять не нужно).

### Выбранный подход: переопределить сам `userData`

Самый малоинвазивный путь — **переопределить `app.setPath("userData", root)` на старте**,
до `app.whenReady()`. Тогда все существующие `app.getPath("userData")` автоматически
указывают на выбранную папку, и большие правки в сервисах не нужны.

Проблема курицы и яйца: указатель на кастомную папку нельзя хранить внутри самой
кастомной папки. Решение — **тонкий файл-указатель в ФИКСИРОВАННОМ месте** (дефолтный
userData), который читается ДО `setPath`.

```
DEFAULT_USERDATA = app.getPath("userData")            // зафиксировать в самом верху main.ts
POINTER          = path.join(DEFAULT_USERDATA, "workspace.json")   // { "root": "D:\\..." }
```

- Если `POINTER` нет или в нём нет `root` → **первый запуск** (см. шаг 2).
- Если `root` есть и папка валидна → `app.setPath("userData", root)`.

> Указатель `workspace.json` всегда живёт в дефолтном `...\Roaming\zradalog\` и НЕ переносится.
> `electron-store` уже в зависимостях — можно использовать его для указателя, но хватит и
> обычного `fs.readFileSync`/`writeFileSync` (без асинхронности, читается до ready).

---

## Шаги реализации

### Шаг 1. Модуль резолвинга workspace (новый файл)

Создать `electron/services/WorkspaceManager.ts`:

- `getDefaultUserData(): string` — зафиксированный дефолтный путь (захватить один раз).
- `readPointer(): { root?: string }` — прочитать `workspace.json` из дефолтного userData.
- `writePointer(root: string): void` — записать указатель.
- `resolveAndApply(): { root: string; isFirstRun: boolean }` —
  прочитать указатель; если есть валидный `root` → `app.setPath("userData", root)` и вернуть его;
  иначе вернуть `isFirstRun: true` (без setPath, пока пользователь не выберет).
- `ensureSubdirs(root)` — создать `logs/`, `segments/segments/images/`, `output/` при необходимости.
- Утилита `moveWorkspace(oldRoot, newRoot, onProgress?)` — для шага 4.

Вызвать `resolveAndApply()` **в самом начале** (до `app.whenReady().then(...)`), т.к.
`setPath("userData")` должен сработать прежде, чем что-либо обратится к userData.

### Шаг 2. Первый запуск — диалог выбора папки

В `app.whenReady()` (или сразу после resolve), если `isFirstRun`:

- Показать `dialog.showMessageBox` с пояснением + двумя вариантами:
  - **«Использовать по умолчанию»** → `root = DEFAULT_USERDATA` (текущее поведение).
  - **«Выбрать папку…»** → `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })`.
- Выбранную папку записать в указатель (`writePointer`), при необходимости создать,
  внутри неё создать структуру `ensureSubdirs`.
- Применить `app.setPath("userData", root)` **до** создания `LoggerService`/`RecorderEngine`/`MergerService`.
- Если пользователь закрыл диалог без выбора → дефолт (не блокировать запуск).

> Важно: диалог должен отработать ДО инициализации логгера и рекордера (стр. 368–494 main.ts),
> иначе logs/segments создадутся в старом месте. Проще всего вынести выбор в синхронный
> блок в начале `whenReady`, перед `new LoggerService(...)`.

### Шаг 3. IPC + preload + UI: показать текущую папку

- **main.ts** добавить IPC:
  - `zrada:get-workspace` → `{ ok, root, isDefault }`.
  - `zrada:open-workspace` → `shell.openPath(root)` (открыть саму рабочую папку).
  - `zrada:change-workspace` → логика шага 4.
- **preload.ts** добавить namespace `zradaWorkspace`:
  ```ts
  contextBridge.exposeInMainWorld('zradaWorkspace', {
    get: () => ipcRenderer.invoke('zrada:get-workspace'),
    open: () => ipcRenderer.invoke('zrada:open-workspace'),
    change: () => ipcRenderer.invoke('zrada:change-workspace'),
  });
  ```
- **UI** в [src/components/controls/FileControls.tsx](src/components/controls/FileControls.tsx):
  - Показать текущий путь рабочей директории (загрузить через `zradaWorkspace.get()` в `useEffect`).
  - Кнопка **«Change working directory…»** → `zradaWorkspace.change()`.
  - Кнопка **«Open working folder»** (опционально).

### Шаг 4. Кнопка переназначения + полный перенос файлов

IPC `zrada:change-workspace` в main.ts:

1. **Предусловие:** если идёт запись (`recorder.getState()` != idle/stopped) →
   вернуть ошибку «остановите запись перед переносом» (или предложить остановить).
2. `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })` → `newRoot`.
   - Валидация: `newRoot` не совпадает со старым; не является вложенной в старый (и наоборот);
     по возможности тот же том (для атомарного `rename`, иначе copy+delete между дисками).
3. **Освободить файловые хендлы:** `logger.close()` (закрыть поток лога),
   закрыть открытые session-логи рекордера (`recorder.forceKill()` уже закрывает; запись и так остановлена).
4. **Перенос** `moveWorkspace(oldRoot, newRoot)`:
   - Переносить `settings.json`, `logs/`, `segments/`, `output/`.
   - Стратегия: тот же том → `fs.renameSync` поддиректорий; разные тома →
     рекурсивный `fs.cpSync(old, new, { recursive: true })` + удаление старого
     (или `shell.trashItem` старого после успешной копии).
   - Прогресс/ошибки логировать; при ошибке копирования НЕ удалять исходник.
5. **Обновить указатель:** `writePointer(newRoot)`.
6. **Применить:** `app.setPath("userData", newRoot)`.
   - Поскольку `LoggerService`/`RecorderEngine` уже захватили старые пути в полях/потоках,
     самый надёжный способ — **перезапустить приложение**: `app.relaunch(); app.exit(0)`.
   - (Альтернатива без рестарта: пере-создать `logger`, `recorder`, `merger` и пере-навесить
     все обработчики/IPC — заметно сложнее и более хрупко. Рекомендую рестарт.)
7. Вернуть в renderer `{ ok: true, root: newRoot, relaunching: true }` и показать уведомление.

### Шаг 5. Прочее

- `loadSettings`/`saveSettings` (main.ts стр. 107, 118–166) — `settingsPath` уже через userData,
  при `setPath` подхватится автоматически. Проверить, что `settings.json` не дублирует
  `workspace.json` (это разные файлы; указатель отдельно и в дефолтном месте).
- `.gitignore` — указатель и данные и так вне репозитория (AppData), правок не требуется.
- Логи стартапа: после `setPath` залогировать фактический `root` и `isDefault`.

---

## Проверка (manual)

1. Удалить `...\Roaming\zradalog\workspace.json` → запустить → должен появиться диалог выбора.
2. Выбрать `D:\ZradaWork` → убедиться, что `logs/segments/output/settings.json`
   создаются именно там.
3. Записать пару сегментов, затем «Change working directory…» → выбрать `E:\ZradaWork2` →
   убедиться, что все файлы перенесены, старая папка пуста/в корзине, приложение
   перезапустилось и пишет в новое место.
4. Перенос на тот же диск (rename) и на другой диск (copy+delete) — оба сценария.
5. Попытка переноса во время записи → корректная ошибка.

## Затрагиваемые файлы

- `electron/services/WorkspaceManager.ts` — **новый**.
- `electron/main.ts` — резолвинг на старте, диалог первого запуска, 3 новых IPC.
- `electron/preload.ts` — namespace `zradaWorkspace`.
- `src/components/controls/FileControls.tsx` — отображение пути + кнопки.
- (RecorderEngine/Logger/Merger менять не нужно при подходе через `setPath` + рестарт.)

## Принятые решения

- **Первый запуск:** показывать диалог выбора папки (Вариант A), с опцией «использовать
  по умолчанию». _(подтвердить — см. вопрос пользователя)._
- **После переноса:** перезапуск приложения (`app.relaunch(); app.exit(0)`).
  Горячая переинициализация сервисов НЕ делаем.
- **Старая папка** после успешного переноса между дисками → в корзину
  (`shell.trashItem`), не удалять насовсем.
