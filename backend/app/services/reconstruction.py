"""Local COLMAP worker, job store, and metric scale validation."""

from __future__ import annotations

import csv
import json
import logging
import os
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from plyfile import PlyData, PlyElement

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_JOB_ROOT = PROJECT_ROOT / "data" / "processed" / "reconstructions"
MAX_IMAGES = 100
MIN_IMAGES = 8
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 250 * 1024 * 1024
MAX_JOB_SECONDS = 60 * 60
MIN_REGISTERED_FRACTION = 0.70
SCALE_TOLERANCE_PERCENT = 5.0

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="terrasight-colmap")
_active_jobs: dict[str, Future[None]] = {}
_jobs_lock = threading.Lock()


class ReconstructionError(RuntimeError):
    """A COLMAP job could not produce a usable sparse reconstruction."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def job_root() -> Path:
    configured = os.environ.get("TERRASIGHT_RECONSTRUCTION_ROOT")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_JOB_ROOT


def _colmap_executable() -> str | None:
    configured = os.environ.get("COLMAP_EXECUTABLE")
    if configured:
        path = Path(configured).expanduser()
        return str(path.resolve()) if path.is_file() else None
    return shutil.which("colmap") or shutil.which("COLMAP")


def _serverless() -> bool:
    return os.environ.get("VERCEL", "").lower() in {"1", "true", "yes"}


def capabilities() -> dict[str, Any]:
    if _serverless():
        return {
            "available": False,
            "runtime": "vercel-serverless",
            "reason": "COLMAP reconstruction needs a persistent local worker; this Vercel deployment cannot retain large image batches or long-running jobs.",
            "min_images": MIN_IMAGES,
            "max_images": MAX_IMAGES,
        }
    executable = _colmap_executable()
    if executable is None:
        return {
            "available": False,
            "runtime": "local",
            "reason": "COLMAP was not found. Install COLMAP with CUDA support and set COLMAP_EXECUTABLE to its command-line executable.",
            "min_images": MIN_IMAGES,
            "max_images": MAX_IMAGES,
        }
    try:
        root = job_root()
        root.mkdir(parents=True, exist_ok=True)
        if not os.access(root, os.W_OK):
            raise OSError("Reconstruction storage is not writable.")
    except OSError as error:
        return {"available": False, "runtime": "local", "reason": str(error), "min_images": MIN_IMAGES, "max_images": MAX_IMAGES}
    return {
        "available": True,
        "runtime": "local-worker",
        "reason": "Local COLMAP worker is available. Original images and reconstruction outputs are stored on this machine.",
        "colmap_executable": Path(executable).name,
        "min_images": MIN_IMAGES,
        "max_images": MAX_IMAGES,
        "dense_supported": None,
        "dense_note": "Dense PatchMatch stereo needs a COLMAP build with CUDA; the sparse reconstruction is produced separately.",
    }


def _job_dir(job_id: str) -> Path:
    try:
        parsed = uuid.UUID(job_id)
    except ValueError as error:
        raise FileNotFoundError("Unknown reconstruction job.") from error
    return job_root() / str(parsed)


def _read_job(job_id: str) -> dict[str, Any]:
    path = _job_dir(job_id) / "job.json"
    if not path.is_file():
        raise FileNotFoundError("Unknown reconstruction job.")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_state(directory: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = _now()
    temporary = directory / "job.json.tmp"
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(temporary, directory / "job.json")


def _command(executable: str, arguments: list[str]) -> list[str]:
    if os.name == "nt" and executable.lower().endswith((".bat", ".cmd")):
        def ps_literal(value: str) -> str:
            return "'" + value.replace("'", "''") + "'"

        command_line = "& " + " ".join(ps_literal(value) for value in [executable, *arguments])
        command_line += "; exit $LASTEXITCODE"
        return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command_line]
    return [executable, *arguments]


def _run_colmap(
    executable: str,
    command: str,
    options: list[str],
    directory: Path,
    state: dict[str, Any],
    stage: str,
    percent: int,
    timeout: int = MAX_JOB_SECONDS,
) -> None:
    state.update({"status": "running", "stage": stage, "progress_percent": percent})
    _write_state(directory, state)
    log_path = directory / "colmap.log"
    with log_path.open("a", encoding="utf-8", errors="replace") as log:
        log.write(f"\n[{_now()}] colmap {command} {' '.join(options)}\n")
        log.flush()
        try:
            result = subprocess.run(
                _command(executable, [command, *options]),
                cwd=directory,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise ReconstructionError(f"COLMAP {command} exceeded its {timeout // 60}-minute time limit.") from error
    if result.returncode != 0:
        raise ReconstructionError(f"COLMAP {command} failed with exit code {result.returncode}. See the job log for details.")


def _model_statistics(text_model: Path, image_count: int) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    images_path = text_model / "images.txt"
    points_path = text_model / "points3D.txt"
    if not images_path.is_file() or not points_path.is_file():
        raise ReconstructionError("COLMAP did not export a readable text model.")
    camera_centers: dict[str, np.ndarray] = {}
    lines = images_path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines:
        if not line or line.startswith("#"):
            continue
        parts = line.split(maxsplit=8)
        if len(parts) != 9 or Path(parts[8]).suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        q = np.asarray([float(v) for v in parts[1:5]], dtype=np.float64)
        t = np.asarray([float(v) for v in parts[5:8]], dtype=np.float64)
        qw, qx, qy, qz = q
        rotation = np.asarray([
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ])
        camera_centers[parts[8]] = -rotation.T @ t

    reprojection_errors: list[float] = []
    point_count = 0
    for line in points_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 8:
            try:
                reprojection_errors.append(float(parts[7]))
                point_count += 1
            except ValueError:
                continue
    errors = np.asarray(reprojection_errors, dtype=np.float64)
    registered = len(camera_centers)
    report = {
        "registered_images": registered,
        "input_images": image_count,
        "registration_fraction": round(registered / image_count, 4) if image_count else 0.0,
        "sparse_point_count": point_count,
        "mean_reprojection_error_px": round(float(errors.mean()), 3) if errors.size else None,
        "median_reprojection_error_px": round(float(np.median(errors)), 3) if errors.size else None,
        "camera_positions_file": "camera-positions.csv",
    }
    return report, camera_centers


def _write_camera_positions(path: Path, positions: dict[str, np.ndarray]) -> None:
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(["image_name", "x_model_units", "y_model_units", "z_model_units"])
        for name, center in sorted(positions.items()):
            writer.writerow([name, *(f"{float(axis):.10f}" for axis in center)])


def _best_model(sparse_root: Path, image_count: int, executable: str, directory: Path, state: dict[str, Any]) -> tuple[Path, Path, dict[str, Any], dict[str, np.ndarray]]:
    candidates = [path for path in sparse_root.iterdir() if path.is_dir()]
    if not candidates and (sparse_root / "images.bin").is_file():
        candidates = [sparse_root]
    if not candidates:
        raise ReconstructionError("COLMAP registered no camera model. Try sharper, more-overlapping images with one camera lens.")

    options_list: list[tuple[Path, Path, dict[str, Any], dict[str, np.ndarray]]] = []
    for candidate in candidates:
        text_path = directory / ("model-text-" + candidate.name)
        _run_colmap(executable, "model_converter", ["--input_path", str(candidate), "--output_path", str(text_path), "--output_type", "TXT"], directory, state, "Inspecting camera registration", 68)
        report, centers = _model_statistics(text_path, image_count)
        options_list.append((candidate, text_path, report, centers))
    return max(options_list, key=lambda model: (model[2]["registered_images"], model[2]["sparse_point_count"]))


def _execute_job(job_id: str) -> None:
    directory = _job_dir(job_id)
    state = _read_job(job_id)
    executable = _colmap_executable()
    if executable is None:
        state.update({"status": "failed", "stage": "COLMAP unavailable", "error": "COLMAP executable is no longer available."})
        _write_state(directory, state)
        with _jobs_lock:
            _active_jobs.pop(job_id, None)
        return
    try:
        images = directory / "images"
        database = directory / "database.db"
        sparse = directory / "sparse"
        sparse.mkdir(exist_ok=True)
        _run_colmap(executable, "feature_extractor", [
            "--database_path", str(database), "--image_path", str(images),
            "--SiftExtraction.max_num_features", "8192",
            "--ImageReader.single_camera", "1",
        ], directory, state, "Extracting SIFT features", 10, timeout=1800)
        _run_colmap(executable, "exhaustive_matcher", [
            "--database_path", str(database), "--FeatureMatching.guided_matching", "1",
        ], directory, state, "Matching and geometrically verifying image pairs", 30, timeout=3600)
        _run_colmap(executable, "mapper", [
            "--database_path", str(database), "--image_path", str(images), "--output_path", str(sparse),
            "--Mapper.ba_refine_principal_point", "0", "--Mapper.multiple_models", "1",
            "--Mapper.max_num_models", "5",
        ], directory, state, "Registering cameras and triangulating sparse points", 48, timeout=MAX_JOB_SECONDS)
        model, text_model, report, centers = _best_model(sparse, state["image_count"], executable, directory, state)
        if report["registered_images"] < 3 or report["sparse_point_count"] < 100:
            raise ReconstructionError(
                f"Sparse reconstruction is too weak ({report['registered_images']} registered cameras, "
                f"{report['sparse_point_count']} 3D points). Improve overlap, texture, and camera movement before relying on this model."
            )
        report["unregistered_images"] = state["image_count"] - report["registered_images"]
        report["quality_flags"] = []
        if report["registration_fraction"] < MIN_REGISTERED_FRACTION:
            report["quality_flags"].append("Less than 70% of input images registered; inspect the camera report and coverage gaps.")
        if report["median_reprojection_error_px"] is not None and report["median_reprojection_error_px"] > 2.0:
            report["quality_flags"].append("Median reprojection error exceeds 2 px; inspect blur, lens changes, and calibration stability.")
        _write_camera_positions(directory / "camera-positions.csv", centers)
        _run_colmap(executable, "model_converter", [
            "--input_path", str(model), "--output_path", str(directory / "sparse.ply"), "--output_type", "PLY",
        ], directory, state, "Writing sparse point cloud", 72)
        _run_colmap(executable, "model_converter", [
            "--input_path", str(model), "--output_path", str(directory / "sparse-model"), "--output_type", "TXT",
        ], directory, state, "Writing camera and point diagnostics", 76)
        report["sparse_point_cloud"] = "sparse.ply"
        report["camera_report"] = "camera-positions.csv"

        dense_error = None
        if state["dense_requested"]:
            dense_workspace = directory / "dense-workspace"
            try:
                _run_colmap(executable, "image_undistorter", [
                    "--image_path", str(images), "--input_path", str(model), "--output_path", str(dense_workspace),
                    "--output_type", "COLMAP", "--max_image_size", "2400",
                ], directory, state, "Undistorting images for dense stereo", 80, timeout=3600)
                _run_colmap(executable, "patch_match_stereo", [
                    "--workspace_path", str(dense_workspace), "--workspace_format", "COLMAP",
                    "--PatchMatchStereo.geom_consistency", "true",
                ], directory, state, "Estimating dense depth maps", 86, timeout=MAX_JOB_SECONDS)
                _run_colmap(executable, "stereo_fusion", [
                    "--workspace_path", str(dense_workspace), "--workspace_format", "COLMAP",
                    "--input_type", "geometric", "--output_path", str(directory / "dense.ply"),
                ], directory, state, "Fusing dense point cloud", 96, timeout=MAX_JOB_SECONDS)
                report["dense_point_cloud"] = "dense.ply"
            except ReconstructionError as error:
                dense_error = str(error)
                logger.warning("Dense reconstruction failed for %s: %s", job_id, dense_error)

        report["dense_error"] = dense_error
        report["model_format"] = "COLMAP sparse text model at sparse-model/"
        (directory / "diagnostics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        status = "completed" if not dense_error or not state["dense_requested"] else "completed_sparse"
        state.update({
            "status": status,
            "stage": "Complete" if status == "completed" else "Sparse model complete; dense stage unavailable",
            "progress_percent": 100 if status == "completed" else 76,
            "summary": report,
            "dense_error": dense_error,
            "artifacts": [name for name in ["sparse.ply", "dense.ply", "camera-positions.csv", "diagnostics.json"] if (directory / name).is_file()],
        })
        _write_state(directory, state)
    except Exception as error:
        logger.exception("COLMAP reconstruction failed for job %s", job_id)
        state.update({"status": "failed", "stage": "Reconstruction failed", "error": str(error), "progress_percent": 0})
        _write_state(directory, state)
    finally:
        with _jobs_lock:
            _active_jobs.pop(job_id, None)


def create_job(images: list[tuple[str, str, bytes]], dense: bool = True) -> dict[str, Any]:
    available = capabilities()
    if not available["available"]:
        raise RuntimeError(available["reason"])
    if len(images) < MIN_IMAGES:
        raise ValueError(f"COLMAP needs at least {MIN_IMAGES} overlapping views for this workflow; more viewpoints are strongly recommended for terrain.")
    if len(images) > MAX_IMAGES:
        raise ValueError(f"A reconstruction can contain at most {MAX_IMAGES} images.")
    total = sum(len(content) for _, _, content in images)
    if total > MAX_TOTAL_BYTES:
        raise ValueError("The image set exceeds the 250 MB local job limit.")
    if any(len(content) > MAX_IMAGE_BYTES for _, _, content in images):
        raise ValueError("Each source image must be 20 MB or smaller.")
    with _jobs_lock:
        if len(_active_jobs) >= 2:
            raise RuntimeError("The local worker is busy. Wait for the active reconstruction before adding another.")
        job_id = str(uuid.uuid4())
        directory = job_root() / job_id
        image_dir = directory / "images"
        image_dir.mkdir(parents=True, exist_ok=False)
        for index, (content_type, _filename, content) in enumerate(images, start=1):
            image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                shutil.rmtree(directory, ignore_errors=True)
                raise ValueError(f"View {index} is not a readable image.")
            if image.shape[1] < 1280 or image.shape[0] < 720:
                shutil.rmtree(directory, ignore_errors=True)
                raise ValueError(f"View {index} is {image.shape[1]} × {image.shape[0]}; use the original image at 1280 × 720 or larger.")
            if image.shape[1] * image.shape[0] > 50_000_000:
                shutil.rmtree(directory, ignore_errors=True)
                raise ValueError(f"View {index} exceeds the 50-megapixel safety limit.")
            suffix = ".png" if content_type == "image/png" else ".jpg"
            (image_dir / f"view-{index:03}{suffix}").write_bytes(content)
        state: dict[str, Any] = {
            "job_id": job_id,
            "status": "queued",
            "stage": "Queued for the local COLMAP worker",
            "progress_percent": 0,
            "created_at": _now(),
            "updated_at": _now(),
            "image_count": len(images),
            "source_bytes": total,
            "dense_requested": dense,
            "summary": None,
        }
        _write_state(directory, state)
        _active_jobs[job_id] = _executor.submit(_execute_job, job_id)
    return state


def get_job(job_id: str) -> dict[str, Any]:
    state = _read_job(job_id)
    with _jobs_lock:
        active = job_id in _active_jobs
    if state["status"] in {"queued", "running"} and not active:
        state.update({"status": "failed", "stage": "Worker stopped", "error": "The local worker stopped before this job finished. Start a new reconstruction.", "progress_percent": 0})
        _write_state(_job_dir(job_id), state)
    return state


def _parse_camera_positions(directory: Path) -> dict[str, np.ndarray]:
    path = directory / "camera-positions.csv"
    if not path.is_file():
        raise ValueError("Camera positions are not available for this reconstruction.")
    positions: dict[str, np.ndarray] = {}
    with path.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            positions[row["image_name"]] = np.asarray([float(row[key]) for key in ("x_model_units", "y_model_units", "z_model_units")], dtype=np.float64)
    return positions


def validate_scale(job_id: str, csv_bytes: bytes) -> dict[str, Any]:
    if len(csv_bytes) > 1_000_000:
        raise ValueError("Scale baseline CSV must be under 1 MB.")
    directory = _job_dir(job_id)
    state = get_job(job_id)
    if state["status"] not in {"completed", "completed_sparse"}:
        raise ValueError("Wait for a usable sparse reconstruction before checking scale.")
    for stale_metric_cloud in ("sparse-metric.ply", "dense-metric.ply"):
        (directory / stale_metric_cloud).unlink(missing_ok=True)
    try:
        rows = list(csv.DictReader(csv_bytes.decode("utf-8-sig").splitlines()))
    except (UnicodeDecodeError, csv.Error) as error:
        raise ValueError("Scale baseline must be a UTF-8 CSV file.") from error
    rows = [row for row in rows if any((value or "").strip() for value in row.values())]
    if not rows or not {"image_a", "image_b", "measured_distance_m"}.issubset(rows[0]):
        raise ValueError("CSV columns must be image_a,image_b,measured_distance_m.")
    if len(rows) < 3:
        raise ValueError("Provide at least three independently measured camera-position baselines: one calibration baseline and two validation baselines.")
    if len(rows) > 200:
        raise ValueError("Use at most 200 baseline measurements.")
    positions = _parse_camera_positions(directory)
    camera_pairs: set[frozenset[str]] = set()
    parsed: list[tuple[str, str, float, float]] = []
    for index, row in enumerate(rows, start=1):
        image_a, image_b = row["image_a"].strip(), row["image_b"].strip()
        if not image_a or not image_b or image_a == image_b:
            raise ValueError(f"Baseline {index} must name two different registered images.")
        if image_a not in positions or image_b not in positions:
            raise ValueError(f"Baseline {index} references an unregistered image. Use names from camera-positions.csv.")
        key = frozenset((image_a, image_b))
        if key in camera_pairs:
            raise ValueError(f"Baseline {index} repeats an image pair; use independent baselines.")
        camera_pairs.add(key)
        try:
            known = float(row["measured_distance_m"])
        except (TypeError, ValueError) as error:
            raise ValueError(f"Baseline {index} needs a measured distance in meters.") from error
        model_distance = float(np.linalg.norm(positions[image_a] - positions[image_b]))
        if not np.isfinite(known) or known <= 0 or not np.isfinite(model_distance) or model_distance <= 1e-8:
            raise ValueError(f"Baseline {index} must have positive measured and reconstructed distances.")
        parsed.append((image_a, image_b, known, model_distance))
    if len({image for row in parsed for image in row[:2]}) < 4:
        raise ValueError("Use baselines spanning at least four distinct registered camera positions.")

    calibration = parsed[0]
    scale = calibration[2] / calibration[3]
    validations = []
    for index, (image_a, image_b, known, model_distance) in enumerate(parsed):
        predicted = model_distance * scale
        error_percent = abs(predicted - known) / known * 100
        validations.append({
            "image_a": image_a,
            "image_b": image_b,
            "measured_distance_m": round(known, 4),
            "reconstructed_distance_model_units": round(model_distance, 6),
            "scaled_distance_m": round(predicted, 4),
            "absolute_error_percent": round(error_percent, 2),
            "role": "calibration" if index == 0 else "independent_validation",
            "passed": error_percent <= SCALE_TOLERANCE_PERCENT,
        })
    validation_errors = [entry["absolute_error_percent"] for entry in validations[1:]]
    passed = all(entry["passed"] for entry in validations[1:])
    report: dict[str, Any] = {
        "status": "validated" if passed else "failed_validation",
        "scale_meters_per_model_unit": scale,
        "calibration_baseline": validations[0],
        "independent_validation_baselines": validations[1:],
        "independent_validation_count": len(validation_errors),
        "max_validation_error_percent": max(validation_errors, default=None),
        "tolerance_percent": SCALE_TOLERANCE_PERCENT,
        "validated": passed,
        "coordinate_frame": "COLMAP orientation and origin retained; distances are metric-scaled.",
        "warning": "Scale is only as accurate as the measured camera-center baselines. Do not use approximate GPS or estimated walking distance as survey control.",
    }
    (directory / "scale-validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if passed:
        for source_name, output_name in (("sparse.ply", "sparse-metric.ply"), ("dense.ply", "dense-metric.ply")):
            source_path = directory / source_name
            if not source_path.is_file():
                continue
            ply_data = PlyData.read(str(source_path))
            elements = []
            for element in ply_data.elements:
                data = element.data.copy()
                if element.name == "vertex":
                    for axis in ("x", "y", "z"):
                        if axis in data.dtype.names:
                            data[axis] = data[axis].astype(np.float64) * scale
                elements.append(PlyElement.describe(data, element.name, comments=element.comments))
            PlyData(elements, text=ply_data.text, byte_order=ply_data.byte_order, comments=ply_data.comments, obj_info=ply_data.obj_info).write(str(directory / output_name))
        report["scaled_point_clouds"] = [name for name in ("sparse-metric.ply", "dense-metric.ply") if (directory / name).is_file()]
        (directory / "scale-validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def artifact_path(job_id: str, name: str) -> Path:
    allowed = {
        "sparse.ply", "dense.ply", "sparse-metric.ply", "dense-metric.ply",
        "camera-positions.csv", "diagnostics.json", "scale-validation.json", "colmap.log",
        "cleaned-point-cloud.ply", "viewer-point-cloud.json", "geometry-analysis.json", "segmentation-report.json",
    }
    if name not in allowed:
        raise FileNotFoundError("Unknown reconstruction artifact.")
    path = _job_dir(job_id) / name
    if not path.is_file():
        raise FileNotFoundError("Artifact is not available yet.")
    return path


def delete_job(job_id: str) -> None:
    directory = _job_dir(job_id)
    root = job_root().resolve()
    if directory.parent.resolve() != root or directory.resolve() == root:
        raise ValueError("Reconstruction workspace path is invalid.")
    with _jobs_lock:
        if job_id in _active_jobs:
            raise RuntimeError("Wait for the active reconstruction to finish before deleting its files.")
    if not directory.is_dir():
        raise FileNotFoundError("Unknown reconstruction job.")
    shutil.rmtree(directory)
