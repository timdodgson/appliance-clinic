#!/usr/bin/env python3
"""Durable Error-Code overlay store (S3) with last-good cache.

Shipped mappings stay in the image. Admin mutations write LEARNING_BUCKET /
error-code-admin/state.json. Lookup uses a short TTL plus last-good overlay so
a brief S3 failure cannot resurrect a retired mapping that this instance already
applied.
"""
from __future__ import annotations

import json
import os
import time

from catalogue_effective import empty_overlay, merge

STATE_KEY = os.environ.get("ERROR_CODE_OVERLAY_KEY") or "error-code-admin/state.json"
TTL_MS = int(os.environ.get("ERROR_CODE_OVERLAY_TTL_MS") or "10000")
LAST_GOOD_PATH = os.environ.get("ERROR_CODE_LAST_GOOD") or "/tmp/error-code-overlay-last-good.json"


class WriteConflict(Exception):
    """Another writer changed the overlay since it was read (S3 conditional write failed)."""


class StoreUnavailable(Exception):
    """The overlay could not be read or written; nothing was changed."""


def clone_overlay(o):
    return json.loads(json.dumps(o if isinstance(o, dict) else empty_overlay()))


class CatalogueStore:
    def __init__(self, baseline_mappings, baseline_enrichment, sources,
                 loader=None, saver=None, bucket=None, ttl_ms=None, now=None,
                 last_good_path=None):
        self.baseline_mappings = baseline_mappings
        self.baseline_enrichment = baseline_enrichment
        self.sources = sources or {}
        self.bucket = bucket if bucket is not None else os.environ.get("LEARNING_BUCKET") or ""
        self._loader = loader
        self._saver = saver
        self.ttl_ms = TTL_MS if ttl_ms is None else ttl_ms
        self._now = now or (lambda: time.time() * 1000)
        self._at = 0
        self._overlay = empty_overlay()
        self._overlay_state = "none"  # none | active | unavailable | malformed
        self._last_good = None
        self._snap = None
        # Last-good file is production-only (durable S3-backed store). Injected
        # loaders and bucket-less tests must not read leftover /tmp from other runs.
        if last_good_path is not None:
            self.last_good_path = last_good_path
        elif self.bucket and self._loader is None:
            self.last_good_path = LAST_GOOD_PATH
        else:
            self.last_good_path = ""
        self._load_last_good_file()

    def _load_last_good_file(self):
        if not self.last_good_path:
            return
        try:
            if os.path.isfile(self.last_good_path):
                rec = json.load(open(self.last_good_path))
                if isinstance(rec, dict) and isinstance(rec.get("records"), dict):
                    self._last_good = rec
                    self._overlay = rec
                    self._overlay_state = "active" if rec.get("records") else "none"
        except Exception:
            pass

    def _write_last_good(self, overlay):
        self._last_good = overlay
        if not self.last_good_path:
            return
        try:
            with open(self.last_good_path, "w") as f:
                json.dump(overlay, f)
        except Exception:
            pass

    def _s3(self):
        import boto3
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-west-1"
        if not getattr(self, "_s3c", None):
            self._s3c = boto3.client("s3", region_name=region)
        return self._s3c

    def _default_load(self):
        if not self.bucket:
            return empty_overlay(), "none"
        try:
            res = self._s3().get_object(Bucket=self.bucket, Key=STATE_KEY)
            raw = res["Body"].read().decode("utf-8")
            if not raw.strip():
                return empty_overlay(), "none"
            parsed = json.loads(raw)
            if not isinstance(parsed, dict) or isinstance(parsed, list):
                raise ValueError("malformed-overlay")
            if "records" in parsed and not isinstance(parsed.get("records"), dict):
                raise ValueError("malformed-overlay")
            return parsed, ("active" if parsed.get("records") else "none")
        except Exception as e:
            name = getattr(e, "response", {}).get("Error", {}).get("Code") if hasattr(e, "response") else ""
            msg = str(getattr(e, "code", None) or name or e)
            if "NoSuchKey" in msg or "404" in msg or "Not Found" in msg:
                return empty_overlay(), "none"
            if "malformed" in msg.lower():
                if self._last_good is not None:
                    return self._last_good, "malformed"
                return empty_overlay(), "malformed"
            if self._last_good is not None:
                return self._last_good, "unavailable"
            return empty_overlay(), "unavailable"

    def _conditional_save(self, overlay, etag):
        if not self.bucket:
            raise RuntimeError("LEARNING_BUCKET is not configured")
        body = json.dumps(overlay, ensure_ascii=False).encode("utf-8")
        kw = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
        try:
            self._s3().put_object(Bucket=self.bucket, Key=STATE_KEY, Body=body, ContentType="application/json", **kw)
        except Exception as e:
            err = getattr(e, "response", {}) or {}
            code = (err.get("Error") or {}).get("Code") or ""
            status = (err.get("ResponseMetadata") or {}).get("HTTPStatusCode")
            if code in ("PreconditionFailed", "ConditionalRequestConflict") or status in (409, 412):
                raise WriteConflict(code or str(status))
            raise StoreUnavailable(str(e))

    def _default_save(self, overlay):
        if not self.bucket:
            raise RuntimeError("LEARNING_BUCKET is not configured")
        body = json.dumps(overlay, ensure_ascii=False).encode("utf-8")
        self._s3().put_object(
            Bucket=self.bucket, Key=STATE_KEY, Body=body,
            ContentType="application/json",
        )

    def reload(self, force=False):
        now = self._now()
        if not force and self._snap is not None and (now - self._at) < self.ttl_ms:
            return self._snap
        loader = self._loader or self._default_load
        try:
            res = loader()
            overlay, state = res[0], res[1]  # loaders may also return an ETag as a third element
            if not isinstance(overlay, dict):
                raise ValueError("malformed-overlay")
        except Exception:
            if self._last_good is not None:
                overlay, state = self._last_good, "unavailable"
            else:
                overlay, state = empty_overlay(), "unavailable"
        if state in ("none", "active"):
            self._write_last_good(overlay)
        self._overlay = overlay
        self._overlay_state = state
        snap = merge(self.baseline_mappings, self.baseline_enrichment, overlay, self.sources)
        snap["overlay"]["state"] = state
        if state == "none":
            snap["overlay"]["present"] = False
        self._snap = snap
        self._at = now
        return snap

    # ---- conditional writes (optimistic concurrency on the whole overlay document) ----
    def load_for_write(self):
        """Fresh overlay + its ETag, straight from S3 (never the TTL cache)."""
        if self._loader is not None:
            res = self._loader()
            overlay = res[0]
            etag = res[2] if len(res) > 2 else None
            return clone_overlay(overlay), etag
        if not self.bucket:
            return clone_overlay(self._overlay), None
        try:
            res = self._s3().get_object(Bucket=self.bucket, Key=STATE_KEY)
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code") if hasattr(e, "response") else ""
            if code in ("NoSuchKey", "404") or "NoSuchKey" in str(e):
                return empty_overlay(), None
            raise StoreUnavailable(str(e))
        raw = res["Body"].read().decode("utf-8")
        parsed = json.loads(raw) if raw.strip() else empty_overlay()
        if not isinstance(parsed, dict) or ("records" in parsed and not isinstance(parsed.get("records"), dict)):
            raise StoreUnavailable("malformed-overlay")
        parsed.setdefault("records", {})
        return parsed, res.get("ETag")

    def baseline_by_id(self):
        out = {}
        for m in self.baseline_mappings or []:
            if m.get("mappingId"):
                out[m["mappingId"]] = m  # last-wins, like merge()
        return out

    def snapshot_of(self, overlay):
        snap = merge(self.baseline_mappings, self.baseline_enrichment, overlay, self.sources)
        snap["baseline_by_id"] = self.baseline_by_id()
        if getattr(self, "_baseline_enr_index", None) is None:
            from catalogue_effective import index_enrichment
            self._baseline_enr_index = index_enrichment(self.baseline_enrichment)
        snap["baseline_enrichment"] = self._baseline_enr_index
        return snap

    def save(self, overlay, etag=None, conditional=False):
        saver = self._saver or self._default_save
        if conditional:
            if self._saver is not None:
                try:
                    saver(overlay, etag=etag)
                except TypeError:
                    saver(overlay)
            else:
                self._conditional_save(overlay, etag)
        else:
            saver(overlay)
        self._write_last_good(overlay)
        self._overlay = overlay
        self._overlay_state = "active" if overlay.get("records") else "none"
        self._at = 0
        return self.reload(force=True)
