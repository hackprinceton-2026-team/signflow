"""Write the API contract to backend/openapi.json.

    python -m scripts.export_openapi           # write
    python -m scripts.export_openapi --check   # exit 1 if the committed file is stale

The output never depends on local environment or credentials.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from signflow_api.app import create_app
from signflow_api.config import BACKEND_DIR, Settings

OUTPUT = BACKEND_DIR / "openapi.json"


def render() -> str:
    # Explicit settings with no .env file: the schema must be environment-independent.
    settings = Settings(_env_file=None, google_api_key=None)  # type: ignore[call-arg]
    return (
        json.dumps(create_app(settings, speech_configured=lambda: False).openapi(), indent=2, ensure_ascii=False) + "\n"
    )


def main(argv: list[str]) -> int:
    rendered = render()
    if "--check" in argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != rendered:
            print(f"{OUTPUT.name} is stale. Run: python -m scripts.export_openapi", file=sys.stderr)
            return 1
        print(f"{OUTPUT.name} is up to date")
        return 0
    Path(OUTPUT).write_text(rendered, encoding="utf-8")
    print(f"Wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
