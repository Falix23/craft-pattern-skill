# 配置与图纸格式

配置示例见 `examples/input.json`。配置字段：`title`；`image`（相对配置目录的本地图片）；`width`/`height`（4–160 的整数格数）；`mode`（`bead` 或 `cross-stitch`）；`fit`（`contain` 补白或 `cover` 居中裁切）；`palette`（2–36 个 `{id,hex,stock?}`）。`id` 唯一、非空；`hex` 为 `#RRGGBB`；`stock` 为非负整数，可省略。色值为屏幕 RGB 参考，不承诺实物色一致。

脚本使用 EXIF 朝向，透明底合成白色，再缩放、在线性 RGB 空间按亮度权重选择最近的色板颜色。图片不得超过 4000 万像素。`stock` 只计算缺料，不限制配色算法的选择。

输出 `version:1`、`title`、`mode`、`width`、`height`、`palette`、`cells`（行优先、长度 width×height，值为 palette 的 0 起始索引）、`source`、`notes`。页面 JSON 导入使用该输出格式，不是原图配置格式。SVG 物理每格 5 mm；实际手工尺寸需另据材料计算。页面编辑不会重新访问原始图片。
