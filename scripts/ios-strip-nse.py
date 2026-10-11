#!/usr/bin/env python3
"""Запасная iOS-сборка БЕЗ Notification Service Extension (scripts/ios-release.sh --without-nse).

Правит КОПИЮ дерева ios/ (не репозиторий): убирает из project.yml таргет EblushaNotificationService и
зависимость приложения от него, а из Eblusha.entitlements — группу приложений group.org.eblusha.plus.
Тогда подписи не нужны ни App ID org.eblusha.plus.NotificationService, ни App Group — то, что автоподпись
может не суметь завести сама (docs/ios-handoff.md §16). Приложение без расширения работает: MuteShared
откатывается на UserDefaults.standard, число на значке ведёт сервер (APNS_BADGE); теряется только
приглушение пуша, пришедшего в гонке с «Без звука».

  python3 scripts/ios-strip-nse.py <копия ios/>
"""
import plistlib
import re
import sys
from pathlib import Path

NSE = "EblushaNotificationService"
GROUPS = "com.apple.security.application-groups"


def strip_project(text: str) -> str:
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Зависимость приложения: «      - target: EblushaNotificationService» (+ комментарий над ней).
        if re.fullmatch(r"\s*-\s*target:\s*" + NSE + r"\s*", line):
            while out and out[-1].strip().startswith("#") and len(out[-1]) - len(out[-1].lstrip()) == len(line) - len(line.lstrip()):
                out.pop()
            i += 1
            continue
        # Сам таргет: ключ «  EblushaNotificationService:» до следующего ключа того же или меньшего отступа.
        m = re.fullmatch(r"(\s*)" + NSE + r":\s*", line)
        if m:
            indent = len(m.group(1))
            # комментарии над таргетом (тем же отступом) — тоже долой
            while out and out[-1].strip().startswith("#") and len(out[-1]) - len(out[-1].lstrip()) == indent:
                out.pop()
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if nxt.strip() and len(nxt) - len(nxt.lstrip()) <= indent:
                    break
                i += 1
            continue
        out.append(line)
        i += 1
    res = "\n".join(out)
    if NSE in res:
        raise SystemExit(f"project.yml: после правки остались упоминания {NSE}")
    return res


def strip_entitlements(path: Path) -> None:
    with path.open("rb") as f:
        data = plistlib.load(f)
    data.pop(GROUPS, None)
    with path.open("wb") as f:
        plistlib.dump(data, f)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    root = Path(sys.argv[1])
    proj = root / "project.yml"
    ent = root / "Eblusha" / "Resources" / "Eblusha.entitlements"
    if not proj.is_file() or not ent.is_file():
        raise SystemExit(f"нет {proj} или {ent} — это не копия ios/")
    proj.write_text(strip_project(proj.read_text(encoding="utf-8")), encoding="utf-8")
    strip_entitlements(ent)
    with ent.open("rb") as f:
        left = plistlib.load(f)
    if GROUPS in left:
        raise SystemExit("entitlements: группа приложений осталась")
    print(f"без расширения: {proj} и {ent} поправлены (aps-environment оставлен: {left.get('aps-environment')})")


if __name__ == "__main__":
    main()
