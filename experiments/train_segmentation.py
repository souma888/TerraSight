"""Train and evaluate a binary terrain-mask model from images/ and masks/ folders.

Usage: python experiments/train_segmentation.py --images PATH --masks PATH --output data/models/terrain-mask.pt
Each image must have a same-stem PNG mask, where white is the target class.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
import torch
from sklearn.metrics import f1_score, jaccard_score
from torch.utils.data import DataLoader, Dataset, random_split

from backend.app.services.postprocess import build_terrain_model


class TerrainMasks(Dataset):
    def __init__(self, images: Path, masks: Path) -> None:
        self.items = [(path, masks / f"{path.stem}.png") for path in sorted(images.glob("*")) if (masks / f"{path.stem}.png").is_file()]
        if len(self.items) < 8:
            raise ValueError("Provide at least 8 matched image/mask pairs.")

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        image_path, mask_path = self.items[index]
        image = cv2.cvtColor(cv2.imread(str(image_path)), cv2.COLOR_BGR2RGB)
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        image = cv2.resize(image, (512, 512), interpolation=cv2.INTER_AREA)
        mask = cv2.resize(mask, (512, 512), interpolation=cv2.INTER_NEAREST)
        return torch.from_numpy(image.transpose(2, 0, 1)).float() / 255.0, torch.from_numpy((mask > 127).astype(np.float32))[None]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--masks", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--class-name", default="target", help="Name represented by white mask pixels, such as landslide.")
    args = parser.parse_args()
    dataset = TerrainMasks(args.images, args.masks)
    validation_size = max(1, round(len(dataset) * 0.2))
    train, validation = random_split(dataset, [len(dataset) - validation_size, validation_size], generator=torch.Generator().manual_seed(42))
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = build_terrain_model(torch).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4)
    criterion = nn.BCEWithLogitsLoss()
    for _ in range(args.epochs):
        model.train()
        for images, masks in DataLoader(train, batch_size=4, shuffle=True):
            images, masks = images.to(device), masks.to(device)
            optimizer.zero_grad()
            loss = criterion(model(images), masks)
            loss.backward()
            optimizer.step()
    model.eval()
    truth, predicted = [], []
    with torch.no_grad():
        for images, masks in DataLoader(validation, batch_size=2):
            logits = model(images.to(device))
            predicted.extend((torch.sigmoid(logits).cpu().numpy() > 0.5).reshape(-1))
            truth.extend((masks.numpy() > 0.5).reshape(-1))
    metrics = {"validation_iou": float(jaccard_score(truth, predicted, zero_division=0)), "validation_f1": float(f1_score(truth, predicted, zero_division=0)), "validation_images": len(validation)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model_state_dict": model.cpu().state_dict(), "metrics": metrics, "architecture": "TinyUNet", "input_size": 512, "class_name": args.class_name}, args.output)
    print(metrics)


if __name__ == "__main__":
    main()
