# Initial roadmap

Flexible timeline; milestones are defined by usable evidence and deliverables rather than calendar dates.

## 1. Project foundation

- Repository structure, Python virtual environment, FastAPI health route, frontend shell, experiment conventions, architecture and roadmap.
- Deliverable: reproducible local app skeleton.

## 2. Capture Readiness Checker

- [x] Batch image upload, file/resolution checks, blur and exposure checks, duplicate detection, initial feature matching.
- [x] Return an explainable readiness assessment and identify likely gaps.
- [x] Deliverable: upload-to-readiness workflow with per-image feedback and a feature connectivity graph.

## 3. Reconstruction engine

- Integrate COLMAP, inspect camera registration and sparse point cloud, record failure reasons.
- Define scale calibration and geometry quality checks against controlled reference scenes.
- Deliverable: repeatable reconstruction run and quantitative geometry report.

## 4. Guided mobile capture

- Responsive camera flow, safe capture instructions, quality feedback, review before submission.
- Add camera-pose or adaptive coverage guidance only after the base reconstruction pipeline works.
- Deliverable: mobile-browser session that enters the same validation/reconstruction pipeline.

## 5. Landslide segmentation

- Choose a documented label taxonomy and prepare public-data baseline.
- Compare model candidates and evaluate by held-out site/event.
- Deliverable: evaluated model with per-class IoU, precision, recall, and limitations.

## 6. 3D analysis

- Map image masks to reconstructed geometry where supported.
- Add measured dimensions and a reference-surface method for volume.
- Deliverable: measurements checked against known references, with quality-based withholding.

## 7. Product completion

- Interactive 3D viewer, downloadable reports, safety and uncertainty messaging, error handling.
- Benchmark local resource needs and prepare a realistic deployment/demo.
- Deliverable: coherent application, reproducible benchmark, documentation, demo.

## Cross-cutting work

Dataset review and frontend work can progress alongside early reconstruction experiments. Keep segmentation and reconstruction evaluation separate until each has a credible baseline. Do not begin expensive model training until available data and required outputs are understood.
