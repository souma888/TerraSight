"""Local COLMAP reconstruction jobs and metric scale validation."""

from __future__ import annotations

import csv
import io
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse

from backend.app.services import reconstruction as engine
from backend.app.services import postprocess

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/reconstructions", tags=["COLMAP reconstruction"])
ALLOWED_TYPES = {"image/jpeg", "image/png"}


@router.get("/capabilities")
def reconstruction_capabilities() -> dict[str, object]:
    return engine.capabilities()


@router.get("/postprocess/capabilities")
def postprocess_capabilities() -> dict[str, object]:
    """Report optional local analysis support without importing heavy packages at startup."""
    return postprocess.capabilities()


@router.post("", status_code=202)
async def start_reconstruction(
    images: Annotated[list[UploadFile], File(description="Original, ordered JPEG/PNG terrain images")],
    dense: Annotated[bool, Form()] = True,
) -> dict[str, object]:
    if not engine.capabilities()["available"]:
        raise HTTPException(status_code=503, detail=engine.capabilities()["reason"])
    uploads: list[tuple[str, str, bytes]] = []
    total_bytes = 0
    if len(images) < engine.MIN_IMAGES:
        raise HTTPException(status_code=422, detail=f"Add at least {engine.MIN_IMAGES} original images. More overlapping viewpoints are recommended for terrain.")
    if len(images) > engine.MAX_IMAGES:
        raise HTTPException(status_code=413, detail=f"A job can contain at most {engine.MAX_IMAGES} images.")
    for index, image in enumerate(images, start=1):
        if image.content_type not in ALLOWED_TYPES:
            raise HTTPException(status_code=415, detail=f"{image.filename or f'View {index}'}: use original JPEG or PNG files for reconstruction.")
        data = await image.read(engine.MAX_IMAGE_BYTES + 1)
        if len(data) > engine.MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail=f"{image.filename or f'View {index}'} exceeds the 20 MB per-image limit.")
        total_bytes += len(data)
        if total_bytes > engine.MAX_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail="This local reconstruction job exceeds the 250 MB image-set limit.")
        uploads.append((image.content_type, image.filename or f"view-{index}", data))
        await image.close()
    try:
        return engine.create_job(uploads, dense=dense)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except OSError:
        logger.exception("Could not create COLMAP job workspace")
        raise HTTPException(status_code=500, detail="Could not create the local reconstruction workspace.") from None


@router.get("/{job_id}")
def reconstruction_status(job_id: UUID) -> dict[str, object]:
    try:
        return engine.get_job(str(job_id))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.delete("/{job_id}", status_code=204)
def delete_reconstruction(job_id: UUID) -> Response:
    try:
        engine.delete_job(str(job_id))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(status_code=204)


@router.get("/{job_id}/scale-template.csv")
def scale_template(job_id: UUID) -> StreamingResponse:
    try:
        state = engine.get_job(str(job_id))
        if state["status"] not in {"completed", "completed_sparse"}:
            raise HTTPException(status_code=409, detail="Wait for the sparse model before downloading a scale template.")
        positions = engine._parse_camera_positions(engine._job_dir(str(job_id)))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    names = sorted(positions)
    if len(names) >= 4:
        first, one_third, two_thirds, last = names[0], names[len(names) // 3], names[(2 * len(names)) // 3], names[-1]
        pairs = [(first, one_third), (one_third, two_thirds), (two_thirds, last)]
    else:
        pairs = [(names[0], names[-1])] if len(names) > 1 else []
    content = io.StringIO(newline="")
    writer = csv.writer(content)
    writer.writerow(["image_a", "image_b", "measured_distance_m"])
    writer.writerows([[left, right, ""] for left, right in pairs])
    return StreamingResponse(iter([content.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=scale-baselines-template.csv"})


@router.post("/{job_id}/scale")
async def validate_scale(job_id: UUID, baselines_csv: Annotated[UploadFile, File(description="Independent measured camera-center baselines CSV")]) -> dict[str, object]:
    try:
        content = await baselines_csv.read(1_000_001)
        result = engine.validate_scale(str(job_id), content)
        return result
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        await baselines_csv.close()


@router.post("/{job_id}/geometry", status_code=202)
def start_geometry(job_id: UUID) -> dict[str, object]:
    try:
        return postprocess.start_geometry(str(job_id))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/{job_id}/geometry")
def geometry_status(job_id: UUID) -> dict[str, object]:
    try:
        return postprocess.geometry_status(str(job_id))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/{job_id}/segmentation", status_code=202)
def start_segmentation(job_id: UUID) -> dict[str, object]:
    try:
        return postprocess.start_segmentation(str(job_id))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/{job_id}/segmentation")
def segmentation_status(job_id: UUID) -> dict[str, object]:
    try:
        return postprocess.segmentation_status(str(job_id))
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/{job_id}/segmentation/{name}")
def segmentation_asset(job_id: UUID, name: str) -> FileResponse:
    try:
        path = postprocess.segmentation_asset_path(str(job_id), name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return FileResponse(path, media_type="image/png" if path.suffix == ".png" else "image/jpeg", filename=path.name)


@router.get("/{job_id}/artifacts/{name}")
def download_artifact(job_id: UUID, name: str) -> FileResponse:
    try:
        path = engine.artifact_path(str(job_id), name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    media_type = "text/csv" if path.suffix == ".csv" else "application/json" if path.suffix == ".json" else "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=path.name)
