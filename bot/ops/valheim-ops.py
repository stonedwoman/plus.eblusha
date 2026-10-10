#!/usr/bin/env python3
"""
valheim-ops — помощник бота «Еблуша» для управления сервером Valheim на stoned.

Работает на хосте от root (ему нужен docker и systemd), слушает unix-сокет
/run/valheim-ops/ops.sock (каталог 0750 и сокет 0660, группа — gid пользователя
бота в контейнере, по умолчанию 1000). Бот в контейнере получает ТОЛЬКО этот
сокет: ни docker.sock, ни /DATA/valheim, ни токен правки настроек мира.

Протокол: HTTP/1.1 поверх сокета, POST /v1/<действие>, тело — JSON (до 4 КБ).
Действия — только из белого списка, аргументы проверяются здесь же, команды
запускаются списком аргументов (без shell):

  status              — контейнер, ожидающий рестарт, бэкапы, диск, плагины
  restart_when_empty  — systemd-run restart-when-empty.sh (ждёт, пока никого)
  restart_cancel      — systemctl stop valheim-restart-when-empty
  restart_now         — docker compose restart valheim (в фоне, unit valheim-restart-now)
  backup_now          — tar.gz мира в /DATA/valheim/backups-manual/bot-<время>/ + SHA256SUMS
  options_set         — {key, value}: сверка с /options карты, POST /options с токеном

Каждое действие пишется в журнал (OPS_LOG): время, действие, аргументы, итог.
Чего здесь нет и не будет: adminlist/banlist, удаление бэкапов, смена мира,
`docker compose up -d` (меняет join-код), произвольные команды.

Проверка без последствий:  OPS_DRY_RUN=1 OPS_SOCKET=/tmp/t.sock python3 valheim-ops.py
(команды не запускаются, только пишутся в журнал), и  python3 valheim-ops.py --selftest
"""
import datetime as dt
import grp
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tarfile
import threading
import urllib.error
import urllib.request

SOCKET = os.environ.get("OPS_SOCKET", "/run/valheim-ops/ops.sock")
SOCKET_GID = int(os.environ.get("OPS_SOCKET_GID", "1000"))
VALHEIM_DIR = os.environ.get("OPS_VALHEIM_DIR", "/DATA/valheim")
COMPOSE_FILE = os.path.join(VALHEIM_DIR, "docker-compose.yml")
ENV_FILE = os.path.join(VALHEIM_DIR, "valheim.env")
RESTART_WHEN_EMPTY = os.path.join(VALHEIM_DIR, "restart-when-empty.sh")
WORLDS_DIR = os.path.join(VALHEIM_DIR, "config", "worlds_local")
HOURLY_DIR = os.path.join(VALHEIM_DIR, "config", "backups")
MANUAL_DIR = os.path.join(VALHEIM_DIR, "backups-manual")
BEPINEX_LOG = os.path.join(VALHEIM_DIR, "data", "bepinex", "BepInEx", "LogOutput.log")
CONTAINER = os.environ.get("OPS_CONTAINER", "valheim")
MAP_URL = os.environ.get("OPS_MAP_URL", "http://127.0.0.1:3010")
OPTIONS_TOKEN_FILE = os.environ.get("OPS_OPTIONS_TOKEN_FILE", "/DATA/koban-hub/valheim-options.token")
LOG_FILE = os.environ.get("OPS_LOG", "/var/log/valheim-ops.log")
DRY_RUN = os.environ.get("OPS_DRY_RUN") == "1"
UNIT_WHEN_EMPTY = "valheim-restart-when-empty"
UNIT_NOW = "valheim-restart-now"
MIN_FREE_BYTES = 5 * 1024**3

LOCK = threading.Lock()


def log(action, args, result):
    line = json.dumps(
        {"ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "action": action, "args": args, "ok": result.get("ok"), "error": result.get("error"), "dry": DRY_RUN or None},
        ensure_ascii=False,
    )
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        print(line, file=sys.stderr)


def run(cmd, timeout=60, check=True):
    """Команда списком аргументов; в режиме проверки — только журнал."""
    if DRY_RUN:
        print("DRY:", " ".join(cmd), file=sys.stderr)
        return subprocess.CompletedProcess(cmd, 0, "", "")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=check)


def query(cmd, timeout=15):
    """Только чтение — выполняется и в режиме проверки."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def unit_active(unit):
    return query(["systemctl", "is-active", unit]) in ("active", "activating")


def unit_since(unit):
    v = query(["systemctl", "show", "-p", "ActiveEnterTimestamp", "--value", unit])
    return v or None


def world_name():
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^\s*WORLD_NAME\s*=\s*([A-Za-z0-9_\-]+)\s*$", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return None


# ------------------------------------------------------------------ действия
def act_status(_args):
    out = {"ok": True}
    raw = query(["docker", "inspect", "-f", "{{json .State}}", CONTAINER])
    try:
        st = json.loads(raw) if raw else None
    except ValueError:
        st = None
    out["container"] = (
        {"running": bool(st.get("Running")), "status": st.get("Status"), "startedAt": (st.get("StartedAt") or "")[:19] or None, "health": (st.get("Health") or {}).get("Status")}
        if st
        else {"running": False, "status": "not found"}
    )
    out["restartWhenEmpty"] = {"active": unit_active(UNIT_WHEN_EMPTY), "since": unit_since(UNIT_WHEN_EMPTY) if unit_active(UNIT_WHEN_EMPTY) else None}
    out["restartNow"] = {"active": unit_active(UNIT_NOW)}
    backups = {"hourlyCount": 0, "lastHourly": None, "lastManual": None}
    try:
        zips = sorted((e for e in os.scandir(HOURLY_DIR) if e.name.endswith(".zip")), key=lambda e: e.stat().st_mtime)
        backups["hourlyCount"] = len(zips)
        if zips:
            z = zips[-1]
            backups["lastHourly"] = {"file": z.name, "at": dt.datetime.fromtimestamp(z.stat().st_mtime).strftime("%Y-%m-%d %H:%M"), "size": z.stat().st_size}
    except OSError:
        pass
    try:
        mans = sorted((e for e in os.scandir(MANUAL_DIR) if e.is_dir() and e.name.startswith("bot-")), key=lambda e: e.stat().st_mtime)
        if mans:
            m = mans[-1]
            size = sum(f.stat().st_size for f in os.scandir(m.path) if f.is_file())
            backups["lastManual"] = {"path": m.path, "at": dt.datetime.fromtimestamp(m.stat().st_mtime).strftime("%Y-%m-%d %H:%M"), "size": size}
    except OSError:
        pass
    out["backups"] = backups
    du = shutil.disk_usage("/DATA" if os.path.isdir("/DATA") else "/")
    out["disk"] = {"freeGb": round(du.free / 1024**3, 1), "totalGb": round(du.total / 1024**3, 1)}
    plugins = None
    try:
        with open(BEPINEX_LOG, encoding="utf-8", errors="replace") as f:
            head = f.read(200_000)
        m = re.search(r"(\d+) plugins to load", head)
        loaded = len(re.findall(r"Loading \[", head))
        plugins = f"{loaded} из {m.group(1)}" if m else (str(loaded) if loaded else None)
    except OSError:
        pass
    out["game"] = {"plugins": plugins}
    return out


def act_restart_when_empty(_args):
    if unit_active(UNIT_WHEN_EMPTY):
        return {"ok": True, "already": True}
    if not os.path.isfile(RESTART_WHEN_EMPTY):
        return {"ok": False, "error": "нет restart-when-empty.sh"}
    run(["systemd-run", f"--unit={UNIT_WHEN_EMPTY}", "--collect", RESTART_WHEN_EMPTY])
    return {"ok": True, "already": False}


def act_restart_cancel(_args):
    was = unit_active(UNIT_WHEN_EMPTY)
    if was:
        run(["systemctl", "stop", UNIT_WHEN_EMPTY])
    return {"ok": True, "wasActive": was}


def act_restart_now(args):
    if unit_active(UNIT_NOW):
        return {"ok": False, "error": "перезапуск уже идёт"}
    # Сейчас перезапускаемся — ожидание «когда опустеет» больше не нужно (иначе второй рестарт).
    if unit_active(UNIT_WHEN_EMPTY):
        run(["systemctl", "stop", UNIT_WHEN_EMPTY])
    run(["systemd-run", f"--unit={UNIT_NOW}", "--collect", "/usr/bin/docker", "compose", "-f", COMPOSE_FILE, "restart", CONTAINER])
    return {"ok": True}


def act_backup_now(_args):
    world = world_name()
    if not world:
        return {"ok": False, "error": "не нашёл WORLD_NAME в valheim.env"}
    sources = [p for p in (os.path.join(WORLDS_DIR, world), os.path.join(WORLDS_DIR, world + ".fwl"), os.path.join(WORLDS_DIR, world + ".db")) if os.path.exists(p)]
    if not sources:
        return {"ok": False, "error": f"нет файлов мира {world}"}
    if shutil.disk_usage(VALHEIM_DIR).free < MIN_FREE_BYTES:
        return {"ok": False, "error": "на диске меньше 5 ГБ"}
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    folder = os.path.join(MANUAL_DIR, f"bot-{stamp}")
    archive = os.path.join(folder, f"{world}-{stamp}.tar.gz")
    if DRY_RUN:
        return {"ok": True, "path": archive, "size": 0, "sha256": "dry-run"}
    os.makedirs(folder, mode=0o750, exist_ok=False)
    with tarfile.open(archive, "w:gz", compresslevel=6) as tar:
        for src in sources:
            tar.add(src, arcname=os.path.basename(src))
    h = hashlib.sha256()
    with open(archive, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    with open(os.path.join(folder, "SHA256SUMS"), "w", encoding="utf-8") as f:
        f.write(f"{digest}  {os.path.basename(archive)}\n")
    return {"ok": True, "path": archive, "size": os.path.getsize(archive), "sha256": digest}


def http_json(url, data=None, headers=None, timeout=10):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except ValueError:
            return e.code, {}


def option_line(item, value):
    """Строка для POST /options или исключение ValueError. Значения — только из списка карты."""
    kind = item.get("kind")
    key = item["key"]
    v = str(value).strip().lower()
    if kind == "flag":
        if v in ("on", "1", "true"):
            return f"set {key}", "вкл"
        if v in ("off", "0", "false"):
            return f"unset {key}", "выкл"
        raise ValueError("для флага — on/off")
    try:
        n = float(v)
    except ValueError:
        raise ValueError("нужно число") from None
    if kind == "int":
        lo, hi = item.get("min", 0), item.get("max", 10)
        if n != int(n) or not lo <= n <= hi:
            raise ValueError(f"целое от {lo} до {hi}")
        return f"set {key} {int(n)}", str(int(n))
    if kind == "scale":
        choices = item.get("choices") or []
        if n not in choices:
            raise ValueError("одно из: " + ", ".join(f"x{c:g}" for c in choices))
        return f"set {key} {n:g}", f"x{n:g}"
    raise ValueError("неизвестный тип настройки")


def act_options_set(args):
    key = args.get("key")
    value = args.get("value")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z]{2,40}", key) or not isinstance(value, (str, int, float)):
        return {"ok": False, "error": "нужны key (латиница) и value"}
    status, opts = http_json(f"{MAP_URL}/options")
    if status != 200:
        return {"ok": False, "error": f"карта ответила {status}"}
    item = next((it for g in opts.get("groups", []) for it in g.get("items", []) if it.get("key") == key), None)
    if not item:
        return {"ok": False, "error": f"нет настройки {key}"}
    try:
        line, shown = option_line(item, value)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if DRY_RUN:
        return {"ok": True, "applied": f"{item.get('label', key)} → {shown}", "line": line}
    try:
        with open(OPTIONS_TOKEN_FILE, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        return {"ok": False, "error": "нет токена правки настроек"}
    status, res = http_json(f"{MAP_URL}/options", data=(line + "\n").encode("utf-8"), headers={"X-WebMap-Token": token, "Content-Type": "text/plain; charset=utf-8"})
    if status != 200 or not res.get("ok"):
        return {"ok": False, "error": res.get("error") or f"карта ответила {status}"}
    return {"ok": True, "applied": f"{item.get('label', key)} → {shown}"}


ACTIONS = {
    "status": act_status,
    "restart_when_empty": act_restart_when_empty,
    "restart_cancel": act_restart_cancel,
    "restart_now": act_restart_now,
    "backup_now": act_backup_now,
    "options_set": act_options_set,
}
# Только чтение — без общего замка.
READ_ONLY = {"status"}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "valheim-ops/1"

    def log_message(self, fmt, *args):  # client_address у unix-сокета пустой — свой журнал
        pass

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(405, {"ok": False, "error": "только POST"})

    def do_POST(self):
        m = re.fullmatch(r"/v1/([a-z_]{2,32})", self.path)
        action = m.group(1) if m else None
        if action not in ACTIONS:
            self.reply(404, {"ok": False, "error": "нет такого действия"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 4096:
            self.reply(413, {"ok": False, "error": "слишком большой запрос"})
            return
        try:
            args = json.loads(self.rfile.read(length).decode("utf-8") or "{}") if length else {}
            if not isinstance(args, dict):
                raise ValueError
        except ValueError:
            self.reply(400, {"ok": False, "error": "тело — JSON-объект"})
            return
        safe_args = {k: v for k, v in args.items() if k in ("key", "value", "reason")}
        try:
            if action in READ_ONLY:
                result = ACTIONS[action](safe_args)
            else:
                if not LOCK.acquire(timeout=1):
                    self.reply(409, {"ok": False, "error": "другое действие ещё выполняется"})
                    return
                try:
                    result = ACTIONS[action](safe_args)
                finally:
                    LOCK.release()
        except subprocess.CalledProcessError as e:
            result = {"ok": False, "error": f"команда завершилась с кодом {e.returncode}"}
        except Exception as e:  # noqa: BLE001 — всё в журнал и в ответ, сервис не падает
            result = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        if action not in READ_ONLY:
            log(action, safe_args, result)
        self.reply(200, result)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def selftest():
    item_flag = {"key": "NoBuildCost", "kind": "flag"}
    item_scale = {"key": "ResourceRate", "kind": "scale", "choices": [0.25, 0.5, 1, 2, 3, 5, 10]}
    item_int = {"key": "WorldLevel", "kind": "int", "min": 0, "max": 10}
    assert option_line(item_flag, "on") == ("set NoBuildCost", "вкл")
    assert option_line(item_flag, "off") == ("unset NoBuildCost", "выкл")
    assert option_line(item_scale, "3") == ("set ResourceRate 3", "x3")
    assert option_line(item_scale, "0.5") == ("set ResourceRate 0.5", "x0.5")
    assert option_line(item_int, "4") == ("set WorldLevel 4", "4")
    for bad in ((item_flag, "maybe"), (item_scale, "4"), (item_scale, "3; rm -rf /"), (item_int, "11"), (item_int, "1.5")):
        try:
            option_line(*bad)
            raise AssertionError(f"должно было отказать: {bad}")
        except ValueError:
            pass
    print("selftest ok")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    folder = os.path.dirname(SOCKET)
    os.makedirs(folder, exist_ok=True)
    if not DRY_RUN:
        os.chown(folder, 0, SOCKET_GID)
        os.chmod(folder, 0o750)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    srv = Server(SOCKET, Handler)
    if not DRY_RUN:
        os.chown(SOCKET, 0, SOCKET_GID)
    os.chmod(SOCKET, 0o660)
    try:
        gname = grp.getgrgid(SOCKET_GID).gr_name
    except KeyError:
        gname = str(SOCKET_GID)
    print(f"valheim-ops: слушаю {SOCKET} (группа {gname}){' — РЕЖИМ ПРОВЕРКИ' if DRY_RUN else ''}", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
