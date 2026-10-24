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

The browser workspace now supports selecting multiple local terrain images, mobile camera capture, capture movement cues, an approximate visual overlap estimate, a local photo gallery and ZIP export, and first-pass browser-side readiness checks. The overlap estimate is a capture aid, not a geometric measurement. Files remain in the current browser session. Server-side upload/storage, reconstruction, segmentation, quantitative validation, and report generation are still to be implemented; the 3D preview is illustrative.
