"""Browser-upload capture screening using OpenCV and NumPy.

These metrics are pre-reconstruction signals. They do not establish camera poses,
true scene coverage, scale, or geotechnical accuracy.
"""

from __future__ import annotations

import hashlib
from collections import deque
from typing import Any

import cv2
import numpy as np

MIN_WIDTH = 1280
MIN_HEIGHT = 720
MIN_VIEWS = 5
TARGET_MATCHED_RATIO = 0.7
MAX_IMAGE_BYTES = 3_800_000


def _image_features(image: np.ndarray) -> tuple[list[cv2.KeyPoint], np.ndarray | None]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(nfeatures=1800, scaleFactor=1.2, nlevels=8, fastThreshold=12)
    keypoints, descriptors = orb.detectAndCompute(gray, None)
    return keypoints, descriptors


def _pair_match(left: np.ndarray | None, right: np.ndarray | None) -> dict[str, Any]:
    if left is None or right is None or len(left) < 2 or len(right) < 2:
        return {"matched": False, "good_matches": 0, "inliers": 0, "inlier_ratio": 0.0}
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    pairs = matcher.knnMatch(left, right, k=2)
    good = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance]
    inliers = 0
    ratio = 0.0
    if len(good) >= 8:
        source = np.float32([left[match.queryIdx].pt for match in good]).reshape(-1, 1, 2)
        target = np.float32([right[match.trainIdx].pt for match in good]).reshape(-1, 1, 2)
        try:
            _, mask = cv2.findHomography(source, target, cv2.RANSAC, 4.0)
            if mask is not None:
                inliers = int(mask.sum())
                ratio = inliers / len(good)
        except cv2.error:
            pass
    matched = inliers >= 10 and ratio >= 0.18
    return {
        "matched": matched,
        "good_matches": len(good),
        "inliers": inliers,
        "inlier_ratio": round(ratio, 3),
    }


def _components(count: int, edges: list[tuple[int, int]]) -> list[list[int]]:
    graph = [[] for _ in range(count)]
    for left, right in edges:
        graph[left].append(right)
        graph[right].append(left)
    seen: set[int] = set()
    groups: list[list[int]] = []
    for start in range(count):
        if start in seen:
            continue
        queue = deque([start])
        seen.add(start)
        group: list[int] = []
        while queue:
            current = queue.popleft()
            group.append(current)
            for neighbor in graph[current]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    queue.append(neighbor)
        groups.append(sorted(group))
    return groups


def analyze_batch(
    uploads: list[tuple[str, bytes, tuple[int, int] | None]],
) -> dict[str, Any]:
    """Analyze an ordered image batch and return per-image and pairwise signals."""
    records: list[dict[str, Any]] = []
    descriptors: list[np.ndarray | None] = []
    hashes: dict[str, int] = {}

    for index, (filename, content, original_dimensions) in enumerate(uploads):
        raw = np.frombuffer(content, dtype=np.uint8)
        image = cv2.imdecode(raw, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"Image {index + 1} ({filename}) could not be decoded.")
        height, width = image.shape[:2]
        if width * height > 50_000_000:
            raise ValueError(f"Image {index + 1} ({filename}) is over 50 megapixels and cannot be screened safely.")
        original_width, original_height = original_dimensions or (width, height)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        brightness = float(gray.mean())
        contrast = float(gray.std())
        digest = hashlib.sha256(content).hexdigest()
        duplicate_of = hashes.get(digest)
        hashes.setdefault(digest, index)
        keypoints, image_descriptors = _image_features(image)
        descriptors.append(image_descriptors)

        issues: list[str] = []
        if original_width < MIN_WIDTH or original_height < MIN_HEIGHT:
            issues.append(f"Low resolution: {original_width} × {original_height}; use at least {MIN_WIDTH} × {MIN_HEIGHT}.")
        if blur_score < 55:
            issues.append("Image may be blurred; hold the camera steady and retake it.")
        if brightness < 35:
            issues.append("Image is very dark; use a brighter exposure.")
        elif brightness > 225:
            issues.append("Image is very bright; avoid washed-out highlights.")
        if contrast < 20:
            issues.append("Image has little visible texture; choose a clearer view of the terrain.")
        if len(keypoints) < 35:
            issues.append("Few distinctive features found; include textured ground and fixed landmarks.")
        if duplicate_of is not None:
            issues.append(f"Exact duplicate of view {duplicate_of + 1}; add a different viewpoint.")

        records.append({
            "index": index,
            "filename": filename,
            "width": int(original_width),
            "height": int(original_height),
            "blur_score": round(blur_score, 1),
            "brightness": round(brightness, 1),
            "contrast": round(contrast, 1),
            "feature_count": len(keypoints),
            "duplicate_of": duplicate_of,
            "quality": "review" if issues else "good",
            "issues": issues,
        })

    pair_results: list[dict[str, Any]] = []
    edges: list[tuple[int, int]] = []
    for left in range(len(descriptors)):
        for right in range(left + 1, len(descriptors)):
            match = _pair_match(descriptors[left], descriptors[right])
            pair_results.append({"left": left, "right": right, **match})
            if match["matched"]:
                edges.append((left, right))

    groups = _components(len(records), edges)
    largest_group = max(groups, key=len, default=[])
    matched_ratio = len(largest_group) / len(records) if records else 0.0
    quality_problem_count = sum(bool(record["issues"]) for record in records)
    reasons: list[str] = []
    if len(records) < MIN_VIEWS:
        reasons.append(f"Add at least {MIN_VIEWS - len(records)} more distinct views; {MIN_VIEWS} is a suggested minimum.")
    if quality_problem_count:
        reasons.append(f"Review image quality on {quality_problem_count} view(s) before reconstruction.")
    if len(records) > 1 and len(edges) == 0:
        reasons.append("No neighboring scene features could be matched. Retake views with more shared terrain details.")
    elif len(records) > 1 and matched_ratio < TARGET_MATCHED_RATIO:
        reasons.append(f"Only {len(largest_group)} of {len(records)} views are in the largest matched group; add intermediate overlapping viewpoints.")
    if not reasons:
        reasons.append("Image quality and feature connectivity look promising for a reconstruction attempt.")

    ready = len(records) >= MIN_VIEWS and quality_problem_count == 0 and matched_ratio >= TARGET_MATCHED_RATIO
    status = "ready_to_attempt" if ready else "needs_review" if len(records) >= MIN_VIEWS else "needs_more_images"
    return {
        "status": status,
        "ready": ready,
        "summary": "Promising for a reconstruction attempt" if ready else "Capture set needs attention",
        "image_count": len(records),
        "quality_issue_count": quality_problem_count,
        "feature_matching": {
            "matched_pairs": len(edges),
            "total_pairs": len(pair_results),
            "connected_components": len(groups),
            "largest_matched_group": len(largest_group),
            "matched_view_ratio": round(matched_ratio, 3),
            "pairs": pair_results,
        },
        "views": records,
        "feedback": reasons,
        "limitations": [
            "Feature connectivity is a screening signal, not a measured percentage of scene overlap.",
            "This check does not estimate camera poses, 3D completeness, scale, or measurement accuracy.",
            "Images are processed for this request and are not retained by the API.",
        ],
    }
