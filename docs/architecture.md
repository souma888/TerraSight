# Architecture and processing pipeline

## Starter shape

Terra Sight starts as a modular monolith. The browser interface and FastAPI service are served from one origin; processing stages will be separate Python modules/jobs behind the API. This is simple to run locally while keeping the processing boundary portable to a worker later.

```text
Browser (desktop upload or mobile capture)
        |
        v
FastAPI application
  |-- session correlation endpoint (implemented; stateless)
  |-- batch readiness endpoint (implemented)
  |-- image validation and OpenCV feature matching (implemented)
  |-- COLMAP local job API (implemented; local only)
  |-- sparse/dense point-cloud and camera diagnostics (implemented)
  |-- measured camera-baseline scale validation (implemented)
  |-- Open3D filtering and geometric diagnostics (implemented; local only)
  |-- trained PyTorch mask inference (implemented; checkpoint required)
  |-- production worker/storage integration (planned)
        |
        +--> local filesystem for reconstruction jobs and artifacts (implemented locally)
        +--> SQLite for session/job metadata (when persistence is added)
        +--> CV / photogrammetry / segmentation workers (local implementation; persistent worker planned)
        |
        v
Three.js viewer and downloadable reports (implemented locally)
```

## Planned stack

- Frontend: HTML, CSS, JavaScript initially; Three.js for the interactive 3D viewer.
- API: FastAPI.
- Image checks and matching: OpenCV and NumPy.
- Reconstruction: COLMAP command-line workflow on a local worker.
- Segmentation: PyTorch; candidate model families include YOLO segmentation and DeepLab/MobileNet.
- Geometry processing: Open3D or suitable mesh-processing libraries.
- Initial metadata: SQLite; local file storage for development artifacts.

COLMAP is invoked as a separate native executable; dense reconstruction requires a COLMAP build with CUDA support. Open3D, PyTorch, and scikit-learn remain optional local-worker packages in `requirements-local.txt` so the deployed API bundle stays small.

## Data flow

1. **Capture input:** select an image batch or collect images in the mobile browser. The browser converts the ordered batch to JPEG under the request-size budget and keeps original dimensions as metadata.
2. **Input checks:** the FastAPI endpoint validates batch count, size, format and decodability, then screens resolution, blur, exposure, contrast, exact duplicates and feature count.
3. **Feature connectivity:** ORB descriptors are matched pairwise with a ratio test and RANSAC homography check; the API returns matched pairs and connected image groups. This is a screening proxy, not a percentage measurement of scene overlap.
4. **Readiness response:** return `ready_to_attempt`, `needs_more_images`, or `needs_review`, per-view findings, likely gaps and limitations. The session ID is a correlation key only; request data and results are not stored by the API.
5. **Reconstruction:** COLMAP SIFT extraction → exhaustive matching/geometric verification → incremental mapper and bundle adjustment → best registered sparse model. Report camera registration fraction, reprojection error, sparse point count, and unregistered images. Optionally run image undistortion, CUDA PatchMatch stereo, and geometric stereo fusion to write a dense PLY.
6. **Segmentation and geometry:** Open3D removes statistical outliers, records bounds and creates a sampled PLY payload for Three.js. A configured PyTorch checkpoint produces independent per-view masks and overlays, with its held-out metrics retained in the report. Mapping masks to 3D geometry remains a later correspondence stage.
7. **Measurements:** compute only supported lengths/surface measures. Volume needs a scale and defensible reference surface; withhold it if quality checks fail.
8. **Results:** render the geometry and provide a downloadable report with data provenance, quality metrics, assumptions, and limitations.

## Processing and deployment boundary

The readiness endpoint runs synchronously and keeps processing arrays/descriptors in invocation memory only. Vercel Functions have a 4.5 MB request-body limit; the frontend targets a smaller 3.8 MB encoded-image budget and the API caps image bytes at 4,000,000 per request. COLMAP, Open3D analysis, and checkpoint inference are disabled in Vercel because they need native/large local dependencies and retained job files. Locally, the API writes full-resolution images, the COLMAP database, job state, logs, diagnostics, masks, and PLY outputs beneath `data/processed/reconstructions/`; jobs run in a single local worker thread and are polled by job ID. This filesystem-backed job worker is deliberately not treated as durable or shared across hosts. Public reconstruction needs an authenticated persistent worker and object storage/job database, with uploads sent directly to storage rather than through a Vercel function. Keep API request/response contracts independent of where jobs run.

COLMAP output has arbitrary scale/origin/orientation. The local scale procedure measures distances between registered camera centers: the first CSV baseline supplies a uniform meters-per-model-unit factor; at least two additional, distinct baselines are held out as validation checks. Validation passes only when each is within 5% of its measured distance. A passing check writes separate `sparse-metric.ply` and (when available) `dense-metric.ply` copies; the original unscaled outputs are preserved. This threshold is a project screening rule, not a geodetic accuracy claim. Scale remains only as trustworthy as the independently measured camera-center distances, and the aligned model is not georeferenced.

## Quality and safety requirements

- Separate pre-reconstruction image checks from reconstruction-time and final-geometry checks.
- Label estimates and uncertainty; do not state unsupported accuracy.
- Keep segmentation and geometry metrics reproducible and evaluate held-out sites/events.
- Warn against approaching active landslides, unstable slopes, cliff edges, or restricted land.
- Avoid collecting precise location metadata unless it is needed and its use is clear.
- Describe the product as experimental analysis, not an early-warning or professional geotechnical system.
