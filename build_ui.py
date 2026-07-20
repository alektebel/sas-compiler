#!/usr/bin/env python3
"""Inject schema.json into index.template.html → index.html (self-contained UI)."""

from pathlib import Path

schema = Path("schema.json").read_text(encoding="utf-8")
# Guard against accidentally closing the embedding <script> block.
schema = schema.replace("</script", "<\\/script")
template = Path("index.template.html").read_text(encoding="utf-8")
Path("index.html").write_text(template.replace("__SCHEMA_JSON__", schema), encoding="utf-8")
print(f"index.html generado ({len(template) + len(schema):,} bytes)")
