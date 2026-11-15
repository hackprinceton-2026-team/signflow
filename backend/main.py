"""SignFlow backend entry point.

    uvicorn main:app --reload        # or: python main.py

Configuration comes from environment variables / backend/.env (see .env.example).
"""

from signflow_api.app import create_app
from signflow_api.config import get_settings

app = create_app()

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True, log_level=settings.log_level)
