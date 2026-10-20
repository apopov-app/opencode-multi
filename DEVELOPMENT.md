# Разработка

## Структура

```
package.json                 # пакет для установки из Git, exports "." и "./tui"
.opencode/
  multi.json                 # настройки комнаты
  plugins/multi/
    index.ts                 # серверный оркестратор
    tui.ts                   # /multi для терминала
    package.json             # локальный манифест (private)
```

Локально OpenCode подхватывает `.opencode/plugins/multi` автоматически.
Корневой `package.json` нужен для установки из Git: его `exports` указывают на
файлы плагина.

## Проверка

```sh
npm install
npx tsc --noEmit
```

## Как устроено

- Комната — обычная сессия с `metadata.multi`. Оркестратор переключает модель
  сессии и будит её невидимым `session.synthetic`, поэтому все участники видят
  один диалог и общие инструменты.
- `session.hook("context")` добавляет в system-промпт правила комнаты и состав.
- `session.wait` + гейт на `session.execution.started` определяют завершение хода.
- `@упоминания` передают слово; без них — round-robin по кругу.
- `room_stop` — голосование за остановку; когда голосов `N/N`, цепочка встаёт.
- Формы (выбор моделей, Continue/Stop) создаются через локальный HTTP API
  `/api/session/:id/form` с `metadata.kind = "question"`: в 2.0.32 plugin API не
  отдаёт `session.form.create`, а десктоп рендерит только формы с этой меткой.
- Видимость моделей десктопа читается best-effort из
  `~/Library/Application Support/ai.opencode.desktop/drafts.sqlite`
  (`state → opencode.global.dat / model`), чтобы не показывать скрытые модели.
- Hot reload: изменение файлов плагина во время живой комнаты перезагружает
  плагин и останавливает цепочку. После серии правок в одном процессе могут
  остаться старые экземпляры; перезапустите OpenCode/сервис, чтобы их убрать.

## Установка из репозитория

npm-пакета нет — ставим напрямую из GitHub:

```sh
opencode plugin add github:apopov-app/opencode-multi
```

Обновления: `opencode plugin check`, `opencode plugin update`.
