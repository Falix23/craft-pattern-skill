import base64
import importlib.util
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', ROOT / 'scripts/build.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PatternTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            'width': 4,
            'height': 4,
            'palette': [{'id': 'white', 'hex': '#ffffff'}, {'id': 'black', 'hex': '#000000'}],
        }

    def convert(self, image, **options):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'photo.png'
            image.save(path)
            return m.convert(self.config | options, path)

    def test_exact_color_mapping_and_version_two_metrics(self):
        image = Image.new('RGB', (4, 4), 'white')
        image.putpixel((1, 2), (0, 0, 0))
        data = self.convert(image)
        self.assertEqual(data['version'], 2)
        self.assertEqual(data['cells'].count(1), 1)
        self.assertEqual(data['cells'][9], 1)
        self.assertEqual(
            data['metrics'],
            {
                'blank_cells': 0,
                'bead_count': 16,
                'removed_background': 0,
                'cleaned_cells': 0,
            },
        )
        self.assertEqual(
            data['processing'],
            {
                'background': 'transparent',
                'background_tolerance': 32,
                'alpha_threshold': 128,
                'cleanup': 1,
                'color_detail': 'medium',
            },
        )

    def test_color_distinction_configuration_is_preserved_and_rejects_unknown_levels(self):
        image = Image.new('RGB', (4, 4), 'white')
        for level in ('low', 'medium', 'high'):
            self.assertEqual(
                self.convert(image, color_detail=level)['processing']['color_detail'], level
            )
        for level in ('invalid', None, False):
            with self.assertRaises(ValueError):
                self.convert(image, color_detail=level)

    def test_default_preserves_transparency_and_keep_retains_legacy_white(self):
        image = Image.new('RGBA', (4, 4), (0, 0, 0, 0))
        transparent = self.convert(image)
        kept = self.convert(image, background='keep')
        self.assertEqual(transparent['cells'], [None] * 16)
        self.assertEqual(transparent['metrics']['bead_count'], 0)
        self.assertEqual(kept['cells'], [0] * 16)
        self.assertEqual(kept['metrics']['blank_cells'], 0)

    def test_contain_letterboxing_is_empty_unless_background_is_kept(self):
        image = Image.new('RGB', (8, 4), 'black')
        transparent = self.convert(image, cleanup=0)
        kept = self.convert(image, background='keep', cleanup=0)
        self.assertEqual(transparent['cells'], [None] * 4 + [1] * 8 + [None] * 4)
        self.assertEqual(kept['cells'], [0] * 4 + [1] * 8 + [0] * 4)

    def test_alpha_threshold_is_inclusive_and_configurable(self):
        image = Image.new('RGBA', (4, 4), (0, 0, 0, 0))
        image.putpixel((0, 0), (0, 0, 0, 127))
        image.putpixel((1, 0), (0, 0, 0, 128))
        default = self.convert(image, cleanup=0)
        lower = self.convert(image, alpha_threshold=127, cleanup=0)
        self.assertEqual(default['cells'][:2], [None, 1])
        self.assertEqual(lower['cells'][:2], [1, 1])

    def test_auto_removes_outer_background_but_preserves_enclosed_eye(self):
        image = Image.new('RGBA', (7, 7), 'white')
        for y in range(2, 5):
            for x in range(2, 5):
                image.putpixel((x, y), (0, 0, 0, 255))
        image.putpixel((3, 3), (255, 255, 255, 255))
        data = self.convert(image, width=7, height=7, background='auto')
        self.assertEqual(data['cells'][3 * 7 + 3], 0)
        self.assertEqual(data['cells'].count(None), 40)
        self.assertEqual(data['metrics']['removed_background'], 40)
        self.assertEqual(data['metrics']['bead_count'], 9)

    def test_auto_uses_opaque_bounding_box_inside_transparent_padding(self):
        pixels = [(0, 0, 0, 0)] * 25
        for y in range(1, 4):
            for x in range(1, 4):
                pixels[y * 5 + x] = (255, 255, 255, 255)
        pixels[12] = (0, 0, 0, 255)
        result, removed = m.remove_background(pixels, 5, 5)
        self.assertEqual(removed, 8)
        self.assertEqual(result[12], (0, 0, 0, 255))
        self.assertEqual(sum(pixel[3] == 0 for pixel in result), 24)

    def test_auto_skips_multicolored_edges_without_a_dominant_background(self):
        pixels = [(x * 32, y * 32, 0, 255) for y in range(4) for x in range(4)]
        result, removed = m.remove_background(pixels, 4, 4, tolerance=120)
        self.assertEqual(removed, 0)
        self.assertEqual(result, pixels)

    def test_background_tolerance_does_not_remove_unconnected_or_distant_colors(self):
        pixels = [(255, 255, 255, 255)] * 25
        for y in range(1, 4):
            for x in range(1, 4):
                pixels[y * 5 + x] = (0, 0, 0, 255)
        pixels[12] = (255, 255, 255, 255)
        pixels[2] = (230, 230, 230, 255)
        strict, strict_removed = m.remove_background(pixels, 5, 5, tolerance=0)
        relaxed, relaxed_removed = m.remove_background(pixels, 5, 5, tolerance=44)
        self.assertEqual(strict_removed, 15)
        self.assertEqual(relaxed_removed, 16)
        self.assertEqual(strict[2][3], 255)
        self.assertEqual(relaxed[2][3], 0)
        self.assertEqual(relaxed[12][3], 255)

    def test_invalid_palette_dimensions_and_processing_rejected(self):
        patches = (
            {'width': 161},
            {'width': 4.5},
            {'palette': [{'id': 'a', 'hex': 'red'}, {'id': 'a', 'hex': '#fff000'}]},
            {'background': 'magic'},
            {'background_tolerance': -1},
            {'background_tolerance': 121},
            {'background_tolerance': True},
            {'alpha_threshold': 0},
            {'alpha_threshold': 256},
            {'alpha_threshold': 1.5},
            {'cleanup': -1},
            {'cleanup': 5},
            {'cleanup': False},
        )
        for overrides in patches:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                m.validate(self.config | overrides)

    def test_embedded_data_cannot_end_script_and_preserves_literal_title(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            Image.new('RGB', (4, 4), 'white').save(path / 'demo.png')
            title = '</script><img src=x onerror=alert(1)> __STYLE__ __CORE__ __EDITOR__'
            (path / 'input.json').write_text(json.dumps(self.config | {'title': title}))
            m.build(path / 'input.json', path / 'out.html')
            output = (path / 'out.html').read_text()
            self.assertIn('\\u003c/script>', output)
            self.assertNotIn('</script><img', output)
            payload = re.search(
                r'<script id="initial" type="application/json">(.*?)</script>', output, re.S
            )[1]
            self.assertEqual(json.loads(payload)['title'], title)
            self.assertEqual(json.loads((path / 'out.json').read_text())['version'], 2)

    def test_build_inlines_editor_and_a_bounded_transparent_source_preview(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            assets = path / 'assets'
            assets.mkdir()
            (assets / 'template.html').write_text(
                '<style>__STYLE__</style><script>__CORE__\n__EDITOR__</script>'
                '<img src="__SOURCE_IMAGE__">'
                '<script id="initial" type="application/json">__DATA__</script>'
            )
            for name, content in (
                ('editor.css', 'body{}'),
                ('pattern-core.js', 'var core=1;'),
                ('editor.js', 'var editor=2;'),
            ):
                (assets / name).write_text(content)
            Image.new('RGBA', (2048, 512), (100, 20, 40, 0)).save(path / 'demo.png')
            (path / 'input.json').write_text(json.dumps(self.config))
            with patch.object(m, 'ROOT', path):
                m.build(path / 'input.json', path / 'out.html')
            output = (path / 'out.html').read_text()
            self.assertIn('body{}', output)
            self.assertIn('var core=1;\nvar editor=2;', output)
            self.assertNotIn('__SOURCE_IMAGE__', output)
            encoded = re.search(r'data:image/png;base64,([^"<>]+)', output)[1]
            with Image.open(io.BytesIO(base64.b64decode(encoded))) as preview:
                self.assertEqual(preview.size, (1024, 256))
                self.assertEqual(preview.mode, 'RGBA')
                self.assertEqual(preview.getpixel((0, 0))[3], 0)


class CleanupTests(unittest.TestCase):
    colors = [(170, 170, 170), (180, 180, 180), (0, 0, 0), (200, 200, 200)]

    def test_single_similar_speck_is_cleaned_but_dark_eye_is_preserved(self):
        cells = [0] * 49
        cells[16] = 1
        cells[32] = 2
        result, changed = m.cleanup_cells(cells, 7, 7, self.colors, 1)
        self.assertEqual(changed, 1)
        self.assertEqual(result[16], 0)
        self.assertEqual(result[32], 2)
        self.assertEqual(cells[16], 1)

    def test_level_limits_and_off_switch(self):
        cells = [0] * 49
        cells[16] = cells[17] = 1
        off, _ = m.cleanup_cells(cells, 7, 7, self.colors, 0)
        conservative, conservative_count = m.cleanup_cells(cells, 7, 7, self.colors, 1)
        medium, medium_count = m.cleanup_cells(cells, 7, 7, self.colors, 2)
        self.assertEqual(off, cells)
        self.assertEqual(conservative, cells)
        self.assertEqual(conservative_count, 0)
        self.assertEqual(medium_count, 2)
        self.assertEqual(medium, [0] * 49)

    def test_level_three_can_clean_four_cell_island(self):
        cells = [0] * 49
        for index in (16, 17, 23, 24):
            cells[index] = 1
        medium, _ = m.cleanup_cells(cells, 7, 7, self.colors, 2)
        strong, changed = m.cleanup_cells(cells, 7, 7, self.colors, 3)
        self.assertEqual(medium, cells)
        self.assertEqual(changed, 4)
        self.assertEqual(strong, [0] * 49)

    def test_outline_and_empty_neighbor_veto_cleanup(self):
        cells = [0] * 25
        cells[2] = cells[12] = 1
        cells[11] = None
        result, changed = m.cleanup_cells(cells, 5, 5, self.colors, 3)
        self.assertEqual(result, cells)
        self.assertEqual(changed, 0)
        self.assertIsNone(result[11])

    def test_replacement_needs_three_quarters_of_boundary_votes(self):
        cells = [0] * 25
        cells[12] = 1
        cells[7] = 2
        result, _ = m.cleanup_cells(cells, 5, 5, self.colors, 1)
        self.assertEqual(result[12], 0)
        cells[11] = 2
        result, _ = m.cleanup_cells(cells, 5, 5, self.colors, 1)
        self.assertEqual(result[12], 1)

    def test_convert_records_cleanup_count(self):
        image = Image.new('RGB', (5, 5), self.colors[0])
        image.putpixel((2, 2), self.colors[1])
        config = {
            'width': 5,
            'height': 5,
            'palette': [
                {'id': str(i), 'hex': '#%02x%02x%02x' % color}
                for i, color in enumerate(self.colors)
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'image.png'
            image.save(path)
            data = m.convert(config, path)
            self.assertEqual(data['metrics']['cleaned_cells'], 1)
            self.assertEqual(data['cells'], [0] * 25)

    def test_craft_mode_merges_edge_fragments_but_keeps_the_occupancy_mask(self):
        cells = [0] * 49
        for y in range(7):
            cells[y * 7] = None
        cells[15] = cells[22] = 1
        result, changed = m.cleanup_cells(cells, 7, 7, [(180, 142, 123), (148, 124, 112)], 4)
        self.assertEqual(changed, 2)
        self.assertEqual(result[15], 0)
        self.assertEqual([c is None for c in result], [c is None for c in cells])
        self.assertEqual(cells[15], 1)

    def test_craft_mode_keeps_eyes_and_white_accents_but_removes_neutral_flecks(self):
        colors = [(21, 25, 30), (119, 119, 119), (255, 255, 255), (210, 168, 148)]
        shirt = [0] * 49
        shirt[16] = 1
        shirt[32] = 2
        result, _ = m.cleanup_cells(shirt, 7, 7, colors, 4)
        self.assertEqual(result[16], 0)
        self.assertEqual(result[32], 2)
        face = [3] * 49
        face[16] = face[18] = 0
        self.assertEqual(m.cleanup_cells(face, 7, 7, colors, 4)[0], face)

    def test_source_mask_handles_neutral_shadows_without_removing_skin_or_enclosed_white(self):
        pixels = [
            (180 + (x * 7 + y * 3) % 45,) * 2 + (182 + (x * 7 + y * 3) % 45, 255)
            for y in range(24)
            for x in range(32)
        ]
        for y in range(6, 18):
            for x in range(8, 24):
                pixels[y * 32 + x] = (20, 24, 29, 255)
        pixels[10 * 32 + 16] = (240, 240, 240, 255)
        pixels[8 * 32 + 4] = (210, 170, 150, 255)
        result, removed = m.remove_background(pixels, 32, 24, source=True)
        self.assertEqual(removed, 32 * 24 - 12 * 16 - 1)
        self.assertEqual(result[10 * 32 + 16][3], 255)
        self.assertEqual(result[8 * 32 + 4][3], 255)

    def test_craft_mode_is_valid_in_build_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'image.png'
            Image.new('RGB', (24, 24), 'white').save(path)
            data = m.convert(
                {
                    'width': 4,
                    'height': 4,
                    'background': 'auto',
                    'cleanup': 4,
                    'palette': [{'id': 'W', 'hex': '#FFFFFF'}, {'id': 'K', 'hex': '#000000'}],
                },
                path,
            )
            self.assertEqual(data['processing']['cleanup'], 4)
            self.assertEqual(data['metrics']['blank_cells'], 16)

    def test_source_background_is_removed_once_without_erasing_edge_touching_clothes_at_all_presets(
        self,
    ):
        from PIL import ImageDraw

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'dark-shirt.png'
            image = Image.new('RGB', (120, 180), (210, 210, 212))
            draw = ImageDraw.Draw(image)
            draw.rectangle((28, 35, 92, 179), fill=(18, 20, 25))
            draw.rectangle((45, 15, 75, 45), fill=(210, 168, 148))
            image.save(path)
            for edge in (32, 48, 64, 96, 128, 160):
                width = round(edge * 2 / 3)
                with self.subTest(longest_edge=edge):
                    data = m.convert(
                        {
                            'width': width,
                            'height': edge,
                            'background': 'auto',
                            'cleanup': 4,
                            'palette': [
                                {'id': 'BLACK', 'hex': '#121419'},
                                {'id': 'SKIN', 'hex': '#D2A894'},
                            ],
                        },
                        path,
                    )
                    self.assertEqual(data['cells'][(edge * 3 // 4) * width + width // 2], 0)
                    self.assertEqual(data['cells'][(edge - 1) * width + width // 2], 0)
                    self.assertIsNone(data['cells'][(edge // 2) * width])
                    self.assertGreater(data['cells'].count(0), width * edge * 0.3)
                    self.assertEqual(data['processing']['background'], 'auto')
                    self.assertGreater(data['metrics']['removed_background'], 0)

    def test_craft_sampling_keeps_coherent_dark_detail_without_promoting_single_pixel_noise(self):
        pixels = [(210, 168, 148, 255)] * 16
        detail = [(210, 168, 148, 255)] * 144
        detail[0] = (40, 35, 30, 255)
        detail[1] = (60, 45, 35, 255)
        detail[3] = (0, 0, 0, 255)
        sampled = m.sample_craft(pixels, detail, 4, 4)
        self.assertEqual(sampled[0], (50, 40, 33, 255))
        self.assertEqual(sampled[1], pixels[1])
        self.assertEqual(pixels[0], (210, 168, 148, 255))

    def test_perceptual_mapping_and_fill_sampling_preserve_red_with_a_black_outline(self):
        self.assertEqual(m.nearest((181, 45, 32), [(24, 24, 24), (245, 69, 50)]), 1)
        pixels = [(200, 57, 40, 255)] * 16
        pixels[1] = (200, 57, 40, 90)
        detail = [(245, 61, 41, 255)] * 144
        detail[0] = detail[1] = (18, 20, 18, 255)
        sampled = m.sample_craft(pixels, detail, 4, 4)
        self.assertGreater(sampled[0][0], 220)
        self.assertEqual(sampled[1], pixels[1])
        self.assertEqual([p[3] for p in sampled], [p[3] for p in pixels])

    def test_craft_cleanup_preserves_pale_cheeks_and_dark_facial_strokes(self):
        colors = [(255, 255, 255), (242, 189, 188), (53, 34, 34), (188, 88, 101)]
        face = [0] * 49
        face[16] = face[18] = 2
        face[23] = face[25] = 1
        face[31] = face[32] = 3
        self.assertEqual(m.cleanup_cells(face, 7, 7, colors, 4)[0], face)

    def test_pastel_hue_mapping_and_cleanup_keep_yellow_cheeks_distinct_from_tan(self):
        colors = [(216, 173, 147), (235, 194, 144), (244, 202, 203)]
        self.assertEqual(m.nearest((239, 198, 143), colors), 1)
        face = [0] * 49
        face[24] = 1
        self.assertEqual(m.cleanup_cells(face, 7, 7, colors, 4)[0][24], 1)

    def test_classical_features_preserve_two_small_strokes_without_joining_them(self):
        width, height, scale = 6, 4, 6
        detail = [(220, 175, 150, 255)] * (width * height * scale * scale)
        for left in (8, 23):
            for x, y in ((0, 0), (1, 1), (2, 2), (3, 1), (4, 0)):
                detail[(8 + y) * width * scale + left + x] = (65, 30, 22, 255)
        strengths, _, _ = m.extract_craft_features(detail, width, height)
        self.assertGreater(strengths[width + 1], 0)
        self.assertGreater(strengths[width + 4], 0)
        self.assertEqual(strengths[width + 2], 0)
        self.assertEqual(strengths[width + 3], 0)
        self.assertLessEqual(sum(v > 0 for v in strengths), 4)
        base = [(220, 175, 150, 255)] * (width * height)
        sampled = m.sample_craft(base, detail, width, height)
        self.assertLess(sampled[width + 1][0], 180)
        self.assertLess(sampled[width + 4][0], 180)
        self.assertEqual(sampled[width + 2], base[width + 2])
        self.assertEqual(sampled[width + 3], base[width + 3])


if __name__ == '__main__':
    unittest.main()
