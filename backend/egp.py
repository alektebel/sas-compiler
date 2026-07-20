"""Server-side .egp extraction — EGP files are ZIP archives with the SAS
programs embedded (usually ``<guid>/code.sas``) plus a ``project.xml`` whose
labels name each task."""

from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET


def _decode(data: bytes) -> str:
    if data[:2] == b"\xff\xfe":
        return data.decode("utf-16-le", errors="replace")
    if data[:2] == b"\xfe\xff":
        return data.decode("utf-16-be", errors="replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("windows-1252", errors="replace")


def _labels(project_xml: str) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        root = ET.fromstring(project_xml)
        for el in root.iter("Element"):
            label = el.findtext("Label")
            el_id = el.findtext("ID")
            if label and el_id:
                out[el_id.strip().lower()] = label.strip()
    except ET.ParseError:
        pass
    return out


def _xml_codes(data: bytes) -> list[str]:
    """Return SAS text stored in XML code elements, when present."""
    codes: list[str] = []
    try:
        root = ET.fromstring(_decode(data))
    except ET.ParseError:
        return codes
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower()
        children = list(element)
        if children and tag not in {"code", "sourcecode", "sascode", "program", "programcode"}:
            continue
        text = "".join(element.itertext()).strip()
        if re.search(r"\b(data\s+[\w.]+\s*;|proc\s+\w+)", text, re.I):
            codes.append(text)
    return codes


def extract_egp(name: str, data: bytes) -> list[tuple[str, str]]:
    """Return [(program_name, sas_code)] from an .egp payload."""
    programs: list[tuple[str, str]] = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        labels: dict[str, str] = {}
        for entry in z.namelist():
            if re.search(r"(^|/)project\.xml$", entry, re.I):
                labels = _labels(_decode(z.read(entry)))
                break

        sas_entries = sorted(e for e in z.namelist() if e.lower().endswith(".sas"))
        for entry in sas_entries:
            code = _decode(z.read(entry))
            top_dir = entry.split("/")[0].lower() if "/" in entry else ""
            label = labels.get(top_dir) or entry.rsplit("/", 1)[-1]
            programs.append((f"{name} › {label}", code))

        if not programs:  # older EGPs store code in .txt or extension-less entries
            for entry in z.namelist():
                if entry.endswith("/") or re.search(r"\.(png|jpg|gif|sas7bdat|log|lst)$", entry, re.I):
                    continue
                raw = z.read(entry)
                is_xml = entry.lower().endswith(".xml")
                codes = _xml_codes(raw) if is_xml else [_decode(raw)]
                for index, code in enumerate(codes, 1):
                    if re.search(r"\b(data\s+[\w.]+\s*;|proc\s+\w+)", code, re.I):
                        suffix = f" #{index}" if len(codes) > 1 else ""
                        programs.append((f"{name} › {entry.rsplit('/', 1)[-1]}{suffix}", code))
    return programs
