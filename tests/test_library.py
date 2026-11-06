import base64
import concurrent.futures
import copy
import http.client
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('library', ROOT / 'scripts/library.py')
library = importlib.util.module_from_spec(spec)
sys.modules['library'] = library
spec.loader.exec_module(library)
spec = importlib.util.spec_from_file_location('pattern_serve', ROOT / 'scripts/serve.py')
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


def pattern(title='小猫挂件', width=4, height=4):
    return {
        'version': 2,
        'title': title,
        'mode': 'bead',
        'width': width,
        'height': height,
        'palette': [
            {'id': 'CREAM', 'hex': '#ffffff', 'stock': 100},
            {'id': 'INK', 'hex': '#000000'},
        ],
        'cells': [None, 1] + [0] * (width * height - 2),
        'source': {'name': '猫咪.png', 'fit': 'contain'},
    }


def image_data(color='red', size=(8, 8)):
    stream = io.BytesIO()
    Image.new('RGBA', size, color).save(stream, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode('ascii')


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / 'archive'

    def tearDown(self):
        self.temporary.cleanup()

    def save(self, item=None, **kwargs):
        return library.save_case(item or pattern(), library_dir=self.path, **kwargs)

    def test_archive_survives_new_connections_with_assets_and_no_stock(self):
        result = self.save(
            source_data=image_data(), metadata={'tags': ['宠物', '挂件'], 'status': 'final'}
        )
        identity = result['case']['id']
        self.assertTrue(result['created'])
        self.assertTrue((self.path / 'library.sqlite3').is_file())
        loaded = library.get_case(identity, library_dir=self.path)
        self.assertEqual(loaded['pattern']['cells'][0], None)
        self.assertNotIn('stock', loaded['pattern']['palette'][0])
        self.assertEqual(loaded['case']['bead_count'], 15)
        self.assertEqual(loaded['case']['color_count'], 2)
        self.assertEqual(loaded['case']['tags'], ['宠物', '挂件'])
        self.assertIsNotNone(loaded['source_url'])
        self.assertTrue(library.case_asset(identity, 'source', library_dir=self.path).is_file())
        self.assertTrue(library.case_asset(identity, 'preview', library_dir=self.path).is_file())
        self.assertEqual(library.library_info(self.path)['case_count'], 1)

    def test_same_content_deduplicates_and_metadata_rename_does_not_version(self):
        first = self.save(source_data=image_data())
        item = pattern('改名后的小猫')
        item['metrics'] = {'removed_background': 1, 'cleaned_cells': 0}
        second = self.save(item, source_data=image_data(), metadata={'title': '我的猫猫'})
        self.assertEqual(first['case']['id'], second['case']['id'])
        self.assertFalse(second['version_added'])
        self.assertEqual(second['case']['version_count'], 1)
        self.assertEqual(second['case']['title'], '我的猫猫')
        third = self.save(source_data=image_data('blue'))
        self.assertNotEqual(first['case']['id'], third['case']['id'])

    def test_color_distinction_survives_archiving_and_versions_without_rewriting_old_settings(self):
        item = pattern()
        item['processing'] = {'color_detail': 'low'}
        first = self.save(item)
        identity = first['case']['id']
        self.assertEqual(
            library.get_case(identity, library_dir=self.path)['pattern']['processing'][
                'color_detail'
            ],
            'low',
        )
        item['processing']['color_detail'] = 'high'
        second = self.save(item, case_id=identity)
        self.assertEqual(second['case']['version_count'], 2)
        self.assertEqual(
            library.get_case(identity, version=1, library_dir=self.path)['pattern']['processing'][
                'color_detail'
            ],
            'low',
        )
        self.assertEqual(
            library.get_case(identity, library_dir=self.path)['pattern']['processing'][
                'color_detail'
            ],
            'high',
        )
        item['processing']['color_detail'] = 'invalid'
        with self.assertRaises(ValueError):
            self.save(item)

    def test_edited_version_keeps_previous_pattern_and_reuses_original(self):
        first = self.save(source_data=image_data())
        identity = first['case']['id']
        item = pattern()
        item['cells'][0] = 1
        second = self.save(item, case_id=identity)
        self.assertEqual(second['case']['version_count'], 2)
        old = library.get_case(identity, version=1, library_dir=self.path)
        current = library.get_case(identity, library_dir=self.path)
        self.assertIsNone(old['pattern']['cells'][0])
        self.assertEqual(current['pattern']['cells'][0], 1)
        self.assertEqual([v['version'] for v in current['versions']], [2, 1])
        self.assertEqual(
            library.case_asset(identity, 'source', 1, self.path).read_bytes(),
            library.case_asset(identity, 'source', 2, self.path).read_bytes(),
        )
        cleared = self.save(item, case_id=identity, source_data=None)
        self.assertEqual(cleared['case']['version_count'], 3)
        self.assertIsNone(library.get_case(identity, library_dir=self.path)['source_url'])
        self.assertIsNotNone(library.get_case(identity, 1, self.path)['source_url'])

    def test_keywords_tags_notes_and_specs_filter_together(self):
        self.save(
            metadata={'tags': ['宠物', '小猫'], 'description': '给朋友的礼物', 'status': 'final'}
        )
        self.save(pattern('大火箭', 40, 40), metadata={'tags': ['航天']})
        result = library.search_cases(
            '小猫 礼物',
            library_dir=self.path,
            max_width=48,
            max_colors=2,
            max_beads=20,
            status='final',
        )
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['items'][0]['title'], '小猫挂件')
        self.assertEqual(library.search_cases('猫咪.png', library_dir=self.path)['total'], 2)
        self.assertEqual(library.search_cases("' OR 1=1 --", library_dir=self.path)['total'], 0)
        self.assertEqual(library.search_cases('%', library_dir=self.path)['total'], 0)
        self.assertEqual(library.search_cases('', library_dir=self.path, max_width=3)['total'], 0)

    def test_no_source_can_still_be_saved_and_previewed(self):
        result = self.save()
        loaded = library.get_case(result['case']['id'], library_dir=self.path)
        self.assertIsNone(loaded['source_url'])
        with self.assertRaises(FileNotFoundError):
            library.case_asset(result['case']['id'], 'source', library_dir=self.path)
        with Image.open(
            library.case_asset(result['case']['id'], 'preview', library_dir=self.path)
        ) as image:
            self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_invalid_input_cannot_create_a_case_or_escape_directory(self):
        invalid = pattern()
        invalid['cells'][0] = False
        for item, options in [
            (invalid, {}),
            (pattern(), {'case_id': '../outside'}),
            (pattern(), {'source_data': 'data:text/html;base64,AA=='}),
            (pattern(), {'metadata': {'tags': ['a'] * 21}}),
        ]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.save(item, **options)
        self.assertEqual(library.library_info(self.path)['case_count'], 0)
        self.assertEqual(list((self.path / 'cases').glob('*')), [])

    def test_metadata_update_preserves_versions(self):
        result = self.save()
        edited = library.update_case(
            result['case']['id'],
            {'title': '已完成的小猫', 'tags': ['纪念'], 'status': 'made'},
            self.path,
        )
        self.assertEqual(edited['case']['status'], 'made')
        self.assertEqual(edited['case']['version_count'], 1)
        self.assertEqual(library.search_cases('纪念', library_dir=self.path)['total'], 1)

    def test_backup_restore_and_repeat_import_preserve_versions(self):
        first = self.save(source_data=image_data(), metadata={'tags': ['小猫']})
        changed = pattern()
        changed['cells'][0] = 0
        self.save(changed, case_id=first['case']['id'])
        backup = library.backup_library(self.path)
        target = Path(self.temporary.name) / 'restored'
        result = library.import_library(backup, target)
        self.assertEqual(result['case_count'], 1)
        rows = library.search_cases('小猫', library_dir=target)['items']
        self.assertEqual(rows[0]['version_count'], 2)
        self.assertEqual(rows[0]['created_at'], backup['cases'][0]['created_at'])
        self.assertEqual(
            library.get_case(rows[0]['id'], 1, target)['versions'][-1]['created_at'],
            backup['cases'][0]['versions'][0]['created_at'],
        )
        self.assertEqual(library.get_case(rows[0]['id'], 1, target)['pattern']['cells'][0], None)
        library.update_case(rows[0]['id'], {'title': '导入后精修的小猫'}, target)
        again = library.import_library(backup, target)
        self.assertEqual(again['versions_added'], 0)
        self.assertEqual(
            library.search_cases('', library_dir=target)['items'][0]['version_count'], 2
        )
        self.assertEqual(
            library.search_cases('', library_dir=target)['items'][0]['title'], '导入后精修的小猫'
        )

    def test_backup_validates_all_versions_before_first_write(self):
        self.save()
        backup = library.backup_library(self.path)
        second = copy.deepcopy(backup['cases'][0])
        second['versions'][0]['pattern']['width'] = 999
        backup['cases'].append(second)
        target = Path(self.temporary.name) / 'invalid-restore'
        with self.assertRaises(ValueError):
            library.import_library(backup, target)
        self.assertFalse(target.exists())

    def test_parallel_identical_saves_do_not_duplicate_cases(self):
        library.library_info(self.path)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: self.save(), range(8)))
        self.assertEqual(len({result['case']['id'] for result in results}), 1)
        self.assertEqual(library.library_info(self.path)['case_count'], 1)

    def test_cli_add_search_and_backup_use_explicit_library(self):
        source = Path(self.temporary.name) / 'pattern.json'
        source.write_text(json.dumps(pattern()), encoding='utf-8')
        stream = io.StringIO()
        with patch('sys.stdout', stream):
            library.main(['--library', str(self.path), 'add', str(source), '--tags', '宠物,挂件'])
        self.assertEqual(json.loads(stream.getvalue())['case']['tags'], ['宠物', '挂件'])
        stream = io.StringIO()
        with patch('sys.stdout', stream):
            library.main(['--library', str(self.path), 'search', '宠物', '--max-width', '48'])
        self.assertEqual(json.loads(stream.getvalue())['total'], 1)

    def test_build_cli_automatically_archives_and_can_explicitly_skip(self):
        root = Path(self.temporary.name)
        output = root / 'pattern.html'
        environment = dict(os.environ, CRAFT_PATTERN_LIBRARY=str(self.path))
        command = [
            sys.executable,
            str(ROOT / 'scripts/build.py'),
            str(ROOT / 'examples/input.json'),
            '--output',
            str(output),
            '--tags',
            '自动归档,小猫',
        ]
        completed = subprocess.run(
            command, env=environment, text=True, capture_output=True, check=True
        )
        self.assertIn('已收录案例', completed.stdout)
        found = library.search_cases('自动归档', library_dir=self.path)
        self.assertEqual(found['total'], 1)
        record = library.get_case(found['items'][0]['id'], library_dir=self.path)
        self.assertIsNotNone(record['source_url'])
        self.assertEqual(record['case']['bead_count'], 906)
        self.assertIn('CaseLibraryUI', output.read_text())
        skipped = root / 'skip-library'
        subprocess.run(
            command + ['--library', str(skipped), '--no-archive'],
            env=environment,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertFalse(skipped.exists())


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.static = root / 'web'
        self.static.mkdir()
        (self.static / 'docs').mkdir()
        (self.static / 'docs/index.html').write_text('<h1>Pattern editor</h1>')
        (root / 'secret.txt').write_text('private')
        (self.static / 'escape.txt').symlink_to(root / 'secret.txt')
        self.server = serve.create_server(0, self.static, root / 'library')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f'127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        request_headers = {'Content-Type': 'application/json'}
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        payload = None if body is None else json.dumps(body).encode('utf-8')
        connection.request(method, path, body=payload, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        status, response_headers = response.status, dict(response.getheaders())
        connection.close()
        if 'application/json' in response_headers.get('Content-Type', ''):
            raw = json.loads(raw)
        return status, response_headers, raw

    def test_http_archive_search_restore_and_assets(self):
        status, headers, body = self.request(
            'POST',
            '/api/library/cases',
            {'pattern': pattern(), 'source_data': image_data(), 'tags': ['宠物']},
            {'Origin': 'http://' + self.host},
        )
        self.assertEqual(status, 201)
        identity = body['case']['id']
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        status, _, found = self.request('GET', '/api/library/cases?max_width=48&max_colors=8')
        self.assertEqual((status, found['total']), (200, 1))
        status, _, loaded = self.request('GET', '/api/library/cases/' + identity)
        self.assertEqual(loaded['pattern']['cells'].count(None), 1)
        status, headers, raw = self.request('GET', loaded['source_url'])
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertTrue(raw.startswith(b'\x89PNG'))
        status, _, body = self.request(
            'PATCH', '/api/library/cases/' + identity, {'status': 'made'}
        )
        self.assertEqual(body['case']['status'], 'made')
        status, _, backup = self.request('GET', '/api/library/backup')
        self.assertEqual(backup['format'], 'craft-pattern-library')
        self.assertEqual(self.request('POST', '/api/library/import', backup)[2]['case_count'], 1)

    def test_rejects_cross_site_origin_untrusted_host_and_content_type(self):
        self.assertEqual(
            self.request(
                'POST',
                '/api/library/cases',
                {'pattern': pattern()},
                {'Origin': 'https://evil.example'},
            )[0],
            403,
        )
        self.assertEqual(
            self.request('GET', '/api/library/info', headers={'Host': 'evil.example'})[0], 403
        )
        self.assertEqual(
            self.request(
                'POST', '/api/library/cases', {'pattern': pattern()}, {'Content-Type': 'text/plain'}
            )[0],
            400,
        )
        self.assertEqual(self.request('GET', '/api/library/info')[2]['case_count'], 0)

    def test_static_files_stay_inside_root(self):
        self.assertEqual(self.request('GET', '/')[0], 302)
        self.assertEqual(self.request('GET', '/docs/index.html')[0], 200)
        self.assertEqual(self.request('GET', '/escape.txt')[0], 404)
        self.assertEqual(self.request('GET', '/%2e%2e/secret.txt')[0], 404)
        self.assertEqual(self.request('GET', '/api/library/cases/not-a-case')[0], 404)


class ServiceLifecycleTests(unittest.TestCase):
    """Real detached processes, isolated from the user's service and library."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.archive = root / 'library'
        self.static = root / 'web'
        (self.static / 'docs').mkdir(parents=True)
        (self.static / 'docs/index.html').write_text('<h1>Lifecycle test</h1>')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]

    def tearDown(self):
        serve.stop_service(self.port, self.archive)
        self.temporary.cleanup()

    def command(self, mode, archive=None, check=True):
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / 'scripts/serve.py'),
                mode,
                '--port',
                str(self.port),
                '--directory',
                str(self.static),
                '--library',
                str(archive or self.archive),
            ],
            capture_output=True,
            text=True,
            timeout=12,
            check=check,
        )
        return json.loads(completed.stdout) if completed.returncode == 0 else completed

    def test_background_outlives_launcher_reuses_and_restarts_after_safe_stop(self):
        started = self.command('--background')
        self.assertTrue(started['running'])
        self.assertFalse(started['reused'])
        self.assertNotEqual(started['pid'], os.getpid())
        record = Path(started['record'])
        self.assertTrue(record.is_file())
        self.assertTrue(Path(started['log']).is_file())
        current = self.command('--status')
        self.assertTrue(current['running'])
        self.assertTrue(current['managed'])
        self.assertEqual(current['pid'], started['pid'])
        again = self.command('--background')
        self.assertTrue(again['reused'])
        self.assertEqual(again['instance_id'], started['instance_id'])
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        connection.request('GET', '/docs/index.html')
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn(b'Lifecycle test', response.read())
        connection.close()
        unrelated = self.archive / 'server-unrelated.json'
        unrelated.write_text('{"keep":true}')
        stopped = self.command('--stop')
        self.assertTrue(stopped['stopped'])
        self.assertFalse(self.command('--status')['running'])
        self.assertFalse(record.exists())
        self.assertTrue(unrelated.exists())
        self.assertFalse(self.command('--stop')['stopped'])
        restarted = self.command('--background')
        self.assertTrue(restarted['running'])
        self.assertNotEqual(restarted['instance_id'], started['instance_id'])

    def test_different_library_or_tampered_pid_record_cannot_stop_service(self):
        started = self.command('--background')
        other = self.archive.parent / 'other-library'
        self.assertFalse(self.command('--status', other)['running'])
        self.assertFalse(self.command('--stop', other)['stopped'])
        blocked = self.command('--background', other, check=False)
        self.assertEqual(blocked.returncode, 2)
        self.assertIn('占用', blocked.stderr)
        record_path = Path(started['record'])
        original = record_path.read_text()
        tampered = json.loads(original)
        tampered['pid'] = os.getpid()
        record_path.write_text(json.dumps(tampered))
        try:
            refused = self.command('--stop')
            self.assertFalse(refused['stopped'])
            self.assertTrue(self.command('--status')['running'])
        finally:
            record_path.write_text(original)

    def test_unrelated_listener_is_not_replaced_or_signaled(self):
        import http.server

        class OtherHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(inner):
                data = b'{"service":"unrelated"}'
                inner.send_response(200)
                inner.send_header('Content-Length', str(len(data)))
                inner.end_headers()
                inner.wfile.write(data)

            def log_message(inner, *args):
                pass

        listener = http.server.ThreadingHTTPServer(('127.0.0.1', self.port), OtherHandler)
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()
        try:
            blocked = self.command('--background', check=False)
            self.assertEqual(blocked.returncode, 2)
            self.assertIn('未停止或替换', blocked.stderr)
            self.archive.mkdir()
            fake = {
                'service': 'craft-pattern',
                'port': self.port,
                'library': str(self.archive),
                'pid': os.getpid(),
                'instance_id': 'a' * 32,
                'background': True,
            }
            (self.archive / f'server-{self.port}.json').write_text(json.dumps(fake))
            with patch.object(serve.os, 'kill') as kill:
                self.assertFalse(serve.stop_service(self.port, self.archive)['stopped'])
                kill.assert_not_called()
            self.assertEqual(serve._health(self.port)['service'], 'unrelated')
        finally:
            listener.shutdown()
            listener.server_close()
            thread.join()

    def test_background_startup_failure_reports_its_log(self):
        self.archive.mkdir()
        (self.archive / 'library.sqlite3').mkdir()
        failed = self.command('--background', check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn('日志', failed.stderr)
        log = self.archive / f'server-{self.port}.log'
        self.assertTrue(log.is_file())
        self.assertIn('sqlite', log.read_text().lower())
        self.assertIsNone(serve._health(self.port))


if __name__ == '__main__':
    unittest.main()
