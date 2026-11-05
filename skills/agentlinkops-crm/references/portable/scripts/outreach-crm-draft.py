#!/usr/bin/env python3
"""Save/read back an explicitly mapped draft in a customer-selected local Outreach CRM.
No network, send, sequence activation, or contact/authority-state writes.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('portable_handoff', Path(__file__).with_name('portable-handoff.py'))
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(label + ' must be explicit')
    return value


def host(value):
    parsed = urlsplit(text(value, 'site'))
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('site must be an explicit URL without credentials')
    return parsed.hostname.lower()


def prepare(root, request, body):
    fields = {'version', 'crm_project', 'workspace_id', 'project_id', 'site', 'operation_id',
              'original_request', 'local_id', 'external_id', 'observation', 'reply',
              'suppression', 'subject', 'body_sha256'}
    if not isinstance(request, dict) or set(request) != fields or type(request['version']) is not int or request['version'] != 1:
        raise ValueError('explicit version 1 draft request required; see local CRM handoff reference')
    for field in fields - {'version', 'original_request'}:
        text(request[field], field)
    project = request['crm_project']
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project):
        raise ValueError('crm_project must be one project directory name')
    root = Path(root).resolve(strict=True)
    project_dir = root / 'projects' / project
    # Refuse symlink redirection in destination directories, including an existing
    # operation directory. This is a cooperating local writer, not an OS sandbox.
    for path in (root / 'projects', project_dir, project_dir / 'config.json', project_dir / 'drafts'):
        if path.is_symlink():
            raise ValueError('destination symlink refused: ' + str(path))
    config = json.loads((project_dir / 'config.json').read_text(encoding='utf-8'))
    if not isinstance(config, dict) or config.get('project') != project or host(config.get('site')) != host(request['site']):
        raise ValueError('CRM config identity/site mismatch; preserve original mapping')
    if not (project_dir / 'drafts').is_dir():
        raise ValueError('selected CRM drafts directory missing; initialize that project first')
    original = request['original_request']
    if not isinstance(original, dict) or set(original) != {'destination', 'workspace_id', 'project_id', 'command', 'arguments', 'idempotency_key'}:
        raise ValueError('complete original non-secret request tuple required')
    for field in ('destination', 'workspace_id', 'project_id', 'command', 'idempotency_key'):
        text(original[field], 'original_request.' + field)
    if not isinstance(original['arguments'], dict):
        raise ValueError('original request arguments must be an object')
    if any(original[field] != request[field] for field in ('workspace_id', 'project_id')):
        raise ValueError('original request scope mismatch; preserve original mapping')
    if request['observation'] not in ('unknown', 'present', 'provisional_loss', 'confirmed_loss'):
        raise ValueError('explicit supported observation required')
    if request['reply'] not in ('unknown', 'none', 'replied') or request['suppression'] not in ('unknown', 'clear', 'suppressed'):
        raise ValueError('explicit reply/suppression observation required')
    if '\n' in request['subject'] or '\r' in request['subject']:
        raise ValueError('subject must be one line')
    body.decode('utf-8')
    if not body or hashlib.sha256(body).hexdigest() != request['body_sha256']:
        raise ValueError('body bytes do not match the original draft hash')
    identity = {field: request[field] for field in ('crm_project', 'workspace_id', 'project_id', 'operation_id', 'local_id', 'external_id')}
    directory = project_dir / 'drafts' / ('agentlinkops-' + portable.digest(identity))
    if directory.is_symlink():
        raise ValueError('destination operation symlink refused')
    manifest = {'version': 1, 'destination': 'local-outreach-crm-drafts', 'request': request,
                'body_file': 'body.txt', 'send_eligible': False, 'messages_sent': 0,
                'native_vendor_acceptance': False, 'hosted_scope_verification': 'customer_supplied_unverified'}
    return directory, (portable.canonical(manifest) + '\n').encode('utf-8')


def save(root, request, body, readback=False):
    directory, manifest = prepare(root, request, body)
    artifacts = [(directory / 'body.txt', body), (directory / 'manifest.json', manifest)]
    if readback and not directory.is_dir():
        raise ValueError('draft readback missing; resume the original save')
    if not readback:
        directory.mkdir(exist_ok=True)
    with portable._publication_lock(directory / 'draft-transaction'):
        for path, expected in artifacts:
            if path.is_symlink() or (path.exists() and (not path.is_file() or path.read_bytes() != expected)):
                raise ValueError('saved draft differs; retain original operation and inspect ' + str(path))
            if readback and not path.is_file():
                raise ValueError('draft readback incomplete; resume the original save')
        outcomes = [] if readback else [portable._publish_bytes(path, expected) for path, expected in artifacts]
        if any(path.read_bytes() != expected for path, expected in artifacts):
            raise ValueError('draft readback mismatch; preserve original operation')
    return {'operation_id': request['operation_id'], 'crm_project': request['crm_project'],
            'local_id': request['local_id'], 'external_id': request['external_id'],
            'directory': str(directory), 'body_sha256': request['body_sha256'],
            'manifest_sha256': hashlib.sha256(manifest).hexdigest(),
            'outcome': 'saved_and_read_back' if 'saved_and_read_back' in outcomes else 'identical_readback',
            'messages_sent': 0, 'send_eligible': False, 'native_vendor_acceptance': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--crm-root', required=True)
    parser.add_argument('--request', required=True)
    parser.add_argument('--body-file', required=True)
    parser.add_argument('--readback', action='store_true')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8'))
    print(portable.canonical(save(args.crm_root, request, Path(args.body_file).read_bytes(), args.readback)))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit('local CRM draft refused: ' + str(error))
