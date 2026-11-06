"""Headless output contracts: actual files, counting, transparency and versions."""

import csv
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


class DirectOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / 'source.png'
        image = Image.new('RGBA', (80, 40))
        draw = ImageDraw.Draw(image)
        draw.rectangle((12, 7, 65, 35), fill='#BC9874')
        draw.rectangle((28, 12, 34, 17), fill='#121419')
        draw.rectangle((53, 12, 59, 17), fill='#121419')
        image.save(self.source)
        self.output = self.directory / 'out'
        self.library = self.directory / 'library'

    def run_cli(self, *options, success=True):
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / 'scripts/generate.py'),
                str(self.source),
                '--output',
                str(self.output),
                '--library',
                str(self.library),
                *options,
            ],
            text=True,
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(result.returncode, 0 if success else 2, result.stderr)
        return json.loads(result.stdout if success else result.stderr)

    def plans(self, entries):
        path = self.directory / 'plans.json'
        path.write_text(json.dumps(entries), 'utf-8')
        return str(path)

    def test_single_direct_grid_outputs_are_consistent_and_have_no_editor_dependency(self):
        result = self.run_cli('--longest-edge', '48', '--no-archive')
        self.assertEqual(result['status'], 'completed')
        self.assertNotIn('comparison', result)
        (entry,) = result['plans']
        self.assertEqual((entry['width'], entry['height']), (48, 24))
        pattern = json.loads(Path(entry['files']['json']).read_text())
        self.assertEqual(len(pattern['cells']), 48 * 24)
        self.assertEqual(entry['bead_count'], sum(c is not None for c in pattern['cells']))
        self.assertGreater(entry['blank_cells'], 0)
        for key, path in entry['files'].items():
            self.assertTrue(Path(path).is_absolute())
            self.assertTrue(Path(path).is_file())
        for key in ('preview', 'chart'):
            with Image.open(entry['files'][key]) as picture:
                self.assertEqual(picture.format, 'PNG')
                self.assertGreater(picture.width, 500)
        rows = list(
            csv.reader(io.StringIO(Path(entry['files']['materials']).read_text('utf-8-sig')))
        )
        self.assertEqual(sum(int(row[-1]) for row in rows[1:]), entry['bead_count'])
        self.assertIn('<svg', Path(entry['files']['svg']).read_text())
        self.assertFalse(list(self.output.rglob('*.html')))
        self.assertFalse(self.library.exists())

    def test_comparison_archives_variants_as_recoverable_versions_of_one_case(self):
        result = self.run_cli('--compare', '--title', '小熊挂件', '--tags', '测试,挂件')
        self.assertEqual(
            [(p['width'], p['height']) for p in result['plans']], [(48, 24), (64, 32), (96, 48)]
        )
        self.assertEqual([p['color_detail'] for p in result['plans']], ['low', 'medium', 'high'])
        self.assertEqual(result['recommended_plan'], 2)
        self.assertTrue(Path(result['comparison']).is_file())
        identities = {p['archive']['case_id'] for p in result['plans']}
        self.assertEqual(len(identities), 1)
        self.assertEqual([p['archive']['version'] for p in result['plans']], [1, 2, 3])
        for entry in result['plans']:
            archive = (
                self.library
                / 'cases'
                / entry['archive']['case_id']
                / f'v{entry["archive"]["version"]:06d}'
            )
            self.assertTrue((archive / 'source.png').is_file())
            recovered = json.loads((archive / 'pattern.json').read_text())
            self.assertEqual(
                recovered['cells'], json.loads(Path(entry['files']['json']).read_text())['cells']
            )
            self.assertEqual(recovered['processing']['color_detail'], entry['color_detail'])
        with sqlite3.connect(self.library / 'library.sqlite3') as db:
            self.assertEqual(db.execute('SELECT title FROM cases').fetchall(), [('小熊挂件',)])

    def test_explicit_palette_and_requested_rectangle_are_preserved(self):
        palette = [
            {'id': 'near-black-1', 'hex': '#121419'},
            {'id': 'near-black-2', 'hex': '#2B2625'},
        ]
        path = self.directory / 'palette.json'
        path.write_text(json.dumps(palette), 'utf-8')
        result = self.run_cli(
            '--width',
            '32',
            '--height',
            '32',
            '--palette',
            str(path),
            '--background',
            'keep',
            '--no-archive',
        )
        (entry,) = result['plans']
        pattern = json.loads(Path(entry['files']['json']).read_text())
        self.assertEqual(pattern['palette'], palette)
        self.assertEqual((entry['width'], entry['height']), (32, 32))
        self.assertEqual(entry['blank_cells'], 0)
        self.assertEqual(entry['bead_count'], 1024)

    def test_low_and_high_color_detail_apply_without_changing_requested_grid(self):
        image = Image.new('RGBA', (48, 24))
        ImageDraw.Draw(image).rectangle((4, 4, 23, 19), fill='#121419')
        ImageDraw.Draw(image).rectangle((24, 4, 43, 19), fill='#2B2625')
        image.save(self.source)
        result = self.run_cli(
            '--plans',
            self.plans(
                [
                    {'width': 48, 'height': 24, 'color_detail': 'low', 'cleanup': 0},
                    {'width': 48, 'height': 24, 'color_detail': 'high', 'cleanup': 0},
                ]
            ),
            '--no-archive',
        )
        self.assertEqual([p['color_count'] for p in result['plans']], [1, 2])
        self.assertEqual([p['bead_count'] for p in result['plans']], [640, 640])

    def test_source_mask_is_not_reapplied_to_dark_subject_at_high_resolutions(self):
        image = Image.new('RGBA', (160, 160), 'white')
        ImageDraw.Draw(image).rectangle((50, 45, 109, 159), fill='#121419')
        image.save(self.source)
        result = self.run_cli(
            '--plans', self.plans([{'longest_edge': 128}, {'longest_edge': 160}]), '--no-archive'
        )
        for entry in result['plans']:
            pattern = json.loads(Path(entry['files']['json']).read_text())
            self.assertGreater(entry['bead_count'], entry['width'] ** 2 * 0.23)
            self.assertGreater(
                sum(c is not None for c in pattern['cells'][-entry['width'] :]),
                entry['width'] * 0.3,
            )
            self.assertEqual(pattern['processing']['background'], 'auto')
            self.assertGreater(pattern['metrics']['removed_background'], 0)

    def test_low_resolution_tower_keeps_three_red_features_and_blue_fill(self):
        self.source = ROOT / 'examples/showcase/inputs/tower.webp'
        result = self.run_cli('--longest-edge', '32', '--max-colors', '8', '--no-archive')
        entry = result['plans'][0]
        pattern = json.loads(Path(entry['files']['json']).read_text())
        w, h = pattern['width'], pattern['height']
        rgb = [bytes.fromhex(c['hex'][1:]) for c in pattern['palette']]
        reds = []
        for low, high in ((0.15, 0.23), (0.29, 0.40), (0.69, 0.80)):
            reds.append(
                sum(
                    r > 130 and r > g * 1.8 and r > b * 1.6
                    for i, color in enumerate(pattern['cells'])
                    if color is not None and low <= (i // w + 0.5) / h < high
                    for r, g, b in [rgb[color]]
                )
            )
        self.assertTrue(all(n >= minimum for n, minimum in zip(reds, (1, 7, 8))), reds)
        blue = sum(
            b > r * 1.2 and b > 80
            for color in pattern['cells']
            if color is not None
            for r, g, b in [rgb[color]]
        )
        self.assertGreaterEqual(blue, 30)
        self.assertEqual((w, h), (14, 32))
        self.assertEqual(entry['bead_count'], 124)
        self.assertLessEqual(entry['color_count'], 8)

    def test_invalid_plans_are_rejected_before_output_or_library_creation(self):
        for entries in (
            [{'width': 161}],
            [{'longest_edge': 64, 'width': 32}],
            [{'width': True}],
            [{'color_detail': 'unknown'}],
            [{'typo': 64}],
            [],
        ):
            with self.subTest(entries=entries):
                self.run_cli('--plans', self.plans(entries), success=False)
                self.assertFalse(self.output.exists())
                self.assertFalse(self.library.exists())

    def test_empty_pattern_is_flagged_and_archive_failure_keeps_outputs(self):
        Image.new('RGBA', (8, 8)).save(self.source)
        result = self.run_cli('--case-id', 'f' * 32)
        self.assertEqual(result['status'], 'completed_with_warnings')
        (entry,) = result['plans']
        self.assertEqual(entry['bead_count'], 0)
        self.assertIsNone(entry['archive'])
        self.assertGreaterEqual(len(entry['warnings']), 2)
        self.assertTrue(Path(entry['files']['chart']).is_file())
        self.assertTrue(Path(result['manifest']).is_file())

    def test_existing_pattern_can_be_rendered_without_source_or_browser_and_not_overwritten(self):
        result = self.run_cli('--no-archive')
        self.source.unlink()
        target = self.directory / 'recovered.png'
        args = [
            sys.executable,
            str(ROOT / 'scripts/render.py'),
            result['plans'][0]['files']['json'],
            '--output',
            str(target),
        ]
        first = subprocess.run(args, text=True, capture_output=True, timeout=30)
        self.assertEqual(first.returncode, 0, first.stderr)
        original = target.read_bytes()
        second = subprocess.run(args, text=True, capture_output=True, timeout=30)
        self.assertEqual(second.returncode, 2)
        self.assertEqual(target.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
