# Tilda Agent OS

**Статус: pre-alpha / активная разработка**

Tilda Agent OS — независимый open-source исследовательский слой, который должен дать AI coding agents семантический машинный интерфейс к Tilda вместо хрупкой автоматизации курсором.

Сейчас это **исследовательский harness, а не production MCP server**. В публичной сборке реализованы безопасные read-only/CDP-примитивы, canonical hashing, fail-closed allowlists, санитизация и тесты. Недокументированные editor writes и публикация пока не заявлены как воспроизведённые возможности.

Основная документация ведётся на английском:

- [README.md](README.md)
- [CAPABILITIES.md](CAPABILITIES.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [ROADMAP.md](ROADMAP.md)
- [SECURITY.md](SECURITY.md)

Проект не связан с Tilda и не поддерживается Tilda. Эксперименты допустимы только в собственном изолированном lab-проекте, без клиентских данных и с отдельным разрешением на публикацию.
