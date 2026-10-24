# Experiments

Keep experiments reproducible and separate from application code.

For each experiment, record:

- Question and hypothesis
- Dataset name, version, source, terms, and site/event split
- Preprocessing and label taxonomy
- Hardware, software versions, and random seeds where applicable
- Method, metrics, results, failures, and interpretation
- Limitations and next step

Do not place downloaded datasets, trained weights, image collections, or generated point clouds in Git. Store those locally under `data/`; document the source and retrieval steps here or in the experiment record. Split by site or landslide event when possible to reduce leakage between train and evaluation data.
