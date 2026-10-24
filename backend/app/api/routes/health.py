from fastapi import APIRouter

router = APIRouter()


@router.get("/health", tags=["system"])
def health_check() -> dict[str, str]:
    """Return a lightweight liveness response for the API."""
    return {"status": "ok", "service": "terrasight-api"}
