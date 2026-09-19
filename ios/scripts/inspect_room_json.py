#!/usr/bin/env python3
"""Read-only sanity check for an actual Rumi/Apple CapturedRoom export."""
import argparse
import json
import math
from pathlib import Path


def numbers(value):
    if isinstance(value, list):
        return [number for item in value for number in numbers(item)]
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return [value]
    raise ValueError("expected finite numeric arrays")


def inspect(path):
    room = json.loads(path.read_text())
    if not isinstance(room, dict):
        raise ValueError("expected the CapturedRoom object at the JSON root")
    print(f"File: {path.name}")
    print(f"Root fields: {', '.join(sorted(room))}")
    print(f"Version: {room.get('version', 'not encoded by this OS')}")
    total = 0
    for name in ("walls", "floors", "doors", "windows", "openings", "objects"):
        if name == "floors" and name not in room:
            print("floors: absent in this encoding")
            continue
        items = room.get(name)
        if not isinstance(items, list):
            raise ValueError(f"{name}: missing array")
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"{name}[{index}]: expected an object")
            for field in ("identifier", "dimensions", "transform", "category", "confidence"):
                if field not in item:
                    raise ValueError(f"{name}[{index}]: missing {field}")
            if len(numbers(item["dimensions"])) != 3:
                raise ValueError(f"{name}[{index}]: expected three dimensions")
            if len(numbers(item["transform"])) != 16:
                raise ValueError(f"{name}[{index}]: expected a 4x4 transform")
        total += len(items)
        print(f"{name}: {len(items)}; checked identifiers, dimensions, transforms, categories, confidence")
    if not room["walls"]:
        raise ValueError("no walls; scan the room again")
    if not room["objects"]:
        print("No objects detected. Verify against the room; an empty array can be valid.")
    print(f"Checked {total} elements. File was not changed. This does not validate measurement accuracy.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="An actual exported rumi-room-*.json file")
    args = parser.parse_args()
    try:
        inspect(args.file)
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, f"Inspection failed: {error}\n")
