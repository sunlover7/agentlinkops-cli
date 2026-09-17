#!/usr/bin/env python3
"""AgentLinkOps portable CRM. Python 3.10+, standard library only, no telemetry."""
import sys

# The floor is checked BEFORE anything else is imported, because the failure it prevents is the
# one a user cannot act on: without this, an older interpreter fails somewhere deep inside a
# command with an AttributeError about a string method, and nothing in that message says
# "upgrade Python". The version we support is the version we test on.
MINIMUM_PYTHON = (3, 10)
if sys.version_info < MINIMUM_PYTHON:  # pragma: no cover - exercised by test_python_floor
    sys.stderr.write(
        "agentlinkops: needs Python {}.{} or newer; this is Python {}.{}.{}.\n"
        "Install a newer Python and run it explicitly, for example:\n"
        "  python3.12 {} --help\n".format(
            MINIMUM_PYTHON[0], MINIMUM_PYTHON[1],
            sys.version_info[0], sys.version_info[1], sys.version_info[2], sys.argv[0]))
    raise SystemExit(2)

"""Portable AgentLinkOps CRM. Python 3.10+, standard library only, no telemetry."""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
import disavow
import report

VERSION = "0.2.0"
APPLICATION_ID = 0x4C54524C
ROOT = Path(__file__).resolve().parent
ENTITIES = {
    "product": ("products", {"name", "url", "audience", "description", "target_pages", "notes"}, {"name", "url"}),
    "campaign": ("campaigns", {"product_id", "name", "type", "template_version", "status", "goal", "target_url", "notes"}, {"name", "type"}),
    "contact": ("contacts", {"publisher_url", "name", "email", "contact_url", "source_url", "observed_at", "confidence", "notes"}, {"publisher_url"}),
    "opportunity": ("opportunities", {"campaign_id", "contact_id", "source_url", "target_url", "type", "status", "evidence", "notes"}, {"source_url", "target_url"}),
    "activity": ("activities", {"opportunity_id", "contact_id", "campaign_id", "channel", "kind", "external_message_id", "occurred_at", "outcome", "notes"}, {"kind", "occurred_at"}),
    "placement": ("placements", {"opportunity_id", "project_id", "watch_id", "source_url", "target_url", "status", "notes", "cost_amount", "cost_currency"}, {"source_url", "target_url"}),
}
JSON_COLUMNS = {"target_pages", "evidence", "cloud_state", "payload"}
FORBIDDEN_KEYS = {"password", "api_key", "access_token", "refresh_token", "secret", "credentials", "message_body", "email_body", "mailbox_password", "body", "html_body"}
WATCH_EVENTS = {"watch.checked", "watch.state_changed", "watch.recovered", "watch.expectations_changed", "watch.created", "watch.updated", "watch.deleted", "placement_acquired", "placement_lost", "placement_recovered", "placement_changed", "source_unavailable", "placement.deleted", "placement.state_changed"}
MAX_JSON = 4 * 1024 * 1024


class CRMError(Exception):
    def __init__(self, message, code="INVALID_INPUT"):
        super().__init__(message)
        self.code = code


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def text_id(value, name="id"):
    if not isinstance(value, str) or not value.strip() or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise CRMError(f"{name} must be a nonempty string without control characters")
    return value


def date_string(value, name):
    text_id(value, name)
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CRMError(f"{name} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise CRMError(f"{name} must include a timezone")
    return value


def public_url(value, name, empty=False):
    if empty and value == "":
        return value
    if not isinstance(value, str):
        raise CRMError(f"{name} must be an HTTP(S) URL")
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError()
        parsed.port
    except ValueError as exc:
        raise CRMError(f"{name} must be an HTTP(S) URL without credentials") from exc
    return value


def no_sensitive_fields(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower().replace("-", "_") in FORBIDDEN_KEYS:
                raise CRMError(f"Field {key} is not stored; use external message IDs and outcome notes")
            no_sensitive_fields(child)
    elif isinstance(value, list):
        for child in value:
            no_sensitive_fields(child)


def migrations():
    result = []
    for path in sorted((ROOT / "migrations").glob("[0-9][0-9][0-9]_*.sql")):
        sql = path.read_text()
        result.append((int(path.name[:3]), path.name, sql, hashlib.sha256(sql.encode()).hexdigest()))
    if [row[0] for row in result] != list(range(1, len(result) + 1)):
        raise CRMError("Migration files must be contiguous from 001", "SCHEMA_ERROR")
    return result


def connect(path, allow_create=False):
    path = Path(path).expanduser()
    if path.is_symlink():
        raise CRMError("Refusing a symlink database path", "DATABASE_ERROR")
    if not allow_create and not path.is_file():
        raise CRMError("CRM does not exist; run init with a workspace ID", "DATABASE_ERROR")
    if allow_create and not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
    connection = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def inspect_schema(connection, allow_empty=False):
    tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    app = connection.execute("PRAGMA application_id").fetchone()[0]
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if not tables and app == 0 and version == 0 and allow_empty:
        return 0
    if app != APPLICATION_ID or "schema_migrations" not in tables or "crm_meta" not in tables:
        raise CRMError("File is not an AgentLinkOps CRM; it was not modified", "SCHEMA_ERROR")
    known = migrations()
    if version > len(known):
        raise CRMError("CRM was created by a newer toolkit; refusing to downgrade", "SCHEMA_TOO_NEW")
    recorded = list(connection.execute("SELECT version, name, checksum FROM schema_migrations ORDER BY version"))
    if len(recorded) != version:
        raise CRMError("Migration ledger and schema version disagree", "SCHEMA_ERROR")
    for row, expected in zip(recorded, known):
        if tuple(row) != (expected[0], expected[1], expected[3]):
            raise CRMError("Applied migration checksum changed; restore original migration files", "SCHEMA_ERROR")
    return version


def workspace(connection):
    row = connection.execute("SELECT value FROM crm_meta WHERE key='workspace_id'").fetchone()
    if row is None:
        raise CRMError("CRM workspace binding is missing", "SCHEMA_ERROR")
    return row[0]


def migrate(connection, path, workspace_id=None, initialize=False):
    version = inspect_schema(connection, allow_empty=initialize)
    if version:
        actual_workspace = workspace(connection)
        if workspace_id is not None and actual_workspace != workspace_id:
            raise CRMError("CRM already belongs to another workspace", "WORKSPACE_MISMATCH")
    elif workspace_id is None:
        raise CRMError("A workspace ID is required for initialization")
    pending = [m for m in migrations() if m[0] > version]
    backup = None
    if version and pending:
        backup = str(Path(path).expanduser()) + ".pre-v" + str(version + 1) + "." + dt.datetime.now().strftime("%Y%m%d%H%M%S%f") + ".bak"
        descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with sqlite3.connect(backup) as target:
            connection.backup(target)
    connection.execute("BEGIN IMMEDIATE")
    try:
        # Lock first and recheck: concurrent init/migrate must not replay DDL.
        version = inspect_schema(connection, allow_empty=initialize)
        if version and workspace_id is not None and workspace(connection) != workspace_id:
            raise CRMError("CRM already belongs to another workspace", "WORKSPACE_MISMATCH")
        connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)")
        for number, name, sql, checksum in migrations():
            if number <= version:
                continue
            # Migrations contain simple DDL only. executescript would commit the outer transaction.
            statement = ""
            for line in sql.splitlines(keepends=True):
                statement += line
                if sqlite3.complete_statement(statement):
                    connection.execute(statement)
                    statement = ""
            if statement.strip():
                raise CRMError(f"Incomplete migration: {name}", "SCHEMA_ERROR")
            connection.execute("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)", (number, name, checksum, now()))
            connection.execute(f"PRAGMA user_version = {number}")
        connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
        if version == 0:
            connection.execute("INSERT INTO crm_meta VALUES ('workspace_id', ?)", (text_id(workspace_id, "workspace_id"),))
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return {"schema_version": len(migrations()), "workspace_id": workspace(connection), "backup": backup}


def require_current(connection):
    if inspect_schema(connection) != len(migrations()):
        raise CRMError("CRM needs migration; run migrate (a backup is created first)", "MIGRATION_REQUIRED")


def decode_row(row):
    result = dict(row)
    for key in JSON_COLUMNS & result.keys():
        result[key] = json.loads(result[key])
    return result


def upsert(connection, entity, record):
    if not isinstance(record, dict):
        raise CRMError("Record must be a JSON object")
    no_sensitive_fields(record)
    table, allowed, required = ENTITIES[entity]
    unknown = record.keys() - allowed - {"id"}
    if unknown:
        raise CRMError("Unsupported fields: " + ", ".join(sorted(unknown)))
    record = dict(record)
    text_id(record.get("id"))
    existing = connection.execute(f"SELECT * FROM {table} WHERE id=?", (record["id"],)).fetchone()
    if existing is None and required - record.keys():
        raise CRMError("Missing fields: " + ", ".join(sorted(required - record.keys())))
    for key in required & record.keys():
        if not isinstance(record[key], str) or not record[key].strip():
            raise CRMError(f"{key} must be a nonempty string")
    if entity == "placement" and ({"cost_amount", "cost_currency"} & record.keys()):
        try:
            record["cost_amount"], record["cost_currency"] = report.cost(record.get("cost_amount", existing["cost_amount"] if existing else None), record.get("cost_currency", existing["cost_currency"] if existing else None))
        except ValueError as exc:
            raise CRMError(str(exc)) from exc
    for key, value in record.items():
        if key in JSON_COLUMNS:
            expected = list if key == "target_pages" else dict
            if not isinstance(value, expected):
                raise CRMError(f"{key} must be a JSON {expected.__name__}")
            if key == "target_pages":
                for item in value:
                    public_url(item, "target_pages item")
            record[key] = encode(value)
        elif key == "template_version":
            if type(value) is not int or value < 1:
                raise CRMError("template_version must be a positive integer")
        elif value is None and (key.endswith("_id") or key in {"cost_amount", "cost_currency"}):
            continue
        elif not isinstance(value, str):
            raise CRMError(f"{key} must be a string")
        elif key == "url" or key.endswith("_url"):
            public_url(value, key, empty=key not in required)
        elif key.endswith("_at") and value:
            date_string(value, key)
        elif key.endswith("_id") and value:
            text_id(value, key)
    if entity == "campaign":
        chosen = record.get("type", existing["type"] if existing else None)
        if chosen not in templates()["campaigns"]:
            raise CRMError("Unknown campaign type; use a supported template or custom")
    stamp = now()
    record["updated_at"] = stamp
    if existing is None:
        record["created_at"] = stamp
        keys = list(record)
        connection.execute(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})", [record[k] for k in keys])
    else:
        keys = [key for key in record if key != "id"]
        connection.execute(f"UPDATE {table} SET {','.join(key + '=?' for key in keys)} WHERE id=?", [record[k] for k in keys] + [record["id"]])
    return decode_row(connection.execute(f"SELECT * FROM {table} WHERE id=?", (record["id"],)).fetchone())


def list_records(connection, entity, record_id=None):
    table = ENTITIES[entity][0]
    rows = connection.execute(f"SELECT * FROM {table}" + (" WHERE id=?" if record_id else "") + " ORDER BY id", (record_id,) if record_id else ())
    return [decode_row(row) for row in rows]


def templates():
    return json.loads((ROOT.parent / "templates" / "campaigns.v1.json").read_text())


def validate_page(page, expected_workspace, requested_cursor):
    if not isinstance(page, dict) or page.get("workspace_id") != expected_workspace:
        raise CRMError("Cloud response workspace does not match this CRM", "WORKSPACE_MISMATCH")
    events = page.get("events")
    if not isinstance(events, list) or len(events) > 1000 or type(page.get("has_more")) is not bool:
        raise CRMError("Malformed event page", "INVALID_EVENT_PAGE")
    next_cursor = page.get("next_cursor")
    text_id(next_cursor, "next_cursor")
    # A project-restricted feed can advance across hidden events, including empty pages.
    if page["has_more"] and (next_cursor is None or next_cursor == requested_cursor):
        raise CRMError("Event pagination made no progress", "INVALID_EVENT_PAGE")
    seen_ids, seen_cursors = set(), set()
    for event in events:
        if not isinstance(event, dict) or event.get("workspace_id") != expected_workspace:
            raise CRMError("Event workspace does not match this CRM", "WORKSPACE_MISMATCH")
        for name in ("id", "cursor", "type"):
            text_id(event.get(name), name)
        date_string(event.get("created_at"), "created_at")
        for name in ("project_id", "watch_id"):
            if event.get(name) is not None:
                text_id(event[name], name)
        if not isinstance(event.get("data"), dict):
            raise CRMError("Event data must be an object", "INVALID_EVENT_PAGE")
        if event["id"] in seen_ids or event["cursor"] in seen_cursors:
            raise CRMError("Event page contains duplicate identifiers", "INVALID_EVENT_PAGE")
        seen_ids.add(event["id"])
        seen_cursors.add(event["cursor"])
        no_sensitive_fields(event["data"])
    return events


def apply_event(connection, event):
    # Unknown event types remain in the local feed for forward compatibility.
    if not event.get("watch_id") or event["type"] not in WATCH_EVENTS:
        return
    after = event["data"].get("after")
    is_deletion = event["type"] in {"watch.deleted", "placement.deleted"}
    if not isinstance(after, dict) and not (is_deletion and "after" in event["data"] and after is None):
        raise CRMError("Watch after state must be an object; only deletion events allow null", "INVALID_EVENT_PAGE")
    current = connection.execute("SELECT * FROM placements WHERE watch_id=?", (event["watch_id"],)).fetchone()
    snapshot = dict(after or {})
    for key in ("watch_id", "project_id"):
        if key in snapshot and snapshot[key] != event.get(key):
            raise CRMError("Watch snapshot has mismatched identifiers", "INVALID_EVENT_PAGE")
    if current and current["project_id"] is not None and event.get("project_id") != current["project_id"]:
        raise CRMError("Watch changed its project binding", "PROJECT_MISMATCH")
    for key in ("source_url", "target_url"):
        if key in snapshot:
            public_url(snapshot[key], key)
    if after is None:
        snapshot = {"deleted": True}
    stamp = now()
    if current is None:
        if "source_url" not in snapshot or "target_url" not in snapshot:
            # Preserve the event without inventing a placement from a partial state.
            return
        connection.execute("INSERT INTO placements (id,project_id,watch_id,source_url,target_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", (
            "cloud:" + event["watch_id"], event.get("project_id"), event["watch_id"], snapshot["source_url"], snapshot["target_url"], stamp, stamp))
    else:
        # URL bindings are cloud owned; outreach status, notes and local relations are not.
        for key in ("source_url", "target_url"):
            if key in snapshot:
                connection.execute(f"UPDATE placements SET {key}=? WHERE watch_id=?", (snapshot[key], event["watch_id"]))
    connection.execute("UPDATE placements SET cloud_state=?, cloud_observed_at=?, cloud_event_id=?, updated_at=? WHERE watch_id=?", (
        encode(snapshot), event["created_at"], event["id"], stamp, event["watch_id"]))


def apply_page(connection, page, requested_cursor, endpoint):
    events = validate_page(page, workspace(connection), requested_cursor)
    connection.execute("BEGIN IMMEDIATE")
    try:
        state = connection.execute("SELECT * FROM sync_state WHERE singleton=1").fetchone()
        if state["cursor"] != requested_cursor:
            raise CRMError("Another sync updated the cursor; retry from current state", "SYNC_CONFLICT")
        if state["endpoint"] not in (None, endpoint):
            raise CRMError("CRM is bound to another service endpoint; use a separate CRM", "ENDPOINT_MISMATCH")
        previous_position = connection.execute("SELECT rowid FROM cloud_events WHERE cursor=?", (requested_cursor,)).fetchone()
        next_position = connection.execute("SELECT rowid FROM cloud_events WHERE cursor=?", (page["next_cursor"],)).fetchone()
        if previous_position and next_position and next_position[0] < previous_position[0]:
            raise CRMError("Cloud feed attempted to rewind a known cursor", "INVALID_EVENT_PAGE")
        applied = 0
        for event in events:
            payload = encode(event)
            fingerprint = hashlib.sha256(payload.encode()).hexdigest()
            previous = connection.execute("SELECT payload_hash FROM cloud_events WHERE id=?", (event["id"],)).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    raise CRMError("An existing cloud event changed its payload", "EVENT_CONFLICT")
                continue
            connection.execute("INSERT INTO cloud_events VALUES (?,?,?,?,?,?,?,?,?)", (
                event["id"], event["cursor"], event["type"], event.get("project_id"), event.get("watch_id"), event["created_at"], payload, fingerprint, now()))
            apply_event(connection, event)
            applied += 1
        connection.execute("UPDATE sync_state SET endpoint=?, cursor=?, updated_at=? WHERE singleton=1", (endpoint, page["next_cursor"], now()))
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return applied


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Environment names, with the pilot compatibility window (DP-0029): AGENTLINKOPS_* is preferred,
# LINKTRAIL_* is accepted with one warning per process, and two different values under the two
# names is a refusal rather than a guess. Values are never printed.
_WARNED_ENV = set()


def read_env(suffix, environ=None):
    environ = os.environ if environ is None else environ
    preferred, legacy = "AGENTLINKOPS_" + suffix, "LINKTRAIL_" + suffix
    fresh, old = environ.get(preferred, ""), environ.get(legacy, "")
    if fresh and old and fresh != old:
        raise CRMError(f"{preferred} and {legacy} disagree; select one value", "ENV_CONFLICT")
    if fresh:
        return fresh, preferred
    if old:
        if legacy not in _WARNED_ENV:
            _WARNED_ENV.add(legacy)
            sys.stderr.write(f"{legacy} is deprecated; set {preferred} instead. The old name keeps working during the pilot compatibility window.\n")
        return old, legacy
    return "", preferred


def api_endpoint(value, name="AGENTLINKOPS_API_URL"):
    public_url(value, name)
    parsed = urllib.parse.urlsplit(value)
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise CRMError(f"{name} must be a service origin without path/query/fragment")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise CRMError("Cloud sync requires HTTPS; HTTP is allowed only on loopback")
    return value.rstrip("/")


def fetch_page(endpoint, key, cursor, limit):
    params = {"limit": str(limit)}
    if cursor is not None:
        params["cursor"] = cursor
    request = urllib.request.Request(endpoint + "/v1/events?" + urllib.parse.urlencode(params), headers={"Authorization": "Bearer " + key, "Accept": "application/json", "User-Agent": "AgentLinkOps-CRM/" + VERSION})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(MAX_JSON + 1)
            if len(raw) > MAX_JSON:
                raise CRMError("Event response exceeded 4 MiB", "INVALID_EVENT_PAGE")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code == 410:
            raise CRMError("Cloud cursor expired. Cursor and local notes were preserved. Export this CRM and recover a current watch snapshot into a separate CRM before replaying retained events.", "CURSOR_EXPIRED") from exc
        if exc.code in (401, 403):
            raise CRMError("Cloud access was rejected; check the configured account and permissions", "AUTH_REQUIRED") from exc
        raise CRMError(f"Cloud returned HTTP {exc.code}; this page was not applied", "HTTP_ERROR") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CRMError("Cloud could not be reached; this page was not applied", "NETWORK_ERROR") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CRMError("Cloud response is not valid JSON", "INVALID_EVENT_PAGE") from exc


def sync(connection, limit=100, max_pages=100):
    url_value, url_name = read_env("API_URL")
    endpoint = api_endpoint(url_value, url_name)
    key, key_name = read_env("API_KEY")
    if not key or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise CRMError(f"Set {key_name} in the process environment; do not paste it into chat", "AUTH_REQUIRED")
    state = connection.execute("SELECT * FROM sync_state WHERE singleton=1").fetchone()
    if state["endpoint"] not in (None, endpoint):
        raise CRMError("CRM is bound to another service endpoint; use a separate CRM", "ENDPOINT_MISMATCH")
    applied, pages = 0, 0
    cursor = state["cursor"]
    has_more = True
    while has_more and pages < max_pages:
        page = fetch_page(endpoint, key, cursor, limit)
        applied += apply_page(connection, page, cursor, endpoint)
        cursor, has_more = page["next_cursor"], page["has_more"]
        pages += 1
    return {"applied": applied, "pages": pages, "next_cursor": cursor, "has_more": has_more}


def read_json(path):
    if path == "-":
        raw = sys.stdin.read(MAX_JSON + 1)
    else:
        with Path(path).open() as source:
            raw = source.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise CRMError("Input exceeded 4 MiB")
    return json.loads(raw)


def export_csv(records, fieldnames):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for record in records:
        escaped = {}
        for key, value in record.items():
            value = encode(value) if isinstance(value, (dict, list)) else value
            # CSVs are often opened in spreadsheets; do not execute formulas from publisher text.
            if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
                value = "'" + value
            escaped[key] = value
        writer.writerow(escaped)
    return output.getvalue()


def write_new(path, content, suffix=None):
    path = Path(path).expanduser()
    if suffix and path.suffix.lower() != suffix:
        raise CRMError(f"Output file must end in {suffix}")
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
        output.write(content)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--db", default=read_env("CRM_PATH")[0] or None, help="Local SQLite path (or AGENTLINKOPS_CRM_PATH); never stored inside the installed plugin")
    commands = parser.add_subparsers(dest="command", required=True)
    initialize = commands.add_parser("init")
    initialize.add_argument("--workspace", required=True)
    commands.add_parser("migrate")
    commands.add_parser("status")
    commands.add_parser("templates")
    for entity in ENTITIES:
        entity_parser = commands.add_parser(entity)
        entity_actions = entity_parser.add_subparsers(dest="action", required=True)
        put = entity_actions.add_parser("upsert")
        put.add_argument("--file", default="-", help="JSON file or - for stdin; accepts a record or atomic list of records")
        listing = entity_actions.add_parser("list")
        listing.add_argument("--id")
    exporter = commands.add_parser("export")
    exporter.add_argument("--format", choices=("json", "csv"), default="json")
    exporter.add_argument("--entity", choices=ENTITIES)
    exporter.add_argument("--output", help="Create a new file; existing files are never overwritten")
    reporter = commands.add_parser("report", help="Generate a self-contained HTML placement report from selected local data")
    reporter.add_argument("--output", required=True, help="New .html file; existing files are never overwritten")
    reporter.add_argument("--title", default="Link placement report")
    reporter.add_argument("--brand", default="AgentLinkOps")
    reporter.add_argument("--project", dest="project_id", help="Include one project's placements; defaults to all local placements")
    reporter.add_argument("--generated-at", help="ISO 8601 report timestamp; set explicitly for deterministic output")
    reporter.add_argument("--include-notes", action="store_true", help="Explicitly include private local placement notes")
    reporter.add_argument("--include-costs", action="store_true", help="Explicitly include local cost amounts and totals by currency")
    disavowing = commands.add_parser("disavow", help="User-managed, property-scoped disavow rules; no Google uploads")
    disavow_actions = disavowing.add_subparsers(dest="action", required=True)
    for action in ("import", "upsert", "list", "export"):
        command = disavow_actions.add_parser(action)
        command.add_argument("--property", required=True, dest="property_url", help="Exact Search Console URL-prefix property, not a Domain property")
        if action in {"import", "upsert"}:
            command.add_argument("--source", required=True, help="Provenance label chosen by the user")
            command.add_argument("--file", required=action == "import", default="-", help="UTF-8 .txt import or upsert JSON file; upsert accepts stdin")
        if action == "list":
            command.add_argument("--active-only", action="store_true")
        if action == "export":
            command.add_argument("--output", help="New .txt file; defaults to stdout")
    syncing = commands.add_parser("sync")
    syncing.add_argument("--limit", type=int, default=100)
    syncing.add_argument("--max-pages", type=int, default=100)
    args = parser.parse_args(argv)
    connection = None
    try:
        if args.command == "templates":
            print(encode(templates()))
            return 0
        if not args.db:
            raise CRMError("Supply --db or AGENTLINKOPS_CRM_PATH")
        if args.command == "init":
            text_id(args.workspace, "workspace_id")
        connection = connect(args.db, allow_create=args.command == "init")
        if args.command in {"init", "migrate"}:
            result = migrate(connection, args.db, getattr(args, "workspace", None), initialize=args.command == "init")
        else:
            require_current(connection)
            if args.command in ENTITIES:
                if args.action == "upsert":
                    records = read_json(args.file)
                    multiple = isinstance(records, list)
                    connection.execute("BEGIN IMMEDIATE")
                    try:
                        result = [upsert(connection, args.command, record) for record in (records if multiple else [records])]
                        connection.execute("COMMIT")
                    except Exception:
                        connection.execute("ROLLBACK")
                        raise
                    if not multiple:
                        result = result[0]
                else:
                    result = list_records(connection, args.command, args.id)
            elif args.command == "sync":
                if not 1 <= args.limit <= 1000 or not 1 <= args.max_pages <= 1000:
                    raise CRMError("limit and max-pages must be between 1 and 1000")
                result = sync(connection, args.limit, args.max_pages)
            elif args.command == "disavow":
                if args.action == "import":
                    result = disavow.import_rules(connection, args.file, args.property_url, args.source)
                elif args.action == "upsert":
                    record = read_json(args.file)
                    no_sensitive_fields(record)
                    result = disavow.upsert_rule(connection, record, args.property_url, args.source)
                elif args.action == "list":
                    result = disavow.list_rules(connection, args.property_url, args.active_only)
                else:
                    content, result = disavow.export_rules(connection, args.property_url)
                    if args.output:
                        write_new(args.output, content, ".txt")
                        result["exported"] = args.output
                    else:
                        sys.stdout.write(content)
                        return 0
            elif args.command == "report":
                generated_at = date_string(args.generated_at or now(), "generated_at")
                if args.project_id:
                    text_id(args.project_id, "project_id")
                try:
                    content, result = report.render(connection, args.title, args.brand, generated_at, args.project_id, args.include_notes, args.include_costs)
                except ValueError as exc:
                    raise CRMError(str(exc)) from exc
                write_new(args.output, content, ".html")
                result["exported"] = args.output
            elif args.command == "status":
                result = {"version": VERSION, "schema_version": len(migrations()), "workspace_id": workspace(connection), "sync": dict(connection.execute("SELECT endpoint,cursor,updated_at FROM sync_state").fetchone()), "counts": {entity: connection.execute(f"SELECT count(*) FROM {values[0]}").fetchone()[0] for entity, values in ENTITIES.items()}}
            elif args.command == "export":
                if args.format == "csv" and not args.entity:
                    raise CRMError("CSV export requires --entity")
                connection.execute("BEGIN")
                try:
                    if args.entity:
                        data = list_records(connection, args.entity)
                    else:
                        data = {"schema_version": len(migrations()), "workspace_id": workspace(connection), "records": {entity: list_records(connection, entity) for entity in ENTITIES}, "cloud_events": [decode_row(row) for row in connection.execute("SELECT * FROM cloud_events ORDER BY rowid")], "sync": dict(connection.execute("SELECT * FROM sync_state").fetchone()), "disavow": disavow.snapshot(connection)}
                    fields = [row[1] for row in connection.execute(f"PRAGMA table_info({ENTITIES[args.entity][0]})")] if args.entity else []
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise
                result_text = export_csv(data, fields) if args.format == "csv" else encode(data) + "\n"
                if args.output:
                    write_new(args.output, result_text)
                    result = {"exported": args.output, "format": args.format}
                else:
                    sys.stdout.write(result_text)
                    return 0
        print(encode(result))
        return 0
    except (CRMError, disavow.DisavowError) as exc:
        print(encode({"error": {"code": exc.code, "message": str(exc)}}), file=sys.stderr)
        return 1
    except (sqlite3.Error, ValueError, OSError) as exc:
        # Do not print potentially sensitive input, SQL parameters or remote response bodies.
        print(encode({"error": {"code": "LOCAL_OPERATION_FAILED", "message": "Operation failed (" + type(exc).__name__ + "); the current transaction was not committed"}}), file=sys.stderr)
        return 1
    finally:
        if connection:
            connection.close()


if __name__ == "__main__":
    sys.exit(main())
