"""Smart-plug readers for true wall-power measurements (Shelly, Tasmota, TP-Link Kasa).

All three talk to the plug directly on your LAN - no cloud accounts involved.
"""

from __future__ import annotations

import base64
import json
import logging
import socket
import struct
import threading
import time
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)


def _http_json(url: str, username: str = "", password: str = "", timeout: float = 3.0):
    req = urllib.request.Request(url, headers={"User-Agent": "WattWatch"})
    if username:
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _base(host: str) -> str:
    host = host.strip().rstrip("/")
    return host if host.startswith(("http://", "https://")) else f"http://{host}"


def read_shelly(host: str, username: str = "", password: str = "", index: int = 0) -> float:
    base = _base(host)
    # Gen2 / Gen3 / Plus devices (RPC API)
    try:
        data = _http_json(f"{base}/rpc/Switch.GetStatus?id={index}", username, password)
        if "apower" in data:
            return float(data["apower"])
    except Exception as exc:
        log.debug("Shelly RPC failed, trying Gen1: %s", exc)
    # Gen1 devices
    data = _http_json(f"{base}/status", username, password)
    meters = data.get("meters") or data.get("emeters") or []
    if meters:
        return float(meters[min(index, len(meters) - 1)]["power"])
    raise ValueError("Shelly response had no power reading")


def read_tasmota(host: str, username: str = "", password: str = "", index: int = 0) -> float:
    q = {"cmnd": "Status 8"}
    if username:
        q.update({"user": username, "password": password})
    data = _http_json(f"{_base(host)}/cm?{urllib.parse.urlencode(q)}")
    energy = data.get("StatusSNS", {}).get("ENERGY", {})
    power = energy.get("Power")
    if isinstance(power, list):
        power = power[min(index, len(power) - 1)]
    if power is None:
        raise ValueError("Tasmota response had no ENERGY.Power - is this a metering plug?")
    return float(power)


# --- TP-Link Kasa legacy protocol (HS110, KP115, HS300 ...) on TCP 9999 --------------------
def _kasa_encrypt(payload: str) -> bytes:
    key = 171
    out = bytearray()
    for ch in payload.encode():
        key = key ^ ch
        out.append(key)
    return struct.pack(">I", len(out)) + bytes(out)


def _kasa_decrypt(data: bytes) -> str:
    key = 171
    out = bytearray()
    for b in data:
        out.append(key ^ b)
        key = b
    return out.decode("utf-8", "replace")


def read_kasa(host: str, username: str = "", password: str = "", index: int = 0) -> float:
    host = host.replace("http://", "").replace("https://", "").split("/")[0]
    try:
        return _read_kasa_legacy(host)
    except Exception as legacy_exc:
        # Newer firmware uses the encrypted KLAP protocol - supported when python-kasa is installed.
        try:
            return _read_kasa_lib(host, username, password)
        except ImportError:
            raise ValueError(f"Kasa legacy protocol failed ({legacy_exc}). For newer firmware run: pip install python-kasa") from None


def _read_kasa_legacy(host: str) -> float:
    cmd = json.dumps({"emeter": {"get_realtime": {}}})
    with socket.create_connection((host, 9999), timeout=3) as sock:
        sock.sendall(_kasa_encrypt(cmd))
        header = sock.recv(4)
        length = struct.unpack(">I", header)[0]
        buf = b""
        while len(buf) < length:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
    data = json.loads(_kasa_decrypt(buf))
    rt = data["emeter"]["get_realtime"]
    if "power_mw" in rt:
        return rt["power_mw"] / 1000.0
    return float(rt["power"])


def _read_kasa_lib(host: str, username: str, password: str) -> float:
    import asyncio

    import kasa  # type: ignore

    async def go():
        creds = kasa.Credentials(username, password) if username else None
        dev = await kasa.Discover.discover_single(host, credentials=creds)
        await dev.update()
        energy = dev.modules.get("Energy") if hasattr(dev, "modules") else None
        watts = energy.current_consumption if energy else dev.emeter_realtime.power
        await dev.disconnect()
        return float(watts)

    return asyncio.run(go())


READERS = {"shelly": read_shelly, "tasmota": read_tasmota, "kasa": read_kasa}


def read_plug(cfg: dict) -> float:
    kind = (cfg or {}).get("type", "none")
    if kind not in READERS or not cfg.get("host"):
        raise ValueError("No smart plug configured")
    return READERS[kind](cfg["host"], cfg.get("username", ""), cfg.get("password", ""), int(cfg.get("index", 0)))


class SmartPlugPoller:
    """Polls the configured plug every 2 s in the background."""

    def __init__(self):
        self.cfg: dict = {"type": "none"}
        self.watts: float | None = None
        self.updated = 0.0
        self.error = ""
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="smartplug")
        self._thread.start()

    def configure(self, cfg: dict):
        if cfg != self.cfg:
            self.cfg = dict(cfg or {})
            self.watts, self.error = None, ""

    @property
    def active(self) -> bool:
        return self.cfg.get("type", "none") != "none" and bool(self.cfg.get("host"))

    def read(self) -> float | None:
        if not self.active or time.time() - self.updated > 10:
            return None
        return self.watts

    def _loop(self):
        while not self._stop.is_set():
            if self.active:
                try:
                    self.watts = read_plug(self.cfg)
                    self.updated = time.time()
                    self.error = ""
                except Exception as exc:
                    self.error = str(exc)[:200]
            self._stop.wait(2.0)

    def stop(self):
        self._stop.set()
