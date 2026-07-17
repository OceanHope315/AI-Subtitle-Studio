from __future__ import annotations

import os
from pathlib import Path
import shutil
import tempfile


# Several API tests import ai_service.main during collection. Point its global
# Settings at a unique workspace-local sandbox before that import can happen so
# the documented plain pytest command can never recover or clean live data.
_ROOT = Path(__file__).resolve().parents[2]
_TEMP_PARENT = _ROOT / ".tmp-ai-service-tests"
_TEMP_PARENT.mkdir(parents=True, exist_ok=True)
_TEST_DATA = Path(tempfile.mkdtemp(prefix="run-", dir=_TEMP_PARENT))
os.environ["DATA_DIR"] = str(_TEST_DATA)


def pytest_sessionfinish(session, exitstatus) -> None:  # noqa: ARG001
    shutil.rmtree(_TEST_DATA, ignore_errors=True)
    try:
        _TEMP_PARENT.rmdir()
    except OSError:
        pass
