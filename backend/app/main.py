from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.routes.health import router as health_router

app = FastAPI(
    title="Terra Sight API",
    description="Capture readiness and terrain reconstruction platform.",
    version="0.1.0",
)

# Keep the API and static frontend on one origin for the starter application.
app.include_router(health_router, prefix="/api")

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
