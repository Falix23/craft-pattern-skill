# 本地案例库与 Agent 检索

案例库用于收集用户自己的图纸、源图和修改版本。Agent 可直接通过 CLI 生成、归档、检索和返回图纸图片，无需启动页面或服务；交互编辑时可运行本地服务，将页面与 CLI 连到同一个 SQLite 库。直接打开单文件 HTML 时使用当前浏览器的 IndexedDB。关键词检索覆盖名称、标签、备注和源文件名，可结合图纸结构筛选；没有语义向量、图片相似搜索或外部案例抓取。

## 存储与服务

默认 SQLite 库为 `~/.craft-pattern/library`。目录选择优先级为命令行 `--library`、环境变量 `CRAFT_PATTERN_LIBRARY`、默认目录。真实作品放在用户目录，不放入项目仓库或公开发布目录。

```text
~/.craft-pattern/library/
├── library.sqlite3
└── cases/
    └── <32位案例ID>/
        ├── v000001/
        │   ├── pattern.json
        │   ├── source.png     # 有源图时存在
        │   └── preview.png
        └── v000002/
            └── ...
```

案例 ID 为 32 位十六进制 UUID。版本文件按六位编号存放；SQLite 保存案例元数据与版本索引。`source.png` 是 EXIF 校正、RGBA、最长边不超过 1024 的规范化源图，不是原文件的逐字节备份。仅导入图纸 JSON 时可能没有源图；此类案例可编辑格子，重新生成前需要补充原图。

在项目目录执行：

```sh
python scripts/library.py init
python scripts/serve.py --background
```

打开 `http://127.0.0.1:8765/docs/index.html`。服务只监听回环地址；`--port` 改端口，`--directory` 改静态文件根目录，`--library` 改库目录。例如要打开独立输出目录中的 `pattern.html`，使用 `python scripts/serve.py --background --directory /绝对路径/输出目录`，再打开 `/pattern.html`。

`--background` 启动脱离终端与聊天工具生命周期的后台进程，等待健康检查后返回服务 URL、PID、库目录与日志路径；相同库、端口和网页目录的健康服务会复用。`--status` 输出状态，`--stop` 核对本地记录及运行实例后停止本项目服务，不停止其他占用端口的程序。默认端口日志是库目录 `server.log`，运行记录为 `server-8765.json`。不带上述选项时仍以前台方式运行；电脑重启后需重新启动。

如果页面提示案例库未连接，先运行 `--status` 并用 `--background` 恢复服务。页面“重试保存”可重新初始化连接或再次提交当前图纸，不需要刷新或重新上传。网络失败不切换到另一个空案例库。10 秒请求超时也会保留图纸并允许重试；保存已提交但列表刷新失败时，仍保持已保存状态。

纯单文件打开会自动使用 IndexedDB 数据库 `craft-pattern-library`，不读取 SQLite。它受当前浏览器和页面来源隔离，换浏览器或打开方式可能看到不同的库。清理浏览器站点数据可能删除案例，请导出备份后迁移；两类库不会自动同步。

## 收录、版本与元数据

CLI `generate.py` 与 `build.py` 默认自动收录，`--no-archive` 可跳过。直接出图的同一批多方案保存为一个案例的多个版本，manifest 记录各方案对应的版本；推荐方案不一定是最新版本。页面每次生成、导入图纸 JSON、导出保存 JSON 时也自动收录；手工修改后点“存入案例库”或“保存新版本”。库包含图纸、可用的源图、预览及历史版本。

与当前最新版本的图纸内容、处理参数和源图完全一致时，不增加版本；只修改案例名称、标签、备注、状态也不增加图纸版本。历史版本保持原样，打开历史后保存不同于最新版本的内容会追加一个新版本，不覆盖历史。

案例卡可选择版本打开并恢复已保存的源图；“案例信息”可改名称、标签、备注及状态：`draft` 草稿、`final` 已定稿、`made` 已制作。元数据约束为名称不超过 300 字符、备注 `description` 不超过 5000 字符、标签最多 20 项且每项不超过 50 字符。

## CLI 契约

以下命令均输出 JSON。全局 `--library` 必须放在子命令之前；同一工作流中的初始化、构建、服务与检索应使用同一库目录。

```sh
python scripts/library.py --library /绝对路径/我的案例库 init
python scripts/library.py --library /绝对路径/我的案例库 search "橘猫" --max-width 60 --max-height 60 --max-colors 8 --max-beads 2000 --status draft --limit 24
```

`search [query]` 的 query 可省略。按空白分词，各词都需在名称、标签、备注、源文件名中匹配；按更新时间从新到旧返回 `{items,total}`。`--max-width`、`--max-height`、`--max-colors`、`--max-beads` 是上限，颜色数只统计实际使用的颜色，用豆数跳过空格。`--status` 限 `draft/final/made`，`--limit` 为 1–100、默认 24。

`items` 是元数据，不含整张图纸：`id,title,tags,description,status,width,height,color_count,bead_count,blank_cells,source_name,version,version_count,created_at,updated_at,preview_url`。对选定结果再读取：

```sh
python scripts/library.py get '<case-id>'
python scripts/library.py get '<case-id>' --version 1
```

`get` 返回 `{case,pattern,source_url,preview_url,versions}`，默认读取最新版本。`source_url` 无源图时为 null，其余资源 URL 供本地服务使用，不是磁盘路径。Agent 可根据 `init` 返回的 `path`、案例 ID 与版本号定位 `cases/<id>/v000001/pattern.json`、可选 `source.png` 和 `preview.png`；也可在 Python 中调用 `library.case_asset(id, 'source'|'preview', version, library_dir)` 取得资源绝对路径。

为已有 JSON 归档或追加版本：

```sh
python scripts/library.py add /用户目录/pattern.json --source /用户目录/photo.png --title "橘猫挂件" --tags "动物,挂件" --description "准备制作的小图案" --status draft
python scripts/library.py add /用户目录/edited.json --case-id '<case-id>' --tags "动物,挂件"
```

`add pattern` 的可选项为 `--source`、`--title`、`--tags`（逗号分隔）、`--description`、`--status`、`--case-id`。已有案例追加时未提供 `--source` 会沿用最新版本的源图；若在恢复某个历史版本后改图，按需显式传该历史版源图路径，避免误用最新源图。返回 `{case,created,version_added}`。

需要由源图直接生成新方案时，将对应版本的源图传给 `generate.py --case-id`，详见[直接出图协议](direct-output.md)；需要显式色板 HTML 时按[图纸协议](schema.md)准备配置，再运行 `build.py --case-id`。已有图纸可直接用 `render.py pattern.json --output /用户输出/chart.png` 渲染 PNG 并在聊天返回，不改变格子和版本。仅逐格改动时保留 JSON 的尺寸、色板与参数，修改后用 `library.py add` 追加。打开案例进行交互编辑推荐使用本地服务页面；没有“CLI 导出单案例 HTML”的命令。

## 备份与迁移

页面“导出备份/导入备份”与以下 CLI 处理整库备份，包含案例元数据、各版本图纸及图片：

```sh
python scripts/library.py backup /用户目录/备份/craft-pattern-library.json
python scripts/library.py import /用户目录/备份/craft-pattern-library.json
```

备份顶层为 `{format:"craft-pattern-library",version:1,created_at?,cases:[...]}`；每个案例的 `versions` 含版本号、时间、图纸及可空的 `source_data`/`preview_data` 图片 data URL。SQLite 和 IndexedDB 使用此格式互相迁移，导入复用匹配内容并合并版本；不要依赖导入前后的案例 ID 相同。CLI 导入的备份文件上限为 128 MiB。

普通“保存图纸”导出的 `pattern.json` 是单图纸格式，不包含原图及历史；整库备份才用于完整迁移。CLI 子命令是 `backup` 与 `import`，没有单案例 HTML 导出。

## Agent 自然语言检索

首次生成主动 `init`，后续 CLI 默认自动归档。用户提出“找出 60 格以内、最多 8 色的橘猫草稿”等请求时，将对象词用于 `search`，将尺寸、颜色数、用豆数、状态转为结构化上限与状态参数。先读返回元数据，再对候选 `get` 并查看源图/预览，依据实际内容继续编辑；不根据关键词凭空认定图案细节。无结果时说明当前库中未匹配，必要时放宽明确的筛选条件。

现有图案的修改应保存到用户输出目录并追加案例版本；源图和历史版本保持可恢复。案例库备份与生成文件均属于用户本地资料，避免加入仓库示例或公开目录。
