# Jira (`com.anakilivo.streamdock.jira`)

Ваши тикеты в текущем спринте Jira Cloud на клавише и крутилке Stream Dock.
Один архив для macOS и Windows — нативного кода нет.

| Действие | Где | Что показывает / делает |
|---|---|---|
| Мой спринт | клавиша | сколько ваших тикетов в открытых спринтах ещё не сделано, «из N» и полоска прогресса; нажатие — открыть список в Jira |
| Тикеты спринта (крутилка) | крутилка | поворот листает незакрытые тикеты: ключ, название, статус (цветом категории), тип; нажатие крутилки или касание экрана — открыть тикет |

Запрос: `assignee = currentUser() AND sprint in openSprints() ORDER BY rank`. Если в настройках отмечены
доски, вместо `openSprints()` берутся активные спринты только этих досок (Agile API
`/rest/agile/1.0/board/{id}/sprint?state=active`); в списке — доски со спринтами (scrum и team-managed `simple`, без kanban), с поиском. В ленте сначала тикеты
«в работе» (In Progress, PR review, Ready for QA…), потом «к выполнению», внутри — порядок спринта.
Сделанные (категория Done) в ленту не попадают, но учитываются в «из N».

Данные обновляются раз в минуту и после нажатия на клавишу. Пока на устройстве нет ни одного
действия плагина, запросов нет.

## Вход

В настройках любого действия плагина укажите сайт (`company.atlassian.net`), email и API-токен
(id.atlassian.com → Security → API tokens). Там же — выбор досок. Всё хранится в глобальных
настройках Stream Dock и общее для всех действий плагина.

## Устройство

```
com.anakilivo.streamdock.jira.sdPlugin/
  manifest.json
  plugin/
    index.js         точка входа
    sdk.js           WebSocket-протокол Stream Dock, логи в log/
    jira.js          вход, запрос тикетов (REST /rest/api/3/search/jql), опрос
    render.js        SVG клавиши (144×144) и полосы (176×112)
    raster.js        SVG → PNG через resvg (WebAssembly)
    actions/         sprint.js — клавиша, feed.js — крутилка
  pi/settings.html   настройки входа
scripts/build.sh     npm, иконки, dist/…zip; --install — симлинк в Stream Dock (macOS)
scripts/icons.js     иконки для manifest.json
```
