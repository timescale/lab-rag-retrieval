#!/usr/bin/env python3
"""Convert a Parquet file to JSONL on stdout."""

import sys
import pandas as pd

if len(sys.argv) < 2:
    print("Usage: parquet_to_jsonl.py <file.parquet>", file=sys.stderr)
    sys.exit(1)

df = pd.read_parquet(sys.argv[1])
for _, row in df.iterrows():
    print(row.to_json())
