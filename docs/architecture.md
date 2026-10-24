# Architecture and processing pipeline

## Starter shape

Terra Sight starts as a modular monolith. The browser interface and FastAPI service are served from one origin; processing stages will be separate Python modules/jobs behind the API. This is simple to run locally while keeping the processing boundary portable to a worker later.

```text
Browser (desktop upload or mobile capture)
        |
        v
FastAPI application
  |-- session and upload endpoints (planned)
  |-- image validation service (planned)
  |-- processing job interface (planned)
  |-- results and report endpoints (planned)
        |
        +--> local filesystem for image and generated artifacts (initially)
        +--> SQLite for session/job metadata (when persistence is added)
        +--> CV / photogrammetry / segmentation workers (planned)
        |
        v
Three.js viewer and downloadable report (planned)
```

## Planned stack

- Frontend: HTML, CSS, JavaScript initially; Three.js for the interactive 3D viewer.
- API: FastAPI.
- Image checks and matching: OpenCV and NumPy.
- Reconstruction: COLMAP / pycolmap.
- Segmentation: PyTorch; candidate model families include YOLO segmentation and DeepLab/MobileNet.
- Geometry processing: Open3D or suitable mesh-processing libraries.
- Initial metadata: SQLite; local file storage for development artifacts.

These are architectural candidates, not dependencies required by the starter app. GPU/CUDA-specific packages and COLMAP binaries should be selected only when their compatibility and machine setup are documented.

## Data flow

1. **Capture input:** accept an existing image batch or collect images in a mobile browser. The initial interface is a shell; upload and camera features are not implemented yet.
2. **Input checks:** validate readable formats, resolution, duplicates, blur, exposure, contrast, and detail.
3. **Coverage assessment:** match features across views, assess connected image groups and viewpoint diversity, and communicate likely gaps. Image count alone is not a coverage metric.
4. **Readiness response:** return a status such as ready, needs more images, or likely unsuitable, with reasons and confidence limits.
5. **Reconstruction:** estimate camera poses and geometry; report registration failures, sparse regions, holes, and scale confidence.
6. **Segmentation and geometry:** evaluate image masks independently, then map masks onto reconstructed geometry where correspondence is supported.
7. **Measurements:** compute only supported lengths/surface measures. Volume needs a scale and defensible reference surface; withhold it if quality checks fail.
8. **Results:** render the geometry and provide a downloadable report with data provenance, quality metrics, assumptions, and limitations.

## Processing and deployment boundary

Develop and benchmark locally on the Windows PC with the RTX 4050. Keep API request/response contracts independent of where jobs run. A local processing service is appropriate for early demos. Public use will need an accessible worker/service or a documented local-processing mode; a static public website cannot access files on a developer's PC. Benchmark CPU/GPU time, memory, storage, concurrent jobs, and hosting cost before selecting public infrastructure.

## Quality and safety requirements

- Separate pre-reconstruction image checks from reconstruction-time and final-geometry checks.
- Label estimates and uncertainty; do not state unsupported accuracy.
- Keep segmentation and geometry metrics reproducible and evaluate held-out sites/events.
- Warn against approaching active landslides, unstable slopes, cliff edges, or restricted land.
- Avoid collecting precise location metadata unless it is needed and its use is clear.
- Describe the product as experimental analysis, not an early-warning or professional geotechnical system.
