# Tilda Agent OS / Tilda MCP

Статус: `0.2.0-prealpha`. Phase 2 завершён на узком вертикальном срезе в
отдельной авторизованной лаборатории; проект всё ещё активно развивается.

Это не production- и не универсальный MCP для Tilda. В публичном репозитории
нет реальных ID, клиентского контента, доменов, cookies, браузерного профиля,
сырых трассировок и приватных live-фикстур. В публичную часть вынесены общий
код, MCP-протокол, тесты и обезличенная документация.

Внутри есть:

- локальный MCP stdio-сервер с 11 ограниченными инструментами;
- ChangeSet/snapshot-хранилище с идемпотентностью, проверкой устаревшего
  состояния, rollback и fail-closed защитой;
- узкие адаптеры Standard, T123, Zero, SEO и page-specific HEAD;
- same-session CDP authority, отдельные publication-gates и безопасная
  наблюдаемость;
- публичный read-only smoke без live ID и удалённых записей.

Запуск:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:mcp
```

Перед live-экспериментами оператор должен сам войти в отдельный браузер,
собрать полный локальный inventory и создать disjoint allowlist лаборатории.
Публичная копия этого проекта специально остаётся заблокированной, пока
такие локальные данные не настроены.

Page-specific HEAD проверен только на точном лабораторном target и не публикует
страницу как побочный эффект. Site-wide HEAD и совместимость с Tilda Advanced
Interface Mode остаются задачами Phase 3.

Подробности: [`README.md`](README.md), [`SECURITY.md`](SECURITY.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`CAPABILITIES.md`](CAPABILITIES.md).

Лицензия: Apache-2.0.
