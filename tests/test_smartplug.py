import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from wattwatch.sensors import smartplug


def test_kasa_xor_roundtrip():
    payload = json.dumps({"emeter": {"get_realtime": {}}})
    enc = smartplug._kasa_encrypt(payload)
    assert int.from_bytes(enc[:4], "big") == len(payload)
    assert smartplug._kasa_decrypt(enc[4:]) == payload


class _Plug(BaseHTTPRequestHandler):
    routes: dict = {}

    def do_GET(self):  # noqa: N802
        body = self.routes.get(self.path.split("?")[0])
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture
def plug_server():
    srv = HTTPServer(("127.0.0.1", 0), _Plug)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_shelly_gen2(plug_server):
    _Plug.routes = {"/rpc/Switch.GetStatus": {"id": 0, "apower": 87.4}}
    assert smartplug.read_shelly(plug_server) == 87.4


def test_shelly_gen1_fallback(plug_server):
    _Plug.routes = {"/status": {"meters": [{"power": 64.2}]}}
    assert smartplug.read_shelly(plug_server) == 64.2


def test_tasmota(plug_server):
    _Plug.routes = {"/cm": {"StatusSNS": {"ENERGY": {"Power": 101}}}}
    assert smartplug.read_tasmota(plug_server) == 101.0


def test_unconfigured_plug_raises():
    with pytest.raises(ValueError):
        smartplug.read_plug({"type": "none"})
