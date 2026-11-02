#!/usr/bin/env python3
"""Deterministic photo-to-grid conversion with an explicit material palette."""
import argparse, json, math, re
from pathlib import Path
from PIL import Image, ImageOps
ROOT = Path(__file__).resolve().parents[1]

def validate(config):
    if not isinstance(config, dict): raise ValueError('输入必须为 JSON 对象')
    width, height = config.get('width', 40), config.get('height', 40)
    if type(width) is not int or type(height) is not int or not (4 <= width <= 160 and 4 <= height <= 160):
        raise ValueError('width/height 必须为 4–160 的整数')
    palette = config.get('palette', [])
    if not isinstance(palette, list) or not (2 <= len(palette) <= 36): raise ValueError('palette 需要 2–36 种颜色')
    ids = set()
    for color in palette:
        if not isinstance(color, dict) or not isinstance(color.get('id'),str) or not color['id'] or color['id'] in ids: raise ValueError('色号须非空且唯一')
        ids.add(color['id'])
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', str(color.get('hex', ''))): raise ValueError('颜色格式应为 #RRGGBB')
        stock=color.get('stock')
        if stock is not None and (type(stock) is not int or stock < 0): raise ValueError('stock 应为非负整数或 null')
    mode=config.get('mode','bead')
    if mode not in ('bead','cross-stitch'): raise ValueError('mode 仅支持 bead / cross-stitch')
    if config.get('fit','contain') not in ('contain','cover'): raise ValueError('fit 仅支持 contain / cover')
    return width,height,palette

def srgb(v):
    v=v/255
    return v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4

def nearest(rgb,palette_rgb):
    # Linear-light weighted distance avoids mapping dark details solely by raw RGB.
    a=[srgb(v) for v in rgb]
    return min(range(len(palette_rgb)), key=lambda j:sum(w*(a[i]-srgb(palette_rgb[j][i]))**2 for i,w in enumerate((.2126,.7152,.0722))))

def convert(config,image_path):
    width,height,palette=validate(config)
    with Image.open(image_path) as im:
        if im.width*im.height > 40_000_000: raise ValueError('图片限制为 4000 万像素')
        im=ImageOps.exif_transpose(im).convert('RGBA')
        bg=Image.new('RGBA',im.size,'white'); bg.alpha_composite(im); im=bg.convert('RGB')
        if config.get('fit','contain')=='cover': im=ImageOps.fit(im,(width,height),method=Image.Resampling.LANCZOS)
        else: im=ImageOps.pad(im,(width,height),method=Image.Resampling.LANCZOS,color='white')
        pixels=list(im.getdata())
    colors=[tuple(int(c['hex'][i:i+2],16) for i in (1,3,5)) for c in palette]
    cache={}
    cells=[]
    for rgb in pixels:
        if rgb not in cache: cache[rgb]=nearest(rgb,colors)
        cells.append(cache[rgb])
    return {'version':1,'title':str(config.get('title','手工图纸')),'mode':config.get('mode','bead'),'width':width,'height':height,'palette':palette,'cells':cells,'source':{'name':image_path.name,'fit':config.get('fit','contain')},'notes':['颜色由明确色板映射，屏幕色与实物色可能有差异。','stock 用于缺料统计，不会自动扭曲图案以强制满足库存。']}

def build(config_path,output,image_override=None):
    config_path=Path(config_path); config=json.loads(config_path.read_text('utf-8'))
    image_path=Path(image_override) if image_override else config_path.parent/config.get('image','demo.png')
    data=convert(config,image_path)
    payload=json.dumps(data,ensure_ascii=False).replace('<','\\u003c')
    page=(ROOT/'assets/template.html').read_text('utf-8').replace('__DATA__',payload)
    output=Path(output); output.parent.mkdir(parents=True,exist_ok=True); output.write_text(page,'utf-8')
    output.with_suffix('.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),'utf-8')
    return data

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('input'); p.add_argument('--image'); p.add_argument('--output',required=True)
    args=p.parse_args()
    try:
        result=build(args.input,args.output,args.image)
    except (ValueError,OSError,KeyError,TypeError) as e: p.exit(2,f'错误：{e}\n')
    print(f"已生成 {args.output} · {result['width']}×{result['height']} 格")
