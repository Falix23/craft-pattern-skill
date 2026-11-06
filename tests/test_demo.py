import base64
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_demo', ROOT / 'scripts' / 'build_demo.py')
demo = importlib.util.module_from_spec(spec)
with patch.object(sys, 'path', [str(ROOT / 'scripts'), *sys.path]):
    spec.loader.exec_module(demo)


def page(color='red', compression=6, script='const version = 1;'):
    output = io.BytesIO()
    Image.new('RGBA', (8, 8), color).save(output, 'PNG', compress_level=compression)
    source = base64.b64encode(output.getvalue()).decode('ascii')
    return f'<img id="source-preview" src="data:image/png;base64,{source}"><script>{script}</script>'.encode()


class DemoSyncTests(unittest.TestCase):
    def test_equivalent_png_pixels_can_use_different_compression(self):
        first, second = page(compression=0), page(compression=9)
        self.assertNotEqual(first, second)
        self.assertTrue(demo.same_page(first, second))

    def test_changed_source_pixels_are_stale(self):
        self.assertFalse(demo.same_page(page('red'), page('blue')))

    def test_changed_editor_source_is_stale_even_with_equivalent_images(self):
        self.assertFalse(demo.same_page(page(), page(compression=9, script='const version = 2;')))

    def test_missing_or_invalid_embedded_source_is_not_accepted(self):
        self.assertFalse(demo.same_page(b'<img>', b'<img>'))
        invalid = b'<img src="data:image/png;base64,invalid">'
        self.assertFalse(demo.same_page(invalid, invalid))
