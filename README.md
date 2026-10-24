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

Install the Python dependencies with `pip install -r requirements.txt`. COLMAP is a separate native application and is not installed by pip. On Windows, install a COLMAP binary (CUDA support is needed for dense stereo) and set its executable path before starting the API:

```powershell
$env:COLMAP_EXECUTABLE = 'C:\path\to\COLMAP.bat'
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

The app's **3D Scene** page checks for the local COLMAP worker. Use the app at `http://127.0.0.1:8000`; a deployed Vercel function cannot run this local worker. See the [COLMAP Windows installation guide](https://colmap.github.io/install.html).

### Local geometry analysis, Three.js viewer, and segmentation

The Open3D, PyTorch, and scikit-learn stack is deliberately separate from Vercel's small API dependencies. Install it only on the Windows machine that runs the local worker:

```powershell
pip install -r requirements-local.txt
```

After a completed reconstruction, **Analyse point cloud** filters the selected PLY, reports its extents, writes a clean PLY and browser-safe point sample, then opens the interactive Three.js viewer. Extents remain COLMAP model units until the existing scale validation succeeds; the analysis does not calculate landslide volume.

Segmentation needs a model trained for a documented label class. The baseline trainer expects one RGB image and one same-name white/black PNG mask per sample:

```powershell
python experiments/train_segmentation.py --images D:\dataset\images --masks D:\dataset\masks --output data\models\landslide-mask.pt --class-name landslide --epochs 20
$env:TERRASIGHT_SEGMENTATION_CHECKPOINT = "$PWD\data\models\landslide-mask.pt"
uvicorn app.main:app --app-dir backend --reload
```

The script creates an 80/20 split and saves held-out IoU and F1 in the checkpoint. The app only enables **Run trained segmentation** when that checkpoint and PyTorch are available. It produces per-view masks and overlays; it does not claim that 2D masks are registered to 3D points.

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

The browser workspace supports selecting multiple terrain images, mobile camera capture, a local photo gallery and ZIP export. The Capture Quality view sends a compressed batch to FastAPI for temporary image checks (resolution, blur, exposure, contrast, texture and exact duplicates) and OpenCV ORB feature matching with a geometric-consistency check. It returns per-image findings, match connectivity and readiness feedback. The API does not retain these quality-check uploads; the session ID is a client correlation key. The deployed Vercel service handles this small-batch check only. Vercel's request-body limit is 4.5 MB, so the browser prepares a batch below 3.8 MB and the API accepts at most 4,000,000 bytes per request.

The **local** reconstruction worker requires at least 8 original JPEG/PNG photos (up to 100; 20 MB each, 250 MB total) and runs COLMAP SIFT extraction, exhaustive matching with geometric verification, incremental camera registration/bundle adjustment, sparse point export, and optional CUDA PatchMatch stereo plus geometric fusion for a dense PLY. Full-resolution originals and outputs are retained under `data/processed/reconstructions/{job_id}` until the job is deleted through the UI or API. The scale workflow uses measured camera-center baselines: one calibrates the uniform scale, and at least two independent baselines must validate within 5% before metric PLY copies are produced. The point-cloud frame keeps COLMAP's arbitrary orientation and origin; this is not georeferencing. Use one camera and lens, capture sharp textured images with substantial overlap, and include viewpoint movement. A single image cannot provide 3D reconstruction.

For a landslide surface, capture many overlapping views from stable ground using one camera and lens. Vegetation, moving material, repeated textures, strong shadows, or weak viewpoint change can prevent registration. Review the registration and reprojection report; no successful SfM run guarantees a complete or survey-grade model. Controlled terrain benchmarks, held-out geometry validation, and held-out segmentation evaluation remain required before interpreting outputs.

The API contract is documented in the FastAPI OpenAPI page at `/docs`. Create a correlation session with `POST /api/sessions`, then send an ordered `multipart/form-data` batch to `POST /api/sessions/{session_id}/readiness` using repeated `files` fields and an `original_dimensions` JSON field. Supported decoded formats are JPEG, PNG and WebP. The browser converts selected images to JPEG before sending them. For reconstruction the browser checks `GET /api/reconstructions/capabilities`, submits original files to `POST /api/reconstructions`, polls the returned job ID, and downloads artifacts from its artifact routes. Scale validation accepts a baseline CSV at `POST /api/reconstructions/{job_id}/scale`.
