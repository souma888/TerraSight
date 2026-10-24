# Terra Sight

Terra Sight is an independent, software-first terrain capture and analysis project with both portfolio and product goals. It aims to guide users from terrain photo capture or upload through capture-readiness checks, photogrammetric reconstruction, landslide-related segmentation, supported measurements, and transparent reporting.

The initial product is a responsive web application. Mobile capture will use the browser camera; a native app is outside the initial foundation.

## Project principles

- Treat capture readiness and reconstruction quality as core product features.
- Report uncertainty and limitations; withhold measurements when quality is insufficient.
- Keep image validation, reconstruction, segmentation, and reporting as separable processing stages.
- Start locally on Windows and defer public processing infrastructure until compute and cost are measured.
- Include safe-capture guidance. Terra Sight is not an early-warning system or a replacement for qualified geotechnical assessment.

## Repository layout

```text
backend/       FastAPI application and API routes
frontend/      Responsive browser interface skeleton
data/          Local-only datasets, models, and generated artifacts
docs/          Architecture, pipeline, and roadmap
experiments/   Reproducible research notes and experiment records
tests/         Reserved for automated checks as the foundation grows
```

## Local setup (Windows PowerShell)

Requires Python 3.11 or newer and Git.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
uvicorn app.main:app --app-dir backend --reload
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The API health endpoint is [http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health).

If PowerShell blocks activation, run the server with the environment's interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --reload
```

The starter requirements intentionally cover only the API and basic image-processing foundation. Install PyTorch/CUDA and reconstruction tooling in a later, separately documented step after checking the target machine's compatible builds. No model, dataset, or COLMAP binary is bundled.

## Initial workflow

1. Create a capture session and collect/upload images.
2. Check file integrity, resolution, blur, exposure, duplicates, feature matches, and likely coverage.
3. Return a readiness assessment with evidence and uncertainty.
4. Reconstruct cameras and geometry; inspect registration, completeness, and scale confidence.
5. Run segmentation and connect supported masks to 3D geometry.
6. Compute dimensions and, only with a defensible reference surface and scale, volume.
7. Present a 3D result and downloadable report with quality metrics and limitations.

See [docs/architecture.md](docs/architecture.md), [docs/roadmap.md](docs/roadmap.md), and [experiments/README.md](experiments/README.md).

## Current status

The browser workspace supports selecting multiple terrain images, mobile camera capture, a local photo gallery and ZIP export. The Capture Quality view sends a compressed batch to FastAPI for temporary image checks (resolution, blur, exposure, contrast, texture and exact duplicates) and OpenCV ORB feature matching with a geometric-consistency check. It returns per-image findings, match connectivity and readiness feedback. The API does not retain uploaded images or analysis results; the session ID is a client correlation key. Vercel request size is limited, so the browser prepares a batch below 3.8 MB and the API accepts at most 4,000,000 bytes per batch. The checks screen for capture problems; they do not reconstruct a scene or verify true coverage, camera poses, scale, or measurement accuracy. The 3D preview is illustrative. Reconstruction, segmentation, quantitative validation and report generation remain future work.

The API contract is documented in the FastAPI OpenAPI page at `/docs`. Create a correlation session with `POST /api/sessions`, then send an ordered `multipart/form-data` batch to `POST /api/sessions/{session_id}/readiness` using repeated `files` fields and an `original_dimensions` JSON field. Supported decoded formats are JPEG, PNG and WebP. The browser converts selected images to JPEG before sending them.
