"""Read-only guard for serialized Playwright webServer environments.

This checks the known configuration boundary, not arbitrary secrets in user data.
All errors are fixed codes: report contents, keys and environment values stay local.
"""
import argparse
import base64
import binascii
import io
import json
from pathlib import Path
import re
import sys
import zipfile
import zlib

from stable_reports import _Tree


MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_HTML_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_ZIP_ENTRIES = 4096
PREFIX = b'data:application/zip;base64,'
PAYLOAD = re.compile(re.escape(PREFIX) + rb'([A-Za-z0-9+/=]+)')


class ReportSafetyError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__('报告安全检查拒绝：' + reason)


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ReportSafetyError('ambiguous-json')
        value[key] = item
    return value


def _constant(unused):
    raise ReportSafetyError('invalid-json')


def _configuration(payload):
    value = json.loads(payload, object_pairs_hook=_pairs, parse_constant=_constant)
    if type(value) is not dict:
        raise ReportSafetyError('invalid-report-object')
    config = value.get('config', {})
    if type(config) is not dict:
        raise ReportSafetyError('invalid-config-object')
    servers = config.get('webServer')
    if servers is None:
        return
    if type(servers) is dict:
        servers = [servers]
    if type(servers) is not list:
        raise ReportSafetyError('invalid-webserver-config')
    for server in servers:
        if type(server) is not dict:
            raise ReportSafetyError('invalid-webserver-config')
        environment = server.get('env')
        if environment is not None and (type(environment) is not dict or environment):
            raise ReportSafetyError('serialized-webserver-environment')


def _html(payload):
    matches = list(PAYLOAD.finditer(payload))
    if len(matches) != payload.count(PREFIX) or len(matches) > 1:
        raise ReportSafetyError('invalid-html-report-payload')
    # Static diagnostics without an embedded report remain valid. Real Playwright
    # HTML is inspected after base64/ZIP decoding, never just searched as text.
    for match in matches:
        archive = base64.b64decode(match[1], validate=True)
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            entries = zipped.infolist()
            if not entries or len(entries) > MAX_ZIP_ENTRIES:
                raise ReportSafetyError('html-report-entry-budget')
            names = set(); total = 0
            for entry in entries:
                name = entry.filename
                if (name in names or not name.endswith('.json') or entry.flag_bits & 1
                        or '\\' in name or any(part in ('', '.', '..') for part in name.split('/'))):
                    raise ReportSafetyError('invalid-html-report-member')
                names.add(name); total += entry.file_size
                if entry.file_size > MAX_JSON_BYTES or total > MAX_EXPANDED_BYTES:
                    raise ReportSafetyError('html-report-expanded-budget')
                with zipped.open(entry) as stream:
                    data = stream.read(min(MAX_JSON_BYTES, MAX_EXPANDED_BYTES) + 1)
                if len(data) != entry.file_size or len(data) > MAX_JSON_BYTES:
                    raise ReportSafetyError('invalid-html-report-size')
                _configuration(data)


def check_leaf(root, leaf):
    """Check one owned report leaf; caller keeps publication/run locks and IO ownership."""
    if leaf not in ('test-results', 'playwright-report'):
        raise ReportSafetyError('unknown-report-leaf')
    relative = 'results.json' if leaf == 'test-results' else 'index.html'
    limit = MAX_JSON_BYTES if leaf == 'test-results' else MAX_HTML_BYTES
    checked = 0
    try:
        with _Tree(Path(root)) as tree:
            if tree.exists(relative):
                unused_count, unused_sha, unused_identity, payload = tree.read(relative, limit=limit, collect=True)
                if leaf == 'test-results':
                    _configuration(payload)
                else:
                    _html(payload)
                checked = 1
            tree.check()
    except ReportSafetyError:
        raise
    except (OSError, ValueError, RuntimeError, RecursionError, zipfile.BadZipFile, binascii.Error, zlib.error):
        raise ReportSafetyError('unverifiable-report-input') from None
    return {'version': 1, 'leaf': leaf, 'checkedFiles': checked}


def main():
    parser = argparse.ArgumentParser(description='只读检查报告配置环境，不输出报告正文')
    parser.add_argument('--results', type=Path)
    parser.add_argument('--html', type=Path)
    args = parser.parse_args()
    if args.results is None and args.html is None:
        parser.error('至少指定一个报告叶目录')
    checked = []
    for path, leaf in [(args.results, 'test-results'), (args.html, 'playwright-report')]:
        if path is not None:
            checked.append(check_leaf(path, leaf))
    print(json.dumps({'status': 'passed', 'checks': checked}))


if __name__ == '__main__':
    try:
        main()
    except ReportSafetyError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
