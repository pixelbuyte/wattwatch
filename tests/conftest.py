import time

import pytest

from wattwatch.demo import seed_demo


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WATTWATCH_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def demo_db(tmp_path):
    path = tmp_path / "demo.db"
    seed_demo(str(path), days=14)
    return path


@pytest.fixture
def ww(demo_db):
    from wattwatch.app import WattWatch

    app = WattWatch(db_path=demo_db, start=False)
    app.notifier.muted = True
    app.collector._tick(time.time(), 1.0)  # produce one live sample without the background thread
    yield app
    app.plug.stop()
    app.db.close()
