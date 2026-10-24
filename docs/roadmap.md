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

- [x] Integrate COLMAP SIFT extraction, pair matching/geometric verification, incremental mapping and camera registration on the local worker.
- [x] Export sparse point cloud and camera/reprojection diagnostics; optionally run dense CUDA MVS fusion.
- [x] Add camera-baseline scale calibration with independent validation checks and separate metric PLY output.
- [ ] Benchmark/validate against controlled terrain reference scenes and measured geometry before interpreting results.
- [ ] Connect a persistent, authenticated reconstruction worker to the public deployment.
- Deliverable: repeatable local SfM/MVS run and an explainable camera/point-cloud report; no survey accuracy claim until held-out validation is complete.

## 4. Guided mobile capture

- Responsive camera flow, safe capture instructions, quality feedback, review before submission.
- Add camera-pose or adaptive coverage guidance only after the base reconstruction pipeline works.
- Deliverable: mobile-browser session that enters the same validation/reconstruction pipeline.

## 5. Landslide segmentation

- Choose a documented label taxonomy and prepare public-data baseline.
- [x] Add a reproducible PyTorch binary-mask baseline trainer with an 80/20 split and scikit-learn IoU/F1 reporting.
- [x] Add local checkpoint inference with per-image mask/overlay output.
- [ ] Compare model candidates and evaluate by held-out site/event.
- Deliverable: evaluated model with per-class IoU, precision, recall, and limitations.

## 6. 3D analysis

- [x] Add Open3D statistical filtering, bounding-box diagnostics, downloadable clean PLY, and a sampled point-cloud export.
- [x] Add a Three.js point-cloud viewer in the local workspace.
- [ ] Map image masks to reconstructed geometry where supported.
- Add measured dimensions and a reference-surface method for volume.
- Deliverable: measurements checked against known references, with quality-based withholding.

## 7. Product completion

- Interactive 3D viewer, downloadable reports, safety and uncertainty messaging, error handling.
- Benchmark local resource needs and prepare a realistic deployment/demo.
- Deliverable: coherent application, reproducible benchmark, documentation, demo.

## Cross-cutting work

Dataset review and frontend work can progress alongside early reconstruction experiments. Keep segmentation and reconstruction evaluation separate until each has a credible baseline. Do not begin expensive model training until available data and required outputs are understood.
