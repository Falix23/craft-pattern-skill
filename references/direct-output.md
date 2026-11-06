# 直接出图与多方案

适用于用户只上传图片要结果，或要求 agent 比较不同尺寸、配色简化程度。不用启动网页或服务；编辑器是后续可选入口。

## 调用

使用已安装 Pillow 的 Python（依赖在 skill 的 `requirements.txt`），并确保 PATH 有 Node.js 18+。脚本用 Pillow 解码与等比缩放，再调用页面同一份 PatternCore 自动提色、清理和导出；没有模型 API 或联网依赖。

```sh
python <skill>/scripts/generate.py /用户目录/photo.png --longest-edge 64 --color-detail medium
python <skill>/scripts/generate.py /用户目录/photo.png --compare --background auto
python <skill>/scripts/generate.py /用户目录/photo.png --plans /用户目录/plans.json --title "我的挂件"
```

默认单方案最长边 64、中区分度、最多 8 色、清理 4（拼豆优先）、完整保留、拼豆模式。只给最大边或一条边时按 EXIF 校正后的原图比例计算另一边；最短边至少 4 格，完整保留留边而不拉伸。显式宽高各 4–160。无透明区域默认 `auto`；已有透明区域默认 `transparent`。这只是起点：查看原图后可显式 `--background auto` 去除外围白边，或 `keep` 保留底色。去底不适合所有照片，不能把主体同色背景误删后直接交付。

`--compare` 是三个起始方案：48/低/最多 8 色、64/中/最多 8 色、96/高/最多 12 色；其余处理参数由命令行继承。它同时改变尺寸和区分度，适合选制作难度；若用户要单独比较某个参数，用 `--plans` 固定其余参数。命令行 `--width/--height/--longest-edge` 仅用于单方案，不与 `--compare/--plans` 混用。

自定义 `plans.json` 为含 1–12 项的数组，例如固定尺寸比较区分度：

```json
[
  {"name":"少色易拼", "longest_edge":64, "color_detail":"low", "max_colors":8},
  {"name":"平衡层次", "longest_edge":64, "color_detail":"medium", "max_colors":8},
  {"name":"保留色差", "longest_edge":64, "color_detail":"high", "max_colors":8}
]
```

每项可覆盖 `name`、`longest_edge` 或 `width/height`、`color_detail`、`max_colors`、`background`、`background_tolerance`、`alpha_threshold`、`cleanup`、`fit`。未覆盖项继承命令行默认值。`longest_edge` 不能与 `width/height` 同项使用。低区分度更愿意合并近似色，高区分度保留更多细微色差；不保证色数严格递增。不同尺寸总格数含背景空格，制作工作量以实际用豆数为准。

其他选项：`--palette <JSON>` 接受 `{id,hex}` 数组或含 `palette` 的对象，按用户色板映射而不自动合并；`--mode cross-stitch` 共用格子数据；`--fit cover` 等比居中裁切；`--cleanup 0..4`；`--max-colors 2..36`。背景容差 0–120、透明阈值 1–255 与[图纸协议](schema.md)一致。输入限 40 MiB 和 4000 万像素，GIF 首帧；规范化源图最长边 1024，先校正 EXIF。

## 输出与交付

`--output` 可指定**尚不存在的新目录**，存在时拒绝覆盖。未指定时创建 `~/.craft-pattern/outputs/<时间>-<随机ID>/`。stdout 返回 JSON manifest，目录内也保存 `manifest.json`：

- `plans[]`：名称、横纵格数、区分度、颜色上限、实际 `color_count`、`bead_count`、`blank_cells`、`warnings`。
- 每个方案的 `files`：`preview` 无符号 PNG 格子图；`chart` 带坐标、符号及逐色用量的 PNG 制作图；`svg` 可缩放符号图；`materials` 逐色用量 CSV；`json` 可编辑图纸。均为绝对路径。
- 多方案的 `comparison`：并排预览 PNG 的绝对路径。
- `recommended_plan`：优先第一个中档方案，否则居中方案，1 起始；只是默认起点，不能当作品质评分。
- `archive`：各方案对应的案例 ID、版本、库目录，未归档时为 null。`status` 与 `warnings` 明示全空图、归档失败等情况。

实际查看 preview/chart（多方案还要查看 comparison），确认图纸可辨认、无关键主体丢失。棋盘格表示空位，不能把它计成灰白两种材料。`chart` 每种实际用色的符号与格子内符号一致，CSV 用量与 cells 精确对应；色数上限不会强行凑满。

聊天交付时嵌入真实 PNG，例如 `![方案对比](/用户目录/输出/comparison.png)`。单图直接展示 preview，并提供 chart 制作图；多图展示对比、实际尺寸/色数/颗数与推荐理由，链接各 chart，按需附 SVG/CSV/JSON。用户明确要逐张图片时按其要求逐张内嵌。不能只返回文件路径文字、命令、网页或要求用户自行操作。

## 归档与已有图纸

默认自动归档到本地 SQLite，与服务共用 `CRAFT_PATTERN_LIBRARY` / `--library`。同一批方案放在同一个案例的不同版本，manifest 保留每个版本的对应关系；查找历史方案要用准确版本，最新版本不代表推荐方案。`--case-id <ID>` 向已有案例追加，未指定标题/标签时保留原元数据；`--title`、`--tags "标签一,标签二"` 可显式设置。`--no-archive` 只生成文件；正常用户生成保留默认归档。归档错误不删除已生成图纸，先交付文件并说明，可用 `library.py add` 重试。

已有图纸无需原图即可重新渲染：

```sh
python <skill>/scripts/render.py /用户目录/pattern.json --output /用户目录/新制作图.png
```

该命令输出符号制作图；加 `--preview` 输出无符号格子图。它不会重新量化、改写图纸或新增案例版本。按[案例库协议](library.md)检索、取回 JSON 和规范化源图；要重新生成不同参数则将源图交给 `generate.py --case-id <ID>`。
