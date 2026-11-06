#!/usr/bin/env python3
"""Private, local pattern archive: SQLite metadata and immutable version files."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PATTERN_BYTES = 5_000_000
MAX_BACKUP_BYTES = 128 * 1024 * 1024
STATUSES = ('draft', 'final', 'made')
CASE_ID = re.compile(r'^[0-9a-f]{32}$')
UNSET = object()


def library_path(library_dir=None):
    return (
        Path(
            library_dir
            or os.environ.get('CRAFT_PATTERN_LIBRARY')
            or Path.home() / '.craft-pattern' / 'library'
        )
        .expanduser()
        .resolve()
    )


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def _text(value, maximum, name, empty=True):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValueError(f'{name} 格式或长度无效')
    return value.strip()


def normalize_pattern(pattern):
    if (
        not isinstance(pattern, dict)
        or type(pattern.get('version')) is not int
        or pattern['version'] not in (1, 2)
    ):
        raise ValueError('不支持的图纸版本')
    width, height = pattern.get('width'), pattern.get('height')
    if any(type(value) is not int or not 4 <= value <= 160 for value in (width, height)):
        raise ValueError('图纸宽高须为 4–160 的整数')
    source_palette = pattern.get('palette')
    if not isinstance(source_palette, list) or not 2 <= len(source_palette) <= 36:
        raise ValueError('色板需要 2–36 色')
    palette, ids = [], set()
    for color in source_palette:
        if not isinstance(color, dict):
            raise ValueError('色板格式无效')
        name = _text(color.get('id'), 120, '色号', False)
        value = color.get('hex')
        if name in ids or not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
            raise ValueError('色板色号或颜色无效')
        ids.add(name)
        palette.append({'id': name, 'hex': value.upper()})
    cells = pattern.get('cells')
    if not isinstance(cells, list) or len(cells) != width * height:
        raise ValueError('图纸格子数量无效')
    for value in cells:
        if value is None and pattern['version'] == 2:
            continue
        if type(value) is not int or not 0 <= value < len(palette):
            raise ValueError('格子色号无效')
    mode = pattern.get('mode', 'bead')
    if mode not in ('bead', 'cross-stitch'):
        raise ValueError('图纸模式无效')
    result = {
        'version': 2,
        'title': _text(pattern.get('title', '我的拼豆图纸'), 300, '图纸标题'),
        'mode': mode,
        'width': width,
        'height': height,
        'palette': palette,
        'cells': list(cells),
    }
    source = pattern.get('source')
    if isinstance(source, dict):
        result['source'] = {}
        if isinstance(source.get('name'), str):
            result['source']['name'] = _text(source['name'], 500, '原图文件名')
        if source.get('fit') in ('contain', 'cover'):
            result['source']['fit'] = source['fit']
    if 'processing' in pattern:
        options = pattern['processing']
        if not isinstance(options, dict):
            raise ValueError('处理参数无效')
        options = {
            key: options.get(key, default)
            for key, default in (
                ('background', 'transparent'),
                ('background_tolerance', 32),
                ('alpha_threshold', 128),
                ('cleanup', 1),
                ('color_detail', 'medium'),
            )
        }
        if options['background'] not in ('keep', 'transparent', 'auto'):
            raise ValueError('背景模式无效')
        if options['color_detail'] not in ('low', 'medium', 'high'):
            raise ValueError('颜色区分度无效')
        for key, low, high in (
            ('background_tolerance', 0, 120),
            ('alpha_threshold', 1, 255),
            ('cleanup', 0, 4),
        ):
            if type(options[key]) is not int or not low <= options[key] <= high:
                raise ValueError('处理参数无效')
        result['processing'] = options
    blank = cells.count(None)
    result['metrics'] = {
        'blank_cells': blank,
        'bead_count': len(cells) - blank,
        'removed_background': 0,
        'cleaned_cells': 0,
    }
    if isinstance(pattern.get('metrics'), dict):
        for key in ('removed_background', 'cleaned_cells'):
            value = pattern['metrics'].get(key)
            if type(value) is int and 0 <= value <= len(cells):
                result['metrics'][key] = value
    if isinstance(pattern.get('notes'), list):
        result['notes'] = [note[:1000] for note in pattern['notes'][:50] if isinstance(note, str)]
    if len(_json(result).encode('utf-8')) > MAX_PATTERN_BYTES:
        raise ValueError('图纸 JSON 不能超过 5 MB')
    return result


def normalize_metadata(metadata=None, defaults=None):
    if metadata is not None and not isinstance(metadata, dict):
        raise ValueError('案例信息须为对象')
    value = dict(defaults or {})
    value.update(metadata or {})
    title = _text(value.get('title', '我的拼豆图纸'), 300, '案例名称', False)
    description = _text(value.get('description', ''), 5000, '案例描述')
    tags = value.get('tags', [])
    if not isinstance(tags, list) or len(tags) > 20:
        raise ValueError('标签须为最多 20 项的数组')
    tags = list(dict.fromkeys(_text(tag, 50, '标签', False) for tag in tags))
    status = value.get('status', 'draft')
    if status not in STATUSES:
        raise ValueError('制作状态无效')
    return {'title': title, 'description': description, 'tags': tags, 'status': status}


@contextmanager
def database(library_dir=None):
    root = library_path(library_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / 'cases').mkdir(exist_ok=True)
    connection = sqlite3.connect(str(root / 'library.sqlite3'), timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys=ON')
    connection.execute('PRAGMA journal_mode=WAL')
    connection.executescript("""
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, tags_json TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, color_count INTEGER NOT NULL,
        bead_count INTEGER NOT NULL, blank_cells INTEGER NOT NULL,
        current_version INTEGER NOT NULL, fingerprint TEXT NOT NULL, source_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        case_id TEXT NOT NULL REFERENCES cases(id), version INTEGER NOT NULL,
        created_at TEXT NOT NULL, fingerprint TEXT NOT NULL,
        pattern_path TEXT NOT NULL, source_path TEXT, preview_path TEXT NOT NULL,
        PRIMARY KEY(case_id, version)
      );
      CREATE INDEX IF NOT EXISTS cases_specs ON cases(width, height, color_count, bead_count);
      CREATE INDEX IF NOT EXISTS cases_fingerprint ON cases(fingerprint);
      CREATE INDEX IF NOT EXISTS cases_updated ON cases(updated_at DESC);
    """)
    try:
        yield connection, root
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _case_id(value):
    if not isinstance(value, str) or not CASE_ID.fullmatch(value):
        raise ValueError('案例 ID 无效')
    return value


def _version(value):
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ValueError('版本号无效') from None
    if isinstance(value, bool) or result < 1:
        raise ValueError('版本号无效')
    return result


def _asset_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise FileNotFoundError('案例文件不存在')
    return path


def _summary(row, selected_version=None):
    value = {
        key: row[key]
        for key in (
            'id',
            'title',
            'description',
            'status',
            'width',
            'height',
            'color_count',
            'bead_count',
            'blank_cells',
            'created_at',
            'updated_at',
            'source_name',
        )
    }
    value['tags'] = json.loads(row['tags_json'])
    value['version_count'] = row['current_version']
    value['version'] = selected_version or row['current_version']
    value['preview_url'] = f'/api/library/cases/{row["id"]}/preview?version={value["version"]}'
    return value


def _decode_image(data):
    if data is None:
        return None
    if not isinstance(data, str) or len(data) > (MAX_IMAGE_BYTES * 4 // 3 + 100):
        raise ValueError('单张案例图片不能超过 10 MB')
    match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)', data)
    if not match:
        raise ValueError('案例图片须为 PNG、JPEG 或 WebP data URL')
    try:
        raw = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('图片编码无效') from None
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError('单张案例图片不能超过 10 MB')
    return _canonical_image(raw)


def _canonical_image(raw):
    from PIL import Image, ImageOps

    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError('图片不能超过 4000 万像素')
            image = ImageOps.exif_transpose(image).convert('RGBA')
            image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, 'PNG')
            return buffer.getvalue()
    except (OSError, Image.DecompressionBombError):
        raise ValueError('案例图片无法解码') from None


def _preview(pattern):
    from PIL import Image, ImageDraw

    scale = min(12, max(2, 480 // max(pattern['width'], pattern['height'])))
    image = Image.new('RGBA', (pattern['width'] * scale, pattern['height'] * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for index, color in enumerate(pattern['cells']):
        if color is not None:
            x, y = (index % pattern['width']) * scale, (index // pattern['width']) * scale
            draw.rectangle(
                (x, y, x + scale - 1, y + scale - 1), fill=pattern['palette'][color]['hex']
            )
    stream = io.BytesIO()
    image.save(stream, 'PNG')
    return stream.getvalue()


def _fingerprint(pattern, source):
    content = {
        key: pattern.get(key)
        for key in ('mode', 'width', 'height', 'palette', 'cells', 'processing')
    }
    return hashlib.sha256(_json(content).encode('utf-8') + (source or b'')).hexdigest()


def save_case(
    pattern,
    source_path=None,
    metadata=None,
    case_id=None,
    library_dir=None,
    source_data=UNSET,
    preview_data=None,
):
    pattern = normalize_pattern(pattern)
    if source_path is not None and source_data is not UNSET:
        raise ValueError('原图路径与 data URL 不能同时提供')
    if source_path is not None:
        path = Path(source_path)
        if path.stat().st_size > 40 * 1024 * 1024:
            raise ValueError('原图文件不能超过 40 MB')
        source = _canonical_image(path.read_bytes())
    else:
        source = _decode_image(source_data) if source_data is not UNSET else None
    preview = _decode_image(preview_data) if preview_data is not None else _preview(pattern)
    directory = None
    with database(library_dir) as (connection, root):
        connection.execute('BEGIN IMMEDIATE')
        existing = None
        if case_id is not None:
            _case_id(case_id)
            existing = connection.execute('SELECT * FROM cases WHERE id=?', (case_id,)).fetchone()
            if existing is None:
                raise FileNotFoundError('案例不存在')
            if source is None and source_path is None and source_data is UNSET:
                row = connection.execute(
                    'SELECT source_path FROM versions WHERE case_id=? AND version=?',
                    (case_id, existing['current_version']),
                ).fetchone()
                if row['source_path']:
                    source = _asset_path(root, row['source_path']).read_bytes()
        fingerprint = _fingerprint(pattern, source)
        if existing is None:
            existing = connection.execute(
                'SELECT * FROM cases WHERE fingerprint=? ORDER BY updated_at DESC LIMIT 1',
                (fingerprint,),
            ).fetchone()
        defaults = {'title': pattern.get('title') or '我的拼豆图纸'}
        if existing is not None:
            defaults = {
                'title': existing['title'],
                'description': existing['description'],
                'tags': json.loads(existing['tags_json']),
                'status': existing['status'],
            }
        meta = normalize_metadata(metadata, defaults)
        timestamp = now()
        created = existing is None
        if not created and fingerprint == existing['fingerprint']:
            connection.execute(
                'UPDATE cases SET title=?,tags_json=?,description=?,status=?,updated_at=? WHERE id=?',
                (
                    meta['title'],
                    _json(meta['tags']),
                    meta['description'],
                    meta['status'],
                    timestamp,
                    existing['id'],
                ),
            )
            row = connection.execute('SELECT * FROM cases WHERE id=?', (existing['id'],)).fetchone()
            return {'case': _summary(row), 'created': False, 'version_added': False}
        identity = uuid.uuid4().hex if created else existing['id']
        version = 1 if created else existing['current_version'] + 1
        relative = Path('cases') / identity / f'v{version:06d}'
        directory = root / relative
        directory.mkdir(parents=True, exist_ok=False)
        try:
            (directory / 'pattern.json').write_text(_json(pattern) + '\n', encoding='utf-8')
            (directory / 'preview.png').write_bytes(preview)
            if source is not None:
                (directory / 'source.png').write_bytes(source)
            stats = pattern['metrics']
            color_count = len(set(value for value in pattern['cells'] if value is not None))
            source_name = pattern.get('source', {}).get('name', '')
            values = (
                meta['title'],
                _json(meta['tags']),
                meta['description'],
                meta['status'],
                timestamp,
                pattern['width'],
                pattern['height'],
                color_count,
                stats['bead_count'],
                stats['blank_cells'],
                version,
                fingerprint,
                source_name,
            )
            if created:
                connection.execute(
                    """INSERT INTO cases (id,title,tags_json,description,status,updated_at,width,height,
                    color_count,bead_count,blank_cells,current_version,fingerprint,source_name,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (identity,) + values + (timestamp,),
                )
            else:
                connection.execute(
                    """UPDATE cases SET title=?,tags_json=?,description=?,status=?,updated_at=?,width=?,height=?,
                    color_count=?,bead_count=?,blank_cells=?,current_version=?,fingerprint=?,source_name=? WHERE id=?""",
                    values + (identity,),
                )
            connection.execute(
                'INSERT INTO versions VALUES (?,?,?,?,?,?,?)',
                (
                    identity,
                    version,
                    timestamp,
                    fingerprint,
                    str(relative / 'pattern.json'),
                    str(relative / 'source.png') if source is not None else None,
                    str(relative / 'preview.png'),
                ),
            )
            row = connection.execute('SELECT * FROM cases WHERE id=?', (identity,)).fetchone()
            return {'case': _summary(row), 'created': created, 'version_added': True}
        except Exception:
            shutil.rmtree(directory)
            raise


def library_info(library_dir=None):
    with database(library_dir) as (connection, root):
        return {
            'backend': 'sqlite',
            'path': str(root),
            'case_count': connection.execute('SELECT COUNT(*) FROM cases').fetchone()[0],
        }


def _limit(value, low, high, name):
    if isinstance(value, bool):
        raise ValueError(f'{name} 无效')
    try:
        integer = int(value)
    except (ValueError, TypeError):
        raise ValueError(f'{name} 无效') from None
    if str(integer) != str(value) or not low <= integer <= high:
        raise ValueError(f'{name} 无效')
    return integer


def search_cases(
    q='',
    library_dir=None,
    max_width=None,
    max_height=None,
    max_colors=None,
    max_beads=None,
    status=None,
    limit=24,
    offset=0,
):
    q = _text(q, 500, '搜索内容')
    clauses, values = [], []
    for term in q.split():
        escaped = term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        clauses.append(
            "(title LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR source_name LIKE ? ESCAPE '\\')"
        )
        values.extend(['%' + escaped + '%'] * 4)
    for key, value, high in [
        ('width', max_width, 160),
        ('height', max_height, 160),
        ('color_count', max_colors, 36),
        ('bead_count', max_beads, 25600),
    ]:
        if value not in (None, ''):
            clauses.append(key + '<=?')
            values.append(_limit(value, 0, high, key))
    if status not in (None, ''):
        if status not in STATUSES:
            raise ValueError('制作状态无效')
        clauses.append('status=?')
        values.append(status)
    limit, offset = _limit(limit, 1, 100, '每页数量'), _limit(offset, 0, 1_000_000, '偏移量')
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    with database(library_dir) as (connection, root):
        total = connection.execute('SELECT COUNT(*) FROM cases' + where, values).fetchone()[0]
        rows = connection.execute(
            'SELECT * FROM cases' + where + ' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?',
            values + [limit, offset],
        ).fetchall()
        return {'items': [_summary(row) for row in rows], 'total': total}


def get_case(case_id, version=None, library_dir=None):
    _case_id(case_id)
    with database(library_dir) as (connection, root):
        row = connection.execute('SELECT * FROM cases WHERE id=?', (case_id,)).fetchone()
        if row is None:
            raise FileNotFoundError('案例不存在')
        version = row['current_version'] if version is None else _version(version)
        item = connection.execute(
            'SELECT * FROM versions WHERE case_id=? AND version=?', (case_id, version)
        ).fetchone()
        if item is None:
            raise FileNotFoundError('版本不存在')
        history = connection.execute(
            'SELECT version,created_at FROM versions WHERE case_id=? ORDER BY version DESC',
            (case_id,),
        ).fetchall()
        return {
            'case': _summary(row, version),
            'pattern': json.loads(
                _asset_path(root, item['pattern_path']).read_text(encoding='utf-8')
            ),
            'source_url': f'/api/library/cases/{case_id}/source?version={version}'
            if item['source_path']
            else None,
            'preview_url': f'/api/library/cases/{case_id}/preview?version={version}',
            'versions': [dict(item) for item in history],
        }


def case_asset(case_id, kind, version=None, library_dir=None):
    _case_id(case_id)
    if kind not in ('source', 'preview'):
        raise ValueError('资源类型无效')
    with database(library_dir) as (connection, root):
        current = connection.execute(
            'SELECT current_version FROM cases WHERE id=?', (case_id,)
        ).fetchone()
        if current is None:
            raise FileNotFoundError('案例不存在')
        version = current['current_version'] if version is None else _version(version)
        row = connection.execute(
            f'SELECT {kind}_path AS path FROM versions WHERE case_id=? AND version=?',
            (case_id, version),
        ).fetchone()
        if row is None or row['path'] is None:
            raise FileNotFoundError('此案例没有原图')
        return _asset_path(root, row['path'])


def update_case(case_id, metadata, library_dir=None):
    _case_id(case_id)
    with database(library_dir) as (connection, root):
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT * FROM cases WHERE id=?', (case_id,)).fetchone()
        if row is None:
            raise FileNotFoundError('案例不存在')
        defaults = {
            'title': row['title'],
            'description': row['description'],
            'tags': json.loads(row['tags_json']),
            'status': row['status'],
        }
        meta = normalize_metadata(metadata, defaults)
        connection.execute(
            'UPDATE cases SET title=?,tags_json=?,description=?,status=?,updated_at=? WHERE id=?',
            (
                meta['title'],
                _json(meta['tags']),
                meta['description'],
                meta['status'],
                now(),
                case_id,
            ),
        )
        return {
            'case': _summary(
                connection.execute('SELECT * FROM cases WHERE id=?', (case_id,)).fetchone()
            )
        }


def _data_url(path):
    return 'data:image/png;base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 60:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds')
    except ValueError:
        return None


def backup_library(library_dir=None):
    result = {'format': 'craft-pattern-library', 'version': 1, 'created_at': now(), 'cases': []}
    with database(library_dir) as (connection, root):
        for row in connection.execute('SELECT * FROM cases ORDER BY created_at,id').fetchall():
            item = _summary(row)
            item.pop('preview_url', None)
            item['versions'] = []
            for version in connection.execute(
                'SELECT * FROM versions WHERE case_id=? ORDER BY version', (row['id'],)
            ).fetchall():
                item['versions'].append(
                    {
                        'version': version['version'],
                        'created_at': version['created_at'],
                        'pattern': json.loads(
                            _asset_path(root, version['pattern_path']).read_text(encoding='utf-8')
                        ),
                        'source_data': _data_url(_asset_path(root, version['source_path']))
                        if version['source_path']
                        else None,
                        'preview_data': _data_url(_asset_path(root, version['preview_path'])),
                    }
                )
            result['cases'].append(item)
    return result


def import_library(backup, library_dir=None):
    if (
        not isinstance(backup, dict)
        or backup.get('format') != 'craft-pattern-library'
        or backup.get('version') != 1
        or not isinstance(backup.get('cases'), list)
    ):
        raise ValueError('不是支持的案例库备份')
    if len(backup['cases']) > 10000 or len(_json(backup).encode('utf-8')) > MAX_BACKUP_BYTES:
        raise ValueError('备份过大')
    # Validate the entire document before the first durable write.
    entries = []
    for case in backup['cases']:
        if (
            not isinstance(case, dict)
            or not isinstance(case.get('versions'), list)
            or not 1 <= len(case['versions']) <= 1000
        ):
            raise ValueError('备份案例或版本格式无效')
        meta = normalize_metadata(
            {key: case[key] for key in ('title', 'tags', 'description', 'status') if key in case}
        )
        versions = []
        for version in case['versions']:
            if not isinstance(version, dict):
                raise ValueError('备份版本格式无效')
            pattern = normalize_pattern(version.get('pattern'))
            source = _decode_image(version.get('source_data'))
            preview = _decode_image(version.get('preview_data'))
            versions.append((pattern, source, preview, _timestamp(version.get('created_at'))))
        entries.append(
            (meta, versions, _timestamp(case.get('created_at')), _timestamp(case.get('updated_at')))
        )
    imported, reused, versions_added = 0, 0, 0
    for meta, versions, created_at, updated_at in entries:
        target_id = None
        new_case = False
        for index, (pattern, source, preview, version_created) in enumerate(versions):
            source_data = (
                'data:image/png;base64,' + base64.b64encode(source).decode('ascii')
                if source
                else None
            )
            preview_data = (
                'data:image/png;base64,' + base64.b64encode(preview).decode('ascii')
                if preview
                else None
            )
            # Exact historical versions already present in any case are reused.
            fingerprint = _fingerprint(pattern, source)
            with database(library_dir) as (connection, root):
                if target_id:
                    matching = connection.execute(
                        'SELECT case_id FROM versions WHERE case_id=? AND fingerprint=? LIMIT 1',
                        (target_id, fingerprint),
                    ).fetchone()
                else:
                    matching = connection.execute(
                        'SELECT case_id FROM versions WHERE fingerprint=? ORDER BY version DESC LIMIT 1',
                        (fingerprint,),
                    ).fetchone()
            if matching:
                target_id = matching['case_id']
                if index == 0:
                    reused += 1
                continue
            result = save_case(
                pattern,
                metadata=meta if target_id is None or new_case else None,
                case_id=target_id,
                library_dir=library_dir,
                source_data=source_data,
                preview_data=preview_data,
            )
            target_id = result['case']['id']
            new_case = new_case or result['created']
            imported += int(result['created'])
            versions_added += int(result['version_added'])
            if result['version_added'] and version_created:
                with database(library_dir) as (connection, root):
                    connection.execute(
                        'UPDATE versions SET created_at=? WHERE case_id=? AND version=?',
                        (version_created, target_id, result['case']['version']),
                    )
        if target_id and new_case:
            with database(library_dir) as (connection, root):
                if created_at:
                    connection.execute(
                        'UPDATE cases SET created_at=? WHERE id=?', (created_at, target_id)
                    )
                if updated_at:
                    connection.execute(
                        'UPDATE cases SET updated_at=? WHERE id=?', (updated_at, target_id)
                    )
    return {
        'imported': imported,
        'reused': reused,
        'skipped': reused,
        'versions_added': versions_added,
        'case_count': library_info(library_dir)['case_count'],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', help='本地案例库目录')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('init')
    add = commands.add_parser('add')
    add.add_argument('pattern')
    add.add_argument('--source')
    add.add_argument('--title')
    add.add_argument('--tags')
    add.add_argument('--description')
    add.add_argument('--status', choices=STATUSES)
    add.add_argument('--case-id')
    search = commands.add_parser('search')
    search.add_argument('query', nargs='?', default='')
    for flag in ('max-width', 'max-height', 'max-colors', 'max-beads'):
        search.add_argument('--' + flag, type=int)
    search.add_argument('--status', choices=STATUSES)
    search.add_argument('--limit', type=int, default=24)
    get = commands.add_parser('get')
    get.add_argument('id')
    get.add_argument('--version', type=int)
    backup = commands.add_parser('backup')
    backup.add_argument('output')
    restore = commands.add_parser('import')
    restore.add_argument('file')
    args = parser.parse_args(argv)
    try:
        if args.command == 'init':
            result = library_info(args.library)
        elif args.command == 'add':
            meta = {
                key: getattr(args, key)
                for key in ('title', 'description', 'status')
                if getattr(args, key) is not None
            }
            if args.tags is not None:
                meta['tags'] = [
                    tag.strip() for tag in args.tags.replace('，', ',').split(',') if tag.strip()
                ]
            pattern_path = Path(args.pattern)
            if pattern_path.stat().st_size > MAX_PATTERN_BYTES:
                raise ValueError('图纸 JSON 不能超过 5 MB')
            result = save_case(
                json.loads(pattern_path.read_text(encoding='utf-8')),
                source_path=args.source,
                metadata=meta,
                case_id=args.case_id,
                library_dir=args.library,
            )
        elif args.command == 'search':
            result = search_cases(
                args.query,
                library_dir=args.library,
                **{
                    key: getattr(args, key)
                    for key in (
                        'max_width',
                        'max_height',
                        'max_colors',
                        'max_beads',
                        'status',
                        'limit',
                    )
                },
            )
        elif args.command == 'get':
            result = get_case(args.id, args.version, args.library)
        elif args.command == 'backup':
            path = Path(args.output)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(backup_library(args.library), ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            result = {'output': str(path.resolve())}
        else:
            path = Path(args.file)
            if path.stat().st_size > MAX_BACKUP_BYTES:
                raise ValueError('备份不能超过 128 MB')
            result = import_library(json.loads(path.read_text(encoding='utf-8')), args.library)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.exit(2, f'错误：{error}\n')


if __name__ == '__main__':
    main()
