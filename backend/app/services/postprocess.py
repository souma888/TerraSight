"""Local point-cloud analysis and trained-model segmentation for reconstruction jobs."""

from __future__ import annotations

import json
import logging
import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from backend.app.services import reconstruction

logger = logging.getLogger(__name__)
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="terrasight-analysis")
_active: dict[str, Future[None]] = {}
_lock = threading.Lock()
MAX_VIEWER_POINTS = 45_000
SEGMENTATION_SIZE = 512


def _optional_module(name: str) -> Any | None:
    try:
        return __import__(name)
    except ImportError:
        return None


def _serverless() -> bool:
    return os.environ.get("VERCEL", "").lower() in {"1", "true", "yes"}


def capabilities() -> dict[str, object]:
    if _serverless():
        return {
            "available": False,
            "reason": "Geometry analysis and model inference run on the persistent local worker, not Vercel.",
            "geometry": {"available": False},
            "segmentation": {"available": False},
        }
    open3d = _optional_module("open3d")
    torch = _optional_module("torch")
    checkpoint = os.environ.get("TERRASIGHT_SEGMENTATION_CHECKPOINT")
    return {
        "available": bool(open3d),
        "reason": "Local analysis capabilities checked.",
        "geometry": {
            "available": bool(open3d),
            "reason": "Open3D is ready." if open3d else "Install requirements-local.txt to enable Open3D geometry analysis.",
        },
        "segmentation": {
            "available": bool(torch and checkpoint and Path(checkpoint).is_file()),
            "torch_installed": bool(torch),
            "checkpoint_configured": bool(checkpoint and Path(checkpoint).is_file()),
            "reason": "Trained PyTorch checkpoint is ready." if torch and checkpoint and Path(checkpoint).is_file() else "Install local ML dependencies, train/evaluate a model, then set TERRASIGHT_SEGMENTATION_CHECKPOINT to its .pt file.",
        },
    }


def _source_cloud(directory: Path) -> Path:
    for name in ("dense-metric.ply", "dense.ply", "sparse-metric.ply", "sparse.ply"):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    raise ValueError("No point cloud is available. Complete a reconstruction before geometry analysis.")


def _state(job_id: str) -> tuple[Path, dict[str, Any]]:
    directory = reconstruction._job_dir(job_id)
    state = reconstruction.get_job(job_id)
    if state["status"] not in {"completed", "completed_sparse"}:
        raise ValueError("Wait for a usable reconstruction before running post-processing.")
    return directory, state


def _write_state(directory: Path, state: dict[str, Any]) -> None:
    reconstruction._write_state(directory, state)


def build_terrain_model(torch: Any) -> Any:
    """Return the small binary segmentation model used by the baseline trainer.

    The class is created only after PyTorch is available, keeping this module
    importable by the lightweight Vercel API deployment.
    """
    nn = torch.nn

    class TinyUNet(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.encoder = nn.Sequential(
                nn.Conv2d(3, 32, 3, padding=1), nn.ReLU(),
                nn.Conv2d(32, 32, 3, padding=1), nn.ReLU(),
                nn.MaxPool2d(2), nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(),
            )
            self.decoder = nn.Sequential(
                nn.ConvTranspose2d(64, 32, 2, stride=2), nn.ReLU(),
                nn.Conv2d(32, 32, 3, padding=1), nn.ReLU(), nn.Conv2d(32, 1, 1),
            )

        def forward(self, image: Any) -> Any:
            return self.decoder(self.encoder(image))

    return TinyUNet()


def _run_geometry(job_id: str) -> None:
    directory, state = _state(job_id)
    try:
        open3d = _optional_module("open3d")
        if open3d is None:
            raise RuntimeError("Open3D is not installed. Run pip install -r requirements-local.txt.")
        state["geometry"] = {"status": "running", "stage": "Reading and filtering point cloud"}
        _write_state(directory, state)
        source = _source_cloud(directory)
        cloud = open3d.io.read_point_cloud(str(source))
        if len(cloud.points) < 30:
            raise ValueError("The point cloud has too few points for geometric analysis.")
        filtered, _ = cloud.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
        if len(filtered.points) < 30:
            filtered = cloud
        points = np.asarray(filtered.points)
        bounds_min, bounds_max = points.min(axis=0), points.max(axis=0)
        extent = bounds_max - bounds_min
        diagonal = float(np.linalg.norm(extent))
        voxel_size = max(diagonal / 800.0, 1e-6)
        downsampled = filtered.voxel_down_sample(voxel_size)
        if len(downsampled.points) == 0:
            downsampled = filtered
        if len(downsampled.points) > MAX_VIEWER_POINTS:
            downsampled = downsampled.farthest_point_down_sample(MAX_VIEWER_POINTS)
        open3d.io.write_point_cloud(str(directory / "cleaned-point-cloud.ply"), filtered, write_ascii=False)
        viewer_points = np.asarray(downsampled.points, dtype=np.float32)
        viewer_colors = np.asarray(downsampled.colors, dtype=np.float32)
        if viewer_colors.shape != viewer_points.shape:
            viewer_colors = np.full_like(viewer_points, 0.72)
        viewer = {
            "coordinate_frame": "COLMAP orientation and origin retained.",
            "source": source.name,
            "point_count": int(len(viewer_points)),
            "positions": np.round(viewer_points, 6).reshape(-1).tolist(),
            "colors": np.clip(np.round(viewer_colors * 255), 0, 255).astype(np.uint8).reshape(-1).tolist(),
        }
        (directory / "viewer-point-cloud.json").write_text(json.dumps(viewer, separators=(",", ":")), encoding="utf-8")
        report = {
            "source_point_cloud": source.name,
            "input_points": int(len(cloud.points)),
            "filtered_points": int(len(filtered.points)),
            "viewer_points": int(len(viewer_points)),
            "bounds_min": np.round(bounds_min, 6).tolist(),
            "bounds_max": np.round(bounds_max, 6).tolist(),
            "axis_extent": np.round(extent, 6).tolist(),
            "bounding_box_diagonal": round(diagonal, 6),
            "coordinate_frame": "COLMAP orientation and origin retained; values are only metric if scale validation has passed.",
            "limitations": [
                "Outlier removal and bounding-box extents are geometric diagnostics, not landslide volume or stability measurements.",
                "A reference surface and validated scale are required before any volume calculation.",
            ],
        }
        (directory / "geometry-analysis.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        state["geometry"] = {"status": "completed", "report": report, "artifacts": ["cleaned-point-cloud.ply", "viewer-point-cloud.json", "geometry-analysis.json"]}
        _write_state(directory, state)
    except Exception as error:
        logger.exception("Geometry analysis failed for job %s", job_id)
        state["geometry"] = {"status": "failed", "error": str(error)}
        _write_state(directory, state)
    finally:
        with _lock:
            _active.pop(f"geometry:{job_id}", None)


def start_geometry(job_id: str) -> dict[str, Any]:
    if not capabilities()["geometry"]["available"]:  # type: ignore[index]
        raise RuntimeError("Open3D is unavailable. Run pip install -r requirements-local.txt.")
    directory, state = _state(job_id)
    key = f"geometry:{job_id}"
    with _lock:
        if key in _active:
            return state.get("geometry", {"status": "running"})
        state["geometry"] = {"status": "queued", "stage": "Queued for local Open3D analysis"}
        _write_state(directory, state)
        _active[key] = _executor.submit(_run_geometry, job_id)
    return state["geometry"]


def geometry_status(job_id: str) -> dict[str, Any]:
    _, state = _state(job_id)
    return state.get("geometry", {"status": "not_started"})


def _segmentation_assets(directory: Path) -> Path:
    path = directory / "segmentation"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run_segmentation(job_id: str) -> None:
    directory, state = _state(job_id)
    try:
        torch = _optional_module("torch")
        checkpoint_path = os.environ.get("TERRASIGHT_SEGMENTATION_CHECKPOINT")
        if torch is None or not checkpoint_path or not Path(checkpoint_path).is_file():
            raise RuntimeError("A PyTorch checkpoint is required. Train one, then set TERRASIGHT_SEGMENTATION_CHECKPOINT.")
        state["segmentation"] = {"status": "running", "stage": "Applying trained terrain-mask model"}
        _write_state(directory, state)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)
        if checkpoint.get("architecture") != "TinyUNet":
            raise ValueError("This checkpoint is not compatible with Terra Sight's TinyUNet baseline.")
        model = build_terrain_model(torch).to(device)
        model.load_state_dict(checkpoint["model_state_dict"])
        model.eval()
        assets = _segmentation_assets(directory)
        views: list[dict[str, object]] = []
        image_paths = sorted(path for path in (directory / "images").iterdir() if path.suffix.lower() in {".jpg", ".jpeg", ".png"})
        with torch.no_grad():
            for image_path in image_paths:
                bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
                if bgr is None:
                    continue
                height, width = bgr.shape[:2]
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                resized = cv2.resize(rgb, (SEGMENTATION_SIZE, SEGMENTATION_SIZE), interpolation=cv2.INTER_AREA)
                tensor = torch.from_numpy(resized.transpose(2, 0, 1)).float().unsqueeze(0).to(device) / 255.0
                probability = torch.sigmoid(model(tensor))[0, 0].cpu().numpy()
                mask = cv2.resize((probability >= 0.5).astype(np.uint8) * 255, (width, height), interpolation=cv2.INTER_NEAREST)
                stem = image_path.stem
                mask_name, overlay_name = f"{stem}-mask.png", f"{stem}-overlay.jpg"
                cv2.imwrite(str(assets / mask_name), mask)
                overlay = bgr.copy()
                overlay[mask > 127] = (40, 70, 235)
                cv2.imwrite(str(assets / overlay_name), cv2.addWeighted(bgr, 0.62, overlay, 0.38, 0))
                views.append({"image": image_path.name, "mask": mask_name, "overlay": overlay_name, "target_fraction": round(float(np.mean(mask > 127)), 5)})
        if not views:
            raise ValueError("No original JPEG/PNG images are available for segmentation.")
        report = {
            "model": checkpoint.get("architecture", "TinyUNet"),
            "class_name": checkpoint.get("class_name", "target"),
            "checkpoint_metrics": checkpoint.get("metrics", {}),
            "inference_device": str(device),
            "views": views,
            "limitations": [
                "Masks are per-image predictions from the configured trained model; they are not automatically mapped onto the 3D point cloud.",
                "Use only a checkpoint evaluated on held-out sites compatible with the intended terrain and label taxonomy.",
            ],
        }
        (directory / "segmentation-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        state["segmentation"] = {"status": "completed", "report": report, "artifacts": ["segmentation-report.json"]}
        _write_state(directory, state)
    except Exception as error:
        logger.exception("Segmentation failed for job %s", job_id)
        state["segmentation"] = {"status": "failed", "error": str(error)}
        _write_state(directory, state)
    finally:
        with _lock:
            _active.pop(f"segmentation:{job_id}", None)


def start_segmentation(job_id: str) -> dict[str, Any]:
    if not capabilities()["segmentation"]["available"]:  # type: ignore[index]
        raise RuntimeError("Segmentation is unavailable. Install requirements-local.txt, train a checkpoint, and set TERRASIGHT_SEGMENTATION_CHECKPOINT.")
    directory, state = _state(job_id)
    key = f"segmentation:{job_id}"
    with _lock:
        if key in _active:
            return state.get("segmentation", {"status": "running"})
        state["segmentation"] = {"status": "queued", "stage": "Queued for trained-model inference"}
        _write_state(directory, state)
        _active[key] = _executor.submit(_run_segmentation, job_id)
    return state["segmentation"]


def segmentation_status(job_id: str) -> dict[str, Any]:
    _, state = _state(job_id)
    return state.get("segmentation", {"status": "not_started"})


def segmentation_asset_path(job_id: str, name: str) -> Path:
    if not name.startswith("view-") or not name.endswith(("-mask.png", "-overlay.jpg")):
        raise FileNotFoundError("Unknown segmentation artifact.")
    directory, _ = _state(job_id)
    path = (_segmentation_assets(directory) / name).resolve()
    if path.parent != _segmentation_assets(directory).resolve() or not path.is_file():
        raise FileNotFoundError("Segmentation artifact is not available yet.")
    return path
