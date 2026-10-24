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
  |-- reconstruction job interface (planned)
  |-- results persistence and report endpoints (planned)
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

1. **Capture input:** select an image batch or collect images in the mobile browser. The browser converts the ordered batch to JPEG under the request-size budget and keeps original dimensions as metadata.
2. **Input checks:** the FastAPI endpoint validates batch count, size, format and decodability, then screens resolution, blur, exposure, contrast, exact duplicates and feature count.
3. **Feature connectivity:** ORB descriptors are matched pairwise with a ratio test and RANSAC homography check; the API returns matched pairs and connected image groups. This is a screening proxy, not a percentage measurement of scene overlap.
4. **Readiness response:** return `ready_to_attempt`, `needs_more_images`, or `needs_review`, per-view findings, likely gaps and limitations. The session ID is a correlation key only; request data and results are not stored by the API.
5. **Reconstruction:** estimate camera poses and geometry; report registration failures, sparse regions, holes, and scale confidence.
6. **Segmentation and geometry:** evaluate image masks independently, then map masks onto reconstructed geometry where correspondence is supported.
7. **Measurements:** compute only supported lengths/surface measures. Volume needs a scale and defensible reference surface; withhold it if quality checks fail.
8. **Results:** render the geometry and provide a downloadable report with data provenance, quality metrics, assumptions, and limitations.

## Processing and deployment boundary

The readiness endpoint runs synchronously and keeps processing arrays/descriptors in invocation memory only. Vercel Functions have a 4.5 MB request-body limit; the frontend targets a smaller 3.8 MB encoded-image budget and the API caps image bytes at 4,000,000 per request. Large surveys need a direct-to-storage or chunked job flow before expanding the batch size. Reconstruction is long-running and must move to a durable worker/job system before it is connected to the public UI. Keep API request/response contracts independent of where jobs run. Benchmark CPU time, memory, concurrency, and hosting cost before selecting public infrastructure.

## Quality and safety requirements

- Separate pre-reconstruction image checks from reconstruction-time and final-geometry checks.
- Label estimates and uncertainty; do not state unsupported accuracy.
- Keep segmentation and geometry metrics reproducible and evaluate held-out sites/events.
- Warn against approaching active landslides, unstable slopes, cliff edges, or restricted land.
- Avoid collecting precise location metadata unless it is needed and its use is clear.
- Describe the product as experimental analysis, not an early-warning or professional geotechnical system.
