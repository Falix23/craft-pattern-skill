import importlib.util,json,tempfile,unittest
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('build',ROOT/'scripts/build.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PatternTests(unittest.TestCase):
    def setUp(self):self.config={'width':4,'height':4,'palette':[{'id':'white','hex':'#ffffff'},{'id':'black','hex':'#000000'}]}
    def test_exact_color_mapping_and_counts(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'photo.png';im=Image.new('RGB',(4,4),'white');im.putpixel((1,2),(0,0,0));im.save(p)
            d=m.convert(self.config,p);self.assertEqual(d['cells'].count(1),1);self.assertEqual(d['cells'][9],1);self.assertEqual(len(d['cells']),16)
    def test_transparency_composites_white(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'photo.png';Image.new('RGBA',(4,4),(0,0,0,0)).save(p)
            self.assertEqual(m.convert(self.config,p)['cells'],[0]*16)
    def test_invalid_palette_or_dimensions_rejected(self):
        for patch in ({'width':161},{'width':4.5},{'palette':[{'id':'a','hex':'red'},{'id':'a','hex':'#fff000'}]}):
            with self.subTest(patch=patch),self.assertRaises(ValueError):m.validate(self.config|patch)
    def test_embedded_data_cannot_end_script(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);Image.new('RGB',(4,4),'white').save(p/'demo.png');(p/'input.json').write_text(json.dumps(self.config|{'title':'</script><img src=x onerror=alert(1)>'}))
            m.build(p/'input.json',p/'out.html');out=(p/'out.html').read_text();self.assertIn('\\u003c/script>',out);self.assertNotIn('</script><img',out)
if __name__=='__main__':unittest.main()
