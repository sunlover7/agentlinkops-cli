#!/usr/bin/env python3
"""Local draft-only handoff from a frozen report and explicit external-ID mapping.
No network, mailbox, sender or mutation of the input ledger/report. No send action.
"""
import argparse
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import tempfile
import stat
import time
from urllib.parse import urlsplit


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def prepare(report, mapping):
    if not isinstance(report, dict) or not isinstance(mapping, dict) or type(report.get('v')) is not int or report['v'] != 2:
        raise ValueError('supported frozen report v2 and mapping objects required')
    if set(mapping) != {'version', 'workspace_id', 'project_id', 'site', 'destination', 'records', 'source_report_sha256'} or type(mapping['version']) is not int or mapping['version'] != 1:
        raise ValueError('explicit versioned workspace/project/site/destination mapping required')
    if any(not isinstance(mapping[k], str) or not mapping[k] or len(mapping[k]) > 2048 for k in ('workspace_id', 'project_id', 'site', 'destination')):
        raise ValueError('mapping identity missing')
    if mapping['destination'] != 'portable-file':
        raise ValueError('native vendor adapter unsupported; use portable-file')
    if mapping['source_report_sha256'] != digest(report):
        raise ValueError('mapping belongs to another frozen report; scope refused')
    site = urlsplit(mapping['site'])
    if site.scheme not in ('http', 'https') or not site.hostname or site.username or site.password:
        raise ValueError('explicit site URL required')
    if not isinstance(report.get('rows'), list) or not isinstance(mapping['records'], dict):
        raise ValueError('frozen report entries and explicit record mappings required')
    rows, seen, external = [], set(), set()
    for entry in report['rows']:
        if not isinstance(entry, dict) or not {'id','source','target','state','reason','checked_at','evidence'}.issubset(entry):
            raise ValueError('incomplete frozen observation row')
        for field in ('source', 'target'):
            url = urlsplit(entry[field])
            if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
                raise ValueError('public source and target URLs without credentials required')
        local_id = entry.get('id')
        if not isinstance(local_id, str) or not local_id or local_id in seen:
            raise ValueError('missing or duplicate local identity')
        if urlsplit(entry.get('target') or '').hostname != site.hostname:
            raise ValueError('target belongs to another site; scope refused')
        seen.add(local_id)
        record = mapping['records'].get(local_id)
        if not record or set(record) != {'external_id', 'reply', 'suppression'}:
            raise ValueError('explicit external identity/reply/suppression required for every row')
        if not isinstance(record['external_id'], str) or not record['external_id'] or record['external_id'] in external:
            raise ValueError('missing or duplicate external identity')
        external.add(record['external_id'])
        if record['reply'] not in ('unknown', 'none', 'replied') or record['suppression'] not in ('unknown', 'suppressed', 'clear'):
            raise ValueError('unknown/replied/suppressed facts must remain explicit')
        # Keep the original observation payload and dates. Unknown never becomes lost.
        rows.append({'local_id': local_id, 'external_id': record['external_id'],
                     'source': entry.get('source'), 'target': entry.get('target'),
                     'state': entry['state'], 'reason': entry['reason'], 'checked_at': entry['checked_at'], 'evidence': entry['evidence'],
                     'checked_by': entry.get('checked_by'), 'occurrences': entry.get('occurrences'),
                     'reply': record['reply'], 'suppression': record['suppression'],
                     'send_eligible': False})
    if set(mapping['records']) != seen:
        raise ValueError('mapping contains records outside this frozen report')
    payload = {'version': 1, 'mode': 'draft_only', 'workspace_id': mapping['workspace_id'],
               'project_id': mapping['project_id'], 'site': mapping['site'], 'destination': mapping['destination'],
               'scope_verification': 'customer_supplied_mapping_unverified_hosted',
               'source_report_sha256': digest(report), 'mapping_sha256': digest(mapping),
               'rows': sorted(rows, key=lambda row: row['local_id'])}
    return {**payload, 'operation_id': 'portable_' + digest(payload), 'messages_sent': 0,
            'destination_outcome': 'not_attempted', 'native_vendor_acceptance': False}


@contextmanager
def _publication_lock(output):
    # Unsupported filesystems cannot publish by exclusive link. Serialize this
    # helper's writers in a host-local kernel lock; never infer lock ownership
    # from the existence or age of the cache file.
    try:
        import fcntl
    except ImportError as error:
        raise ValueError('filesystem lacks exclusive publication and native writer locking; preserve the checkpoint and use a supported local filesystem') from error
    root = Path('/tmp') / ('agentlinkops-handoff-locks-' + str(os.getuid()))
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('publication lock directory is not private; preserve the checkpoint')
    parent = output.parent.resolve()
    parent_info = parent.stat()
    identity = canonical([parent_info.st_dev, parent_info.st_ino, output.name.casefold()])
    lock_path = root / (hashlib.sha256(identity.encode('utf-8')).hexdigest() + '.lock')
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('publication lock file is not private; preserve the checkpoint')
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError('draft publication is busy; preserve the original operation and read back after its writer finishes')
                time.sleep(0.02)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _publish_bytes(output, content):
    output = Path(output)
    if output.exists():
        if output.read_bytes() != content:
            raise ValueError('existing handoff differs; preserve checkpoint and choose a new output')
        return 'identical_readback'
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.handoff-', dir=output.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(content); f.flush(); os.fsync(f.fileno())
        try:
            os.link(temporary, output)
        except FileExistsError:
            if output.read_bytes() != content:
                raise ValueError('concurrent handoff differs; preserve checkpoint')
            return 'identical_readback'
        except OSError as error:
            if error.errno not in {errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS}:
                raise
            # ExFAT has neither hard links nor exclusive rename. All fallback
            # writers take the same kernel lock and re-read before publication.
            # This protects cooperating helper writers, not arbitrary external
            # applications writing the same filename outside this protocol.
            with _publication_lock(output):
                if output.exists():
                    if output.read_bytes() != content:
                        raise ValueError('concurrent handoff differs; preserve checkpoint')
                    return 'identical_readback'
                os.rename(temporary, output)
                if output.read_bytes() != content:
                    raise ValueError('artifact readback mismatch; preserve operation identity')
        if output.read_bytes() != content:
            raise ValueError('artifact readback mismatch; preserve operation identity')
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass  # A successful rename consumed only this writer's temporary.
    return 'saved_and_read_back'


def save(bundle, output):
    return _publish_bytes(output, (canonical(bundle) + '\n').encode('utf-8'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', required=True)
    parser.add_argument('--mapping', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    bundle = prepare(json.loads(Path(args.report).read_text(encoding='utf-8')), json.loads(Path(args.mapping).read_text(encoding='utf-8')))
    receipt = save(bundle, args.out)
    print(canonical({'operation_id': bundle['operation_id'], 'artifact': receipt, 'rows': len(bundle['rows']),
                     'messages_sent': 0, 'destination_outcome': 'not_attempted'}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit('portable handoff refused: ' + str(error))
