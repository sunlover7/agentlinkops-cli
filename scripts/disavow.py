"""Offline, user-managed disavow lists. No network access or rule recommendations."""
import datetime as dt
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import urllib.parse

# Google's help page states "2MB" without defining the byte convention.
# Use decimal MB so every accepted export is below either common interpretation.
MAX_BYTES = 2000000
MAX_LINES = 100000
MAX_URL = 2048


class DisavowError(Exception):
    def __init__(self, message, code="INVALID_DISAVOW"):
        super().__init__(message)
        self.code = code


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def stable_id(prefix, parts):
    return prefix + hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def domain(value):
    if not isinstance(value, str):
        raise DisavowError("Domain rule must contain a hostname")
    value = value.strip().lower().removesuffix(".")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        raise DisavowError("A domain rule requires a DNS hostname, not an IP address")
    if len(value) > 253 or "." not in value or not value.isascii() or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in value.split(".")):
        raise DisavowError("Domain rules require an ASCII or Punycode hostname without scheme, port, path or wildcard")
    return value


def url(value, property_url=False):
    if not isinstance(value, str) or not value or len(value) > MAX_URL or any(ord(char) <= 32 or ord(char) == 127 for char in value) or "\\" in value:
        raise DisavowError("URLs must be at most 2,048 characters without whitespace or control characters")
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError()
        port = parsed.port
        try:
            address = ipaddress.ip_address(parsed.hostname)
            hostname = "[" + address.compressed + "]" if address.version == 6 else address.compressed
        except ValueError:
            hostname = domain(parsed.hostname)
        if port is not None:
            hostname += ":" + str(port)
    except (ValueError, DisavowError) as exc:
        raise DisavowError("Use an HTTP(S) URL with an ASCII/Punycode hostname and no credentials") from exc
    if "*" in parsed.path or "*" in parsed.query:
        raise DisavowError("Wildcard and subpath patterns are unsupported; specify an exact page URL or a domain rule")
    if property_url and (parsed.query or parsed.fragment):
        raise DisavowError("Property scope must be a URL prefix without query or fragment")
    normalized = urllib.parse.urlunsplit((parsed.scheme, hostname, parsed.path or "/", parsed.query, parsed.fragment))
    if len(normalized) > MAX_URL:
        raise DisavowError("Normalized URL exceeds 2,048 characters")
    return normalized


def rule(kind, value):
    if kind == "domain":
        return domain(value)
    if kind == "url":
        return url(value)
    raise DisavowError("Rule kind must be domain or url")


def source_label(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 1024 or any(ord(char) < 32 for char in value):
        raise DisavowError("Source provenance must be a nonempty label without control characters")
    return value.strip()


def parse_file(path):
    if Path(path).suffix.lower() != ".txt":
        raise DisavowError("Disavow import requires a .txt file")
    with Path(path).open("rb") as file:
        raw = file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise DisavowError("Disavow file exceeds the 2 MB limit")
    try:
        original = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DisavowError("Disavow file must be UTF-8 or 7-bit ASCII") from exc
    # Accept a UTF-8 BOM but retain the original bytes' hash and original decoded text.
    content = original.removeprefix("\ufeff")
    if "\x00" in content:
        raise DisavowError("Disavow file contains NUL characters")
    # Counting physical LF lines (including blank/comment lines) avoids treating
    # Unicode separators inside a URL or comment as extra file lines.
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if len(lines) > MAX_LINES:
        raise DisavowError("Disavow file exceeds 100,000 lines including comments and blanks")
    entries, comments = [], []
    for number, original_line in enumerate(lines, 1):
        line = original_line.rstrip("\r").strip()
        if not line:
            continue
        if line.startswith("#"):
            comments.append({"line": number, "text": line[1:].lstrip()})
            continue
        kind, value = ("domain", line[7:]) if line.startswith("domain:") else ("url", line)
        try:
            normalized = rule(kind, value)
        except DisavowError as exc:
            raise DisavowError(f"Line {number}: {exc}") from exc
        entries.append({"kind": kind, "value": normalized, "line": number, "original": original_line.rstrip("\r"), "comments": comments})
        comments = []
    return original, hashlib.sha256(raw).hexdigest(), entries, len(lines)


def import_rules(connection, path, property_url, source):
    property_url, source = url(property_url, True), source_label(source)
    original, digest, entries, line_count = parse_file(path)
    source_id = stable_id("dsrc_", [property_url, source, digest, "txt"])
    added, existing, recorded = 0, 0, stamp()
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute("INSERT OR IGNORE INTO disavow_sources VALUES (?,?,?,?,?,?,?)", (source_id, property_url, source, digest, "txt", original, recorded))
        for entry in entries:
            rule_id = stable_id("drule_", [property_url, entry["kind"], entry["value"]])
            inserted = connection.execute("INSERT OR IGNORE INTO disavow_rules(id,property_url,kind,value,created_at,updated_at) VALUES (?,?,?,?,?,?)", (rule_id, property_url, entry["kind"], entry["value"], recorded, recorded)).rowcount
            added += inserted
            existing += 1 - inserted
            # An import never overwrites local notes or reactivates a rule the user disabled.
            connection.execute("INSERT OR IGNORE INTO disavow_provenance VALUES (?,?,?,?,?,?)", (rule_id, source_id, entry["line"], entry["original"], json.dumps(entry["comments"], ensure_ascii=False), recorded))
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return {"property_url": property_url, "source_id": source_id, "rules_added": added, "existing_rule_lines": existing, "lines": line_count, "mode": "merge", "uploaded": False}


def upsert_rule(connection, record, property_url, source):
    property_url, source = url(property_url, True), source_label(source)
    if not isinstance(record, dict) or record.keys() - {"kind", "value", "active", "notes"}:
        raise DisavowError("Rule JSON accepts kind, value, active and notes")
    kind = record.get("kind")
    value = rule(kind, record.get("value"))
    if "active" in record and type(record["active"]) is not bool:
        raise DisavowError("active must be a JSON boolean")
    if "notes" in record and not isinstance(record["notes"], str):
        raise DisavowError("notes must be a string")
    rule_id = stable_id("drule_", [property_url, kind, value])
    raw = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode()).hexdigest()
    source_id = stable_id("dsrc_", [property_url, source, digest, "manual"])
    recorded = stamp()
    connection.execute("BEGIN IMMEDIATE")
    try:
        existing = connection.execute("SELECT active,notes FROM disavow_rules WHERE id=?", (rule_id,)).fetchone()
        active = int(record.get("active", bool(existing[0]) if existing else True))
        notes = record.get("notes", existing[1] if existing else "")
        connection.execute("INSERT INTO disavow_rules VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,notes=excluded.notes,updated_at=excluded.updated_at", (rule_id, property_url, kind, value, active, notes, recorded, recorded))
        connection.execute("INSERT OR IGNORE INTO disavow_sources VALUES (?,?,?,?,?,?,?)", (source_id, property_url, source, digest, "manual", raw, recorded))
        connection.execute("INSERT OR IGNORE INTO disavow_provenance VALUES (?,?,?,?,?,?)", (rule_id, source_id, 0, raw, "[]", recorded))
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return {"id": rule_id, "property_url": property_url, "kind": kind, "value": value, "active": bool(active), "notes": notes, "source_id": source_id}


def list_rules(connection, property_url, active_only=False):
    property_url = url(property_url, True)
    result = []
    for row in connection.execute("SELECT * FROM disavow_rules WHERE property_url=?" + (" AND active=1" if active_only else "") + " ORDER BY kind,value", (property_url,)):
        item = dict(row)
        item["active"] = bool(item["active"])
        item["provenance"] = []
        for source in connection.execute("SELECT s.id AS source_id,s.source_label,s.source_sha256,s.format,p.line_number,p.line_text,p.comments_json,p.recorded_at FROM disavow_provenance p JOIN disavow_sources s ON s.id=p.source_id WHERE p.rule_id=? ORDER BY p.recorded_at,s.id,p.line_number", (item["id"],)):
            entry = dict(source)
            entry["comments"] = json.loads(entry.pop("comments_json"))
            item["provenance"].append(entry)
        result.append(item)
    return result


def export_rules(connection, property_url):
    property_url = url(property_url, True)
    # No timestamps or private notes: the same active rule set produces identical bytes.
    lines = ["# AgentLinkOps user-managed disavow rules", "# Property: " + property_url]
    for kind, value in connection.execute("SELECT kind,value FROM disavow_rules WHERE property_url=? AND active=1 ORDER BY kind,value", (property_url,)):
        lines.append("domain:" + value if kind == "domain" else value)
    text = "\n".join(lines) + "\n"
    if len(lines) > MAX_LINES or len(text.encode("utf-8")) > MAX_BYTES:
        raise DisavowError("Export exceeds Google's .txt line or byte limits; review the list before exporting")
    return text, {"property_url": property_url, "active_rules": len(lines) - 2, "format": "txt", "uploaded": False}


def snapshot(connection):
    return {"rules": [dict(row) for row in connection.execute("SELECT * FROM disavow_rules ORDER BY property_url,kind,value")], "sources": [dict(row) for row in connection.execute("SELECT * FROM disavow_sources ORDER BY id")], "provenance": [dict(row) for row in connection.execute("SELECT * FROM disavow_provenance ORDER BY rule_id,source_id,line_number")]}
