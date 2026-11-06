#!/usr/bin/env python3
"""Serve the offline editor and its private, loopback-only case library."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import library

ROOT = Path(__file__).resolve().parents[1]
CASE_ROUTE = re.compile(r'^/api/library/cases/([0-9a-f]{32})(?:/(source|preview))?$')


class LibraryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, library_dir=None, **kwargs):
        self.library_dir = library_dir
        self.root_directory = Path(directory or ROOT).resolve()
        super().__init__(*args, directory=str(self.root_directory), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        if self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _trusted(self):
        host = self.headers.get('Host', '')
        try:
            parsed = urlsplit('http://' + host)
            allowed = (
                parsed.hostname in ('127.0.0.1', 'localhost', '::1')
                and not parsed.username
                and not parsed.password
                and not parsed.path
            )
            if parsed.port != self.server.server_port:
                allowed = allowed and parsed.port is None and self.server.server_port == 80
        except ValueError:
            allowed = False
        if not allowed:
            self._json(403, {'error': '仅允许本机访问'})
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin != 'http://' + host:
            self._json(403, {'error': '不允许跨站访问案例库'})
            return False
        return True

    def _json(self, status, value):
        body = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _body(self, maximum=32 * 1024 * 1024):
        if (
            self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
            != 'application/json'
        ):
            raise ValueError('请求须为 application/json')
        raw_length = self.headers.get('Content-Length', '')
        try:
            length = int(raw_length)
        except ValueError:
            raise ValueError('请求长度无效') from None
        if length < 0 or length > maximum:
            raise ValueError('请求内容过大')
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise ValueError('JSON 格式无效') from None
        if not isinstance(value, dict):
            raise ValueError('请求须为 JSON 对象')
        return value

    def _route(self):
        parsed = urlsplit(self.path)
        return parsed.path, {
            key: values[-1]
            for key, values in parse_qs(parsed.query, keep_blank_values=True).items()
        }

    def _error(self, error):
        if isinstance(error, FileNotFoundError):
            self._json(404, {'error': str(error)})
        elif isinstance(error, (ValueError, TypeError, KeyError)):
            self._json(400, {'error': str(error)})
        else:
            self.log_error('Library failure: %s', error)
            self._json(500, {'error': '本地案例库暂时无法读写，请检查目录权限。'})

    def do_GET(self):
        if not self._trusted():
            return
        path, query = self._route()
        try:
            if path == '/api/library/info':
                return self._json(
                    200, dict(library.library_info(self.library_dir), **self.server.service_info)
                )
            if path == '/api/library/cases':
                filters = {
                    key: query[key]
                    for key in (
                        'max_width',
                        'max_height',
                        'max_colors',
                        'max_beads',
                        'status',
                        'limit',
                        'offset',
                    )
                    if key in query
                }
                return self._json(
                    200,
                    library.search_cases(
                        query.get('q', ''), library_dir=self.library_dir, **filters
                    ),
                )
            if path == '/api/library/backup':
                return self._json(200, library.backup_library(self.library_dir))
            match = CASE_ROUTE.fullmatch(path)
            if match:
                identity, asset = match.groups()
                version = query.get('version')
                if asset:
                    file = library.case_asset(identity, asset, version, self.library_dir)
                    body = file.read_bytes()
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/png')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                return self._json(200, library.get_case(identity, version, self.library_dir))
            if path.startswith('/api/'):
                return self._json(404, {'error': '接口不存在'})
            if path == '/':
                self.send_response(302)
                self.send_header('Location', '/docs/index.html')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self._static_path(path)
            return super().do_GET()
        except (ValueError, TypeError, KeyError, OSError, sqlite3.Error) as error:
            self._error(error)

    def _static_path(self, path):
        decoded = unquote(path)
        if '\\' in decoded or '\0' in decoded or '..' in decoded.split('/'):
            raise FileNotFoundError('文件不存在')
        resolved = Path(self.translate_path(path)).resolve()
        if not resolved.is_relative_to(self.root_directory):
            raise FileNotFoundError('文件不存在')
        return resolved

    def do_HEAD(self):
        if not self._trusted():
            return
        path, query = self._route()
        if path.startswith('/api/'):
            return self._json(405, {'error': '接口不支持此方法'})
        try:
            self._static_path(path)
            super().do_HEAD()
        except OSError as error:
            self._error(error)

    def do_POST(self):
        if not self._trusted():
            return
        path, query = self._route()
        try:
            if path == '/api/library/cases':
                body = self._body()
                metadata = {
                    key: body[key]
                    for key in ('title', 'tags', 'description', 'status')
                    if key in body
                }
                images = {key: body[key] for key in ('source_data', 'preview_data') if key in body}
                result = library.save_case(
                    body.get('pattern'),
                    metadata=metadata,
                    case_id=body.get('case_id'),
                    library_dir=self.library_dir,
                    **images,
                )
                return self._json(201 if result['created'] else 200, result)
            if path == '/api/library/import':
                return self._json(
                    200,
                    library.import_library(self._body(library.MAX_BACKUP_BYTES), self.library_dir),
                )
            self._json(404, {'error': '接口不存在'})
        except (ValueError, TypeError, KeyError, OSError, sqlite3.Error) as error:
            self._error(error)

    def do_PATCH(self):
        if not self._trusted():
            return
        path, query = self._route()
        match = CASE_ROUTE.fullmatch(path)
        if not match or match.group(2):
            return self._json(404, {'error': '接口不存在'})
        try:
            body = self._body(20_000)
            self._json(200, library.update_case(match.group(1), body, self.library_dir))
        except (ValueError, TypeError, KeyError, OSError, sqlite3.Error) as error:
            self._error(error)

    def do_OPTIONS(self):
        self._json(405, {'error': '不提供跨站访问'})


def create_server(port=8765, directory=None, library_dir=None, instance_id=None):
    library.library_info(library_dir)
    directory = Path(directory or ROOT).expanduser().resolve()
    if not directory.is_dir():
        raise ValueError('网页目录不存在')
    server = ThreadingHTTPServer(
        ('127.0.0.1', port), partial(LibraryHandler, directory=directory, library_dir=library_dir)
    )
    server.service_info = {
        'service': 'craft-pattern',
        'instance_id': instance_id or uuid.uuid4().hex,
        'pid': os.getpid(),
        'port': server.server_port,
        'directory': str(directory),
        'library': str(library.library_path(library_dir)),
    }
    return server


def _record_path(port, library_dir=None):
    return library.library_path(library_dir) / f'server-{port}.json'


def _log_path(port, library_dir=None):
    name = 'server.log' if port == 8765 else f'server-{port}.log'
    return library.library_path(library_dir) / name


def _read_record(port, library_dir=None):
    path = _record_path(port, library_dir)
    try:
        if path.stat().st_size > 20_000:
            return None
        record = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    if (
        record.get('service') != 'craft-pattern'
        or record.get('port') != port
        or record.get('library') != str(library.library_path(library_dir))
        or type(record.get('pid')) is not int
        or record['pid'] <= 1
        or not isinstance(record.get('instance_id'), str)
        or not re.fullmatch(r'[0-9a-f]{32}', record['instance_id'])
    ):
        return None
    return record


def _write_record(info, library_dir=None):
    path = _record_path(info['port'], library_dir)
    temporary = path.with_name(path.name + f'.{os.getpid()}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            os.chmod(temporary, 0o600)
            json.dump(info, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_record(port, instance_id, library_dir=None):
    record = _read_record(port, library_dir)
    if record and record['instance_id'] == instance_id:
        _record_path(port, library_dir).unlink(missing_ok=True)


def _health(port, timeout=0.35):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        connection.request('GET', '/api/library/info')
        response = connection.getresponse()
        if response.status != 200:
            return None
        data = response.read(65537)
        if len(data) > 65536:
            return None
        value = json.loads(data)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def _matches(info, port, library_dir=None, directory=None):
    return bool(
        info
        and info.get('service') == 'craft-pattern'
        and info.get('port') == port
        and info.get('library') == str(library.library_path(library_dir))
        and (
            directory is None
            or info.get('directory') == str(Path(directory).expanduser().resolve())
        )
        and type(info.get('pid')) is int
        and info['pid'] > 1
        and isinstance(info.get('instance_id'), str)
        and re.fullmatch(r'[0-9a-f]{32}', info['instance_id'])
    )


def _process_matches(record, live=None):
    """PID reuse must never authorize stopping an unrelated process."""
    try:
        completed = subprocess.run(
            ['ps', '-p', str(record['pid']), '-o', 'command='],
            capture_output=True,
            text=True,
            timeout=1,
            check=False,
        )
        arguments = shlex.split(completed.stdout.strip())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False
    script = str(Path(__file__).resolve())
    if not any(value == script or Path(value).name == 'serve.py' for value in arguments):
        return False
    if record.get('background'):
        try:
            return (
                arguments[arguments.index('--instance-id') + 1] == record['instance_id']
                and arguments[arguments.index('--library') + 1] == record['library']
                and int(arguments[arguments.index('--port') + 1]) == record['port']
            )
        except (ValueError, IndexError):
            return False
    # A foreground command has no generated token in argv. Its live health
    # response must independently identify the exact PID and instance instead.
    return bool(
        live
        and live.get('pid') == record['pid']
        and live.get('instance_id') == record['instance_id']
    )


def service_status(port=8765, library_dir=None, directory=None):
    info = _health(port)
    record = _read_record(port, library_dir)
    matching = _matches(info, port, library_dir, directory)
    result = {
        'running': matching,
        'service': 'craft-pattern',
        'port': port,
        'library': str(library.library_path(library_dir)),
        'url': f'http://127.0.0.1:{port}/docs/index.html',
        'log': str(_log_path(port, library_dir)),
        'record': str(_record_path(port, library_dir)),
    }
    if matching:
        result.update({key: info[key] for key in ('pid', 'instance_id', 'directory')})
        result['managed'] = bool(
            record and record['pid'] == info['pid'] and record['instance_id'] == info['instance_id']
        )
    else:
        result['reason'] = (
            '指定案例库的服务未运行' if info is None else '此端口运行着其他服务或案例库'
        )
    return result


def start_background(port=8765, directory=None, library_dir=None):
    if not 1 <= port <= 65535:
        raise ValueError('后台服务端口须为 1–65535')
    directory = Path(directory or ROOT).expanduser().resolve()
    if not directory.is_dir():
        raise ValueError('网页目录不存在')
    existing = service_status(port, library_dir, directory)
    if existing['running']:
        existing['reused'] = True
        return existing
    with socket.socket() as probe:
        probe.settimeout(0.25)
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            raise ValueError(f'端口 {port} 已被其他服务占用；未停止或替换该进程。')
    root = library.library_path(library_dir)
    root.mkdir(parents=True, exist_ok=True)
    log = _log_path(port, root)
    instance_id = uuid.uuid4().hex
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        '--port',
        str(port),
        '--directory',
        str(directory),
        '--library',
        str(root),
        '--instance-id',
        instance_id,
    ]
    with log.open('ab', buffering=0) as stream:
        process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        health = _health(port, timeout=min(0.25, max(0.01, deadline - time.monotonic())))
        if _matches(health, port, root, directory):
            result = service_status(port, root, directory)
            result['reused'] = health['instance_id'] != instance_id
            return result
        if process.poll() is not None:
            break
        time.sleep(0.05)
    # The only process we may stop on a failed launch is our own Popen child.
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    raise RuntimeError(f'本地服务启动失败，请查看日志：{log}')


def stop_service(port=8765, library_dir=None):
    record = _read_record(port, library_dir)
    if record is None:
        return {
            'stopped': False,
            'running': service_status(port, library_dir)['running'],
            'reason': '没有可核对的本项目服务记录；未停止任何进程。',
        }
    live = _health(port)
    if live is not None and (
        not _matches(live, port, library_dir)
        or live.get('instance_id') != record['instance_id']
        or live.get('pid') != record['pid']
    ):
        return {
            'stopped': False,
            'running': False,
            'reason': '端口上的进程与服务记录不符；未停止任何进程。',
        }
    if not _process_matches(record, live):
        return {
            'stopped': False,
            'running': _matches(live, port, library_dir),
            'reason': '不能确认 PID 属于此服务；未停止任何进程。',
        }
    try:
        os.kill(record['pid'], signal.SIGTERM)
    except ProcessLookupError:
        _remove_record(port, record['instance_id'], library_dir)
        return {'stopped': True, 'running': False, 'pid': record['pid']}
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        health = _health(port, timeout=0.15)
        if not health or health.get('instance_id') != record['instance_id']:
            _remove_record(port, record['instance_id'], library_dir)
            return {'stopped': True, 'running': False, 'pid': record['pid']}
        time.sleep(0.05)
    return {
        'stopped': False,
        'running': True,
        'pid': record['pid'],
        'reason': '已发送停止请求，服务仍在结束处理中。',
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--directory', default=str(ROOT))
    parser.add_argument('--library')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--background', action='store_true', help='后台启动并等待健康检查')
    mode.add_argument('--status', action='store_true', help='输出本地服务状态 JSON')
    mode.add_argument('--stop', action='store_true', help='停止经核对的本项目服务')
    parser.add_argument('--instance-id', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.instance_id is not None and not re.fullmatch(r'[0-9a-f]{32}', args.instance_id):
        parser.error('服务实例标识无效')
    if not 0 <= args.port <= 65535:
        parser.error('端口须为 0–65535')
    try:
        if args.status or args.stop or args.background:
            if args.status:
                result = service_status(args.port, args.library, args.directory)
            elif args.stop:
                result = stop_service(args.port, args.library)
            else:
                result = start_background(args.port, args.directory, args.library)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        server = create_server(args.port, args.directory, args.library, args.instance_id)
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(2, f'错误：{error}\n')
    info = dict(
        server.service_info,
        started_at=library.now(),
        background=args.instance_id is not None,
        url=f'http://127.0.0.1:{server.server_port}/docs/index.html',
        log=str(_log_path(server.server_port, args.library)),
    )
    _write_record(info, args.library)
    print(f'拼豆编辑器：http://127.0.0.1:{server.server_port}/docs/index.html', flush=True)
    print(f'本地案例库：{library.library_path(args.library)}', flush=True)

    def terminate(signum, frame):
        raise KeyboardInterrupt

    previous_signal = signal.signal(signal.SIGTERM, terminate)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        _remove_record(server.server_port, server.service_info['instance_id'], args.library)
        signal.signal(signal.SIGTERM, previous_signal)


if __name__ == '__main__':
    main()
