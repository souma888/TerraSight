"""Capture-session and batch readiness endpoints."""

from __future__ import annotations

import json
import logging
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from backend.app.services.readiness import MAX_IMAGE_BYTES, analyze_batch

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sessions", tags=["capture readiness"])
MAX_IMAGES = 25
MAX_BATCH_BYTES = 4_000_000  # Stay below Vercel Functions' 4.5 MB request-body limit.
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}


@router.post("", status_code=201)
def create_session() -> dict[str, object]:
    """Issue a client session ID; image data and results are not persisted server-side."""
    return {
        "session_id": str(uuid4()),
        "status": "created",
        "storage": "stateless",
        "message": "The ID is a client correlation key; uploads are processed per request and not retained.",
    }


@router.post("/{session_id}/readiness")
async def check_readiness(
    session_id: UUID,
    files: list[UploadFile] = File(..., description="Ordered image batch (JPEG, PNG, or WebP)"),
    original_dimensions: str | None = Form(default=None),
) -> dict[str, object]:
    """Validate and analyze an uploaded image batch synchronously."""
    if not files:
        raise HTTPException(status_code=422, detail="Add at least one image to run a readiness check.")
    if len(files) > MAX_IMAGES:
        raise HTTPException(status_code=413, detail=f"A batch can contain at most {MAX_IMAGES} images.")
    try:
        dimensions_data = json.loads(original_dimensions) if original_dimensions else []
        if not isinstance(dimensions_data, list) or (dimensions_data and len(dimensions_data) != len(files)):
            raise ValueError
        dimensions: list[tuple[int, int] | None] = []
        for item in dimensions_data:
            width, height = int(item["width"]), int(item["height"])
            if width <= 0 or height <= 0 or width > 100_000 or height > 100_000:
                raise ValueError
            dimensions.append((width, height))
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise HTTPException(status_code=422, detail="Original image dimensions are invalid.") from None

    uploads: list[tuple[str, bytes, tuple[int, int] | None]] = []
    total_bytes = 0
    for index, upload in enumerate(files):
        if upload.content_type not in ALLOWED_TYPES:
            raise HTTPException(status_code=415, detail=f"{upload.filename or f'Image {index + 1}'}: use JPEG, PNG, or WebP.")
        content = await upload.read(MAX_IMAGE_BYTES + 1)
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail=f"{upload.filename or f'Image {index + 1}'} exceeds the 4 MB per-image limit.")
        total_bytes += len(content)
        if total_bytes > MAX_BATCH_BYTES:
            raise HTTPException(status_code=413, detail="The batch exceeds the 4 MB processing limit. Reduce image size or analyze a smaller set.")
        uploads.append((upload.filename or f"view-{index + 1}", content, dimensions[index] if dimensions else None))
        await upload.close()

    try:
        result = await run_in_threadpool(analyze_batch, uploads)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception:
        logger.exception("Readiness analysis failed for session %s", session_id)
        raise HTTPException(status_code=500, detail="Image analysis failed. Try a smaller or different image set.") from None
    return {"session_id": str(session_id), **result}
