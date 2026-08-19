#!/usr/bin/env python3
"""tracking_lint.py — ЗОЛОТОЙ ЗАКОН: текст не растягивается. Нигде.

Владелец, 2026-08-19, дословно: «ни один текст не должен быть растянут. Ни один.
Нигде.» Не про доску, не про карточку, не про заголовки — про ВЕСЬ текст во всех
поверхностях организации.

Что запрещено: любая положительная разрядка — `letter-spacing` с ненулевым
значением в em, px, rem или процентах, в CSS, в inline-стиле, в SVG-атрибуте, в
строке, собираемой питоном или яваскриптом. Отрицательная разрядка (сжатие)
законом не запрещена и пропускается: она чинит слишком просторный шрифт, а не
растаскивает буквы.

Почему замок, а не правило в файле: правило уже стояло, и его всё равно нарушили
59 раз в `api/ui.html`, 8 раз в дашборде и один раз в спеке, по которой строили.
Правило, за которым никто не следит механически, — это пожелание.

Иногда растяжка приходит НЕ как letter-spacing: `text-transform` с пробелами
между буквами вручную (`О Р Г А Н И З А Ц И Я`) — тот же грех другим способом.
Такое ловится глазами, не этим скриптом; здесь только машинная часть.

Использование:
    python3 tools/tracking_lint.py          # проверить, код возврата 1 при находке
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {".git", "node_modules", ".wrangler", "dist", "build", ".claude"}
EXTS = {".html", ".css", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".svg", ".py", ".md", ".json"}

# letter-spacing со значением, которое НЕ ноль и НЕ отрицательное.
# Ловит: .07em  0.07em  1px  2%  0.5rem  — в CSS, в inline-стиле, в SVG-атрибуте.
BAD = re.compile(
    r"letter[-_ ]?spacing\s*[:=]\s*[\"']?\+?(?!0\s*[;\"'}\s]|0(?:\.0+)?(?:em|px|rem|%)|-)"
    r"(?:\.\d+|\d+(?:\.\d+)?)\s*(?:em|px|rem|%)",
    re.I,
)
# Тот же грех в яваскрипте объектом: letterSpacing: '.08em'
# Отрицательная разрядка законом разрешена, `inherit`/`normal` разрядкой не
# являются — иначе замок начинает кричать на честный код и его перестают
# слушать. Ловим только положительное числовое значение с единицей.
BAD_JS = re.compile(
    r"letterSpacing\s*:\s*[\"']\+?"
    r"(?!0[\"']|0(?:\.0+)?(?:em|px|rem|%))"
    r"(?:\.\d+|\d+(?:\.\d+)?)\s*(?:em|px|rem|%)[\"']"
)


def scan():
    hits = []
    self_path = os.path.relpath(os.path.abspath(__file__), ROOT)
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if os.path.splitext(name)[1].lower() not in EXTS:
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, ROOT)
            # Сам замок держит образцы нарушения в объяснении — иначе непонятно,
            # что именно он ловит. Себя не проверяет.
            if rel == self_path:
                continue
            try:
                text = open(path, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            for i, line in enumerate(text.split("\n"), 1):
                if BAD.search(line) or BAD_JS.search(line):
                    hits.append((rel, i, line.strip()[:110]))
    return hits


def main():
    hits = scan()
    if not hits:
        print("clean: растянутого текста нет нигде — золотой закон соблюдён")
        return 0
    print("РАСТЯНУТЫЙ ТЕКСТ — золотой закон Владельца нарушен (2026-08-19):")
    print()
    for rel, line, src in hits:
        print(f"  {rel}:{line}")
        print(f"      {src}")
    print()
    print("Разрядка не растягивается никогда. Не влезает — уменьшай кегль или")
    print("сокращай надпись. Иерархию несут вес и размер, не расстояние между букв.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
