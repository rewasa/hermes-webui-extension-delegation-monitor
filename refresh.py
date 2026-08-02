#!/usr/bin/env python3
"""Refresh delegations.json and export live transcripts as data/logs/<id>.json.

Runs periodically (every 10s via launchd) to write same-origin JSON files
that the WebUI extension can fetch without mixed-content issues.
"""

import importlib.util
import json
import os
import sys
import tempfile
import time
from typing import Optional

DATA_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data"
)
OUTPUT_FILE = os.path.join(DATA_DIR, "delegations.json")
LOGS_DIR = os.path.join(DATA_DIR, "logs")

# Path to the delegation plugin API — do NOT modify this file
PLUGIN_API_PATH = os.path.expanduser(
    "~/.hermes/plugins/delegation/dashboard/plugin_api.py"
)

# Log export limits per task
MAX_LOG_LINES = 1500
MAX_LOG_BYTES = 400 * 1024  # 400 KB

# Possible live transcript directories (checked in order)
LIVE_DIRS = [
    os.path.expanduser("~/.hermes/profiles/worker/cache/delegation/live"),
    os.path.expanduser("~/.hermes/cache/delegation/live"),
]


def _load_plugin_api():
    """Import list_delegations() from the plugin API via importlib."""
    spec = importlib.util.spec_from_file_location("plugin_api", PLUGIN_API_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load spec from {PLUGIN_API_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_atomic(data: dict, output_path: str) -> None:
    """Write data atomically using tempfile + os.replace."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    prefix = os.path.basename(output_path).rsplit(".", 1)[0] + "_"
    fd, tmp_path = tempfile.mkstemp(
        suffix=".tmp",
        prefix=prefix,
        dir=os.path.dirname(output_path),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, output_path)
    except BaseException:
        # Clean up temp file on any error
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _find_live_dir(delegation_id: str) -> Optional[str]:
    """Find the live transcript directory for a delegation_id."""
    for base in LIVE_DIRS:
        candidate = os.path.join(base, delegation_id)
        if os.path.isdir(candidate):
            return candidate
    return None


def _export_logs(delegation_id: str) -> Optional[dict]:
    """Export transcript for a single delegation_id.

    Returns a dict suitable for data/logs/<id>.json, or None if no logs found.
    """
    live_dir = _find_live_dir(delegation_id)
    if live_dir is None:
        return None

    # Discover task log files: task-0.log, task-1.log, ...
    task_files = []
    for entry in sorted(os.listdir(live_dir), key=lambda x: x.lower()):
        if entry.startswith("task-") and entry.endswith(".log"):
            task_files.append(entry)

    if not task_files:
        return None

    tasks = []
    for filename in task_files:
        filepath = os.path.join(live_dir, filename)
        try:
            file_size = os.path.getsize(filepath)
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except (OSError, UnicodeDecodeError) as exc:
            # Skip unreadable log files
            tasks.append({
                "index": int(filename.replace("task-", "").replace(".log", "")),
                "lines": [f"[Fehler beim Lesen: {exc}]"],
                "truncated": False,
                "bytes_total": 0,
            })
            continue

        # Extract task index from filename
        task_index = int(filename.replace("task-", "").replace(".log", ""))

        # Apply size limits: keep LAST lines
        truncated = False
        total_lines = len(lines)

        # First check byte budget
        if file_size > MAX_LOG_BYTES:
            # Estimate how many lines fit in MAX_LOG_BYTES
            # Rough: read from end, keep last ~MAX_LOG_BYTES worth of lines
            byte_budget = MAX_LOG_BYTES
            kept_lines = []
            byte_count = 0
            for line in reversed(lines):
                line_bytes = len(line.encode("utf-8"))
                if byte_count + line_bytes > byte_budget:
                    break
                kept_lines.append(line)
                byte_count += line_bytes
            kept_lines.reverse()
            lines = kept_lines
            truncated = True
        elif total_lines > MAX_LOG_LINES:
            lines = lines[-MAX_LOG_LINES:]
            truncated = True

        # Strip trailing newlines from each line for cleaner display
        lines = [l.rstrip("\n\r") for l in lines]

        tasks.append({
            "index": task_index,
            "lines": lines,
            "truncated": truncated,
            "bytes_total": file_size,
        })

    return {
        "delegation_id": delegation_id,
        "generated_at": time.time(),
        "tasks": tasks,
    }


def _cleanup_stale_logs(active_ids: set) -> None:
    """Remove log files for delegation_ids no longer in the active set."""
    if not os.path.isdir(LOGS_DIR):
        return
    for entry in os.listdir(LOGS_DIR):
        if not entry.endswith(".json"):
            continue
        delegation_id = entry[:-5]  # strip .json
        if delegation_id not in active_ids:
            try:
                os.unlink(os.path.join(LOGS_DIR, entry))
            except OSError:
                pass


def main():
    try:
        api = _load_plugin_api()
        result = api.list_delegations()
        delegations = result.get("delegations", [])
        count = result.get("count", len(delegations))
        payload = {
            "delegations": delegations,
            "count": count,
            "generated_at": time.time(),
        }
    except Exception as exc:
        # Robust error fallback — never crash
        payload = {
            "delegations": [],
            "count": 0,
            "error": str(exc)[:200],
            "generated_at": time.time(),
        }
        _write_atomic(payload, OUTPUT_FILE)
        return

    _write_atomic(payload, OUTPUT_FILE)

    # --- Log export ---
    # Only export logs for delegations in the current list (max 20)
    active_ids = set()
    for d in delegations[:20]:
        did = d.get("delegation_id", "")
        if did:
            active_ids.add(did)
            try:
                log_data = _export_logs(did)
                if log_data is not None:
                    os.makedirs(LOGS_DIR, exist_ok=True)
                    log_path = os.path.join(LOGS_DIR, f"{did}.json")
                    _write_atomic(log_data, log_path)
            except Exception:
                # Single delegation failure must not break the whole refresh
                pass

    # Clean up stale log files
    try:
        _cleanup_stale_logs(active_ids)
    except Exception:
        pass


if __name__ == "__main__":
    main()
