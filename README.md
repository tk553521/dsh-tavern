# dsh-tavern（DSH 酒馆）

SillyTavern / TauriTavern 风格的角色扮演插件，作为 DeepSeek Harness (DSH) 的外部插件运行：
在 Web 界面的「对话」「轨迹」标签右侧新增 **「酒馆」** 标签，提供**人物卡、世界书、预设**管理，
以及遵循 DSH 范式的**多 agent 角色扮演**。

宿主版本要求见 `package.json` 的 `engines.dsh`：`>=0.2.2-alpha.3 <0.3.0`。仓库自带的
`npm run verify` 覆盖资料库、世界书、提示词、开场白与插件生命周期；宿主实机上的完整扮演链路
（会话恢复、世界书注入、重试/Swipe）以目标 DSH 版本的实际运行为准。

## 设计：一切通过 DSH

本插件**不运行任何独立后端服务**。所有能力都通过 DSH 自身的服务提供：

| 能力 | 使用的 DSH 机制 |
|---|---|
| 聊天与会话 | 一场扮演 = 一个 **DSH 会话**（导演 agent 的 session）。消息、轨迹、持久化、导出全部走 DSH 会话体系；会话**归档隐藏**，只显示在酒馆页内，「对话」页不会出现酒馆记录 |
| 多 agent | 导演 agent 通过 `ctx.agents` 创建；多 agent 模式下，每个角色是**独立的 DSH agent**（独立会话与记忆），导演用 agent 作用域内注册的 **`tavern_speak` 工具**让角色发言 |
| 资料库 | 存为 `$DSH_HOME/tavern/library/<collection>/<id>.json` 的单条文件（characters / lorebooks / presets / plays / branches 各一个子目录）；头像在 `$DSH_HOME/tavern/avatars/<id>.<ext>`；`defaultPresetId` / `style` 这类小偏好单独存在 `$DSH_HOME/tavern/prefs.json` |
| 角色扮演提示词 | 创建/恢复会话时由 agent setup 装配：角色卡写进插件自有的 system prompt 段 `tavern:persona`（`complete: true`），独占整段系统提示。宿主内置的 persona 槽位是 `deployment:persona-prefix` / `deployment:persona-suffix`，插件不复用它们 |
| 世界书注入 | 注册为 agent 的**动态 prompt context**（`tavern:world`，order 50）：每次组装按最近消息做关键词激活（SillyTavern 规则：constant / probability / delay / group / selective） |
| 开场白 | 以 **session seed** 写入会话日志：`turn/start` → `user/message` → `assistant/message`（开场白）→ `turn/end(completed)` |
| 前后端通信 | 库管理走 `ctx.webServer` 的 `/tavern` 前缀路由（dsh-host-webserver），不是独立端口/进程 |
| 重启恢复 | 剧本记录（含 `sessionId`）在 `plays/`；打开已有剧本时用 `sessionPersistence.open(id, 'read')` 读回会话，再用 `ctx.agents.resume` 恢复导演/角色会话 |
| 默认预设 | 插件加载时通过 `ctx.agentPresets.register(...)` 注册 id 为 `tavern` 的「酒馆极简模式」预设（order 4，只有 persona 行，不挂任何工具）；新剧本挂载它 |

## 安全模型

角色卡与世界书是**第三方内容**——用户从网上下载一张人物卡，就是把一个陌生作者写的文本装进模型的系统提示。插件按这个前提设计：

- **酒馆预设不挂载任何工具。** 预设是启动时向宿主 `agentPresets` 注册的一份声明，组合里只有一行 `@deepseek-ai/dsh-persona`；没有 bash、文件系统或任何 `dsh-tool-*` 行。扮演会话的系统提示完全由卡片内容组成，若同时给它 shell 和文件写入，一张恶意卡片就等于任意命令执行。
- **系统提示只有一个 complete 段。** 插件用自有的段名 `tavern:persona` 注册角色卡提示并标记 `complete: true`；宿主内置的 persona 槽位是 `deployment:persona-prefix` / `deployment:persona-suffix`，插件不复用（复用会撞上同名注册或遮蔽宿主段，行为不可依赖）。预设里的 persona 行因此是 `prefix: ''`、`complete: false`，只保留 `includeRuntimeContext: true` 让世界书等动态上下文继续注入。两个 `complete: true` 的段会让宿主在装配时抛 `multiple complete prompt sections are active`。
- **导入文本一律放进随机 nonce 围栏。** 围栏标记带每次装配现生成的随机串，卡片内部无法伪造闭合；同时中和 ChatML / `Human:` / 分节标题等分隔符。
- **本地导入不跟随符号链接。** TauriTavern 导入会 `lstat` + `realpath` 校验目标仍在数据目录内，拒绝 UNC / 设备路径，按类别限制文件大小，错误信息不回显文件内容。
- **世界书正则有 ReDoS 守卫。** 模式长度、结构与扫描文本长度都有上限（拒绝反向引用、嵌套量词、歧义交替等），因为世界书激活是在 prompt 组装里**同步**跑的。
- **宿主的认证 + 插件自己的第二道闸。** `/tavern` 路由挂在宿主的 `webServer` 上，handler 是裸 `node:http`，**不自动经过**宿主认证。插件在处理每个请求时先调用 `ctx.connection.requestRejection({ headers })`（可选服务；返回 401/403 即拒绝），**所有方法（含 GET）都过这道闸**。宿主没有 connection 服务时，退回插件自己的同源/Host 检查——那套检查只覆盖写请求，因此：
  - **不要把 DSH web 绑到公网**，只监听回环地址；
  - `allowedHosts` 只是写接口的浏览器式防 rebinding 白名单，**不是鉴权**；
  - 写请求另外要求 `Origin` 与 `Host` 同源、`Sec-Fetch-Site` 同源、`Content-Type: application/json`。

## 功能

- **酒馆标签**：位于「对话」（order 0）、「轨迹」（order 10）右侧（order 20），会话作用域视图。
- **会话隔离**：酒馆会话（导演/角色）创建与恢复后自动归档，不显示在「对话」页/工作区，聊天只在酒馆页内进行。
- **默认极简预设**：新剧本挂载**「酒馆极简模式」**——只有人格槽位、不挂载任何工具（见上「安全模型」），但开启 `includeRuntimeContext` 以保留世界书等动态注入。预设是插件启动时注册到宿主的声明，不再写 `$DSH_HOME/.agent-presets/`，也不修改磁盘上的旧预设文件。
- **人物卡**：导入 SillyTavern / TauriTavern 人物卡——PNG 卡（`chara`/`ccv3` tEXt 块，Base64 编码）与 JSON 卡（v1 / v2 / v3），可用文件选择器或粘贴 JSON 导入；编辑角色设定，导出 PNG 卡，头像提取。
- **世界书**：导入/导出 ST 世界书 JSON（`entries` 为对象或数组均可），条目编辑（关键词、内容、常驻、启用），扮演时按关键词自动激活注入。
- **预设**：导入/导出 ST 预设 JSON（temp、top_p、rep_pen、max_tokens 等映射到 DSH 模型路由与采样参数）。
- **本地 TauriTavern 导入**：在「酒馆 → 导入」填写本地 TauriTavern 安装目录（例如 `E:\TauriTavern`），批量导入原始数据目录中的人物卡、世界书与预设。
- **多 agent 扮演**：导演 + 角色 agent 各自独立；世界书自动注入；开场白自动播种。宿主未提供 `agentLoop` 时，界面上的多 agent 开关会置灰，剧本按经典模式运行。
- **对话状态**：每条回复实时标记生成状态——正在输出（流式）、已停止、截断（达到长度上限）、生成出错；思维链（reasoning）以可展开/收起的区块呈现；生成中可一键「停止」。
- **重试与多次尝试（Swipe）**：最后一条回复可「重试」重新生成，旧回复保留为一次尝试，底部 ‹ 1/3 › 左右切换不同结果；重试会分叉新会话，过程实时可见。
- **消息修改**：任意用户消息可「编辑并重新生成」（从该处分叉重播），角色回复可改写后重新生成。DSH 会话日志只追加不可改，因此修改/重试通过**分叉新会话**实现：共享前缀 + 各次尝试的事件尾部全部持久化，可反复切换。
- **经典模式**：关闭多 agent 时，导演一体扮演所有角色（「角色名：」前缀分行）。
- **样式跟随 DSH**：界面基于 DSH 的 `--dsw-*` 设计令牌，自动跟随 DSH 亮色/暗色切换；导航栏「样式」可切换为「经典酒馆」暗金配色（偏好持久化在 `prefs.json`）。

## cordis 集成

插件按 cordis 的生命周期设计，而不是自己造轮子：

- **就绪门控靠 fiber 状态，不靠手写 promise。** `apply` 是 `async` 的；cordis 在插件体 resolve 之后才把 fiber 标记为 ACTIVE，而 fiber 未 ACTIVE 时它提供的服务对注入方不可见。因此「等资料库索引加载完」这件事就是在 `apply` 里 `await`，`/tavern` 路由则注册在 `ctx.inject(['tavern'], …)` 的子 fiber 上——服务没就绪时路由**根本不存在**，不需要每个 handler 去 `await ready` 再返回 503。
- **必需服务**：`webServer`、`agents`、`agentDefaultModel`、`tools`、`dshHomePath`、`agentPresets`、`sessionPersistence`。缺任意一项，插件会停在 PENDING（没有报错，也没有「酒馆」标签），先检查 profile 是否提供了这些服务。
- **`workspaceRegistry` 是可选依赖**，不在 `inject` 里，改用 `ctx.get('workspaceRegistry')` 探测。缺它只会让酒馆会话不被归档（也就是会同时出现在「对话」页），其余功能不受影响。`connection` 同样用 `ctx.get()` 探测。
  > 注意：这个 cordis fork **没有** optional inject 语法。`Inject.resolve` 会把对象形式的**每个 key 都变成必需依赖**——对象的 value 是该服务的 intercept config，不是 required/optional 分类。写 `{ required: [...], optional: [...] }` 会请求两个名为 `"required"`／`"optional"` 的服务，插件将**静默停在 PENDING 且不报错**。
- **不继承 `Service` 基类**，尽管 DSH 一方插件都这么写。`Service` 是运行时值，而安装后的 profile 通常解析不到 `@deepseek-ai/cordis`，`import { Service } from '@deepseek-ai/cordis'` 会让插件直接加载失败。所以宿主半的 `@deepseek-ai` 引用**全部是 type-only**，构建后擦除；`scripts/verify/plugin.mjs` 里有断言守着「`lib/index.js` 不 import `@deepseek-ai`、只 import `node:` 内置模块」。
- **析构是异步的**：插件卸载会 `await` 每个 director / 角色 agent 真正释放，而不是 fire-and-forget。
- **日志级别**：cordis 的 `LoggerLevel` 是 `ERROR=0, WARN=1, INFO=2, DEBUG=3`，过滤条件为 `targetLevel < level` 时跳过，默认阈值 `INFO`——也就是说 **`WARN` 默认会输出，`DEBUG` 被丢弃**。用户需要看见的失败用 `.error`，可降级的失败用 `.warn`。

### 插件配置

`cordis.patch.yml` 的 bundle patch 会插入插件行，需要调参时在这行上加 `config:`（cordis 会用插件导出的 `Config` schema 校验）：

```yaml
- id: tavern
  name: dsh-tavern
  config:
    allowedHosts: [tavern.example]   # 写请求的额外 Host 白名单，默认只放行回环/localhost
    maxSwipeVariants: 12             # 每个分叉点保留的重试次数
    worldInfoBudgetChars: 8000       # 世界书单次注入的字符上限（多本书共享）
    scanMessages: 12                 # 世界书扫描读取的最近消息条数
    speakTimeoutMs: 120000           # 单次 tavern_speak 等待角色 agent 的超时
```

字段缺失、类型不对或超出范围都会回落到默认值；唯一的例外是**整块 config 不是对象**——那会抛错并使插件加载失败（cordis 报 ValidationError）。`allowedHosts` 另外接受环境变量 `DSH_TAVERN_ALLOWED_HOSTS`（逗号分隔），两者取并集。

## 安装

先决条件：Node ≥ 22（构建）；`pnpm` 在 PATH 上（`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，找不到时以 127 退出）；运行中的 dsh 满足 `engines.dsh`，低于 `0.2.2-alpha.3` 会在安装/启用时报版本不兼容。

`@deepseek-ai/*` **不在 npm registry 上**，构建与类型检查需要本机 dsh 安装里的那份 `@deepseek-ai`。先在仓库根目录建一个链接。目录因安装方式而异：桌面版通常是 `%APPDATA%\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai`，npm 安装是 `<dsh 安装根>\node_modules\@deepseek-ai`；目录里应能看到 `dsh`、`cordis`、`dsh-session` 等包。

PowerShell：

```powershell
$dshAi = "$env:APPDATA\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai"
if (Test-Path node_modules\@deepseek-ai) { cmd /c rmdir node_modules\@deepseek-ai }
New-Item -ItemType Directory -Force node_modules | Out-Null
New-Item -ItemType Junction -Path node_modules\@deepseek-ai -Target $dshAi
```

bash（Git Bash / MSYS）：

```bash
DSH_AI="/c/Users/<you>/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai"
mkdir -p node_modules
rm -f node_modules/@deepseek-ai
MSYS_NO_PATHCONV=1 cmd /c mklink /J "node_modules\\@deepseek-ai" "$(cygpath -w "$DSH_AI")"
```

注意顺序：`npm install` 会删掉这个链接，`npm ci` 会清空 `node_modules`，所以用 npm 时**先装依赖、再建链接**；`pnpm install` 不会动它，可以**先建链接再安装**。另外 `package.json` 的 `prepare` 是 `npm run build`，类型包尚未链接时 `prepare` 会失败，装依赖时加 `--ignore-scripts`。

```sh
# pnpm：链接先建（命令见上），install 不会删除它
pnpm install --ignore-scripts
npx tsdown

# npm：npm ci 会清空 node_modules，链接放在它之后
npm ci --ignore-scripts
# 在这里执行上面的建链接命令
npx tsdown

# 两条路线任选一条，完成后在仓库根目录安装进 web profile
dsh plugin --profile web add .
# 然后重启 dsh web（安装/升级 bundle 后需要重启进程）
```

如果安装依赖后链接消失，重新执行一次建链接命令再构建。

重启 `dsh web` 后检查「对话」右侧是否出现「酒馆」标签。若没有出现，先看 `dsh web` 日志与 profile 里是否已有 `tavern` 行；插件行加载失败时不会显示标签。

> 开发时如果 profile 里是安装时拷贝的快照（不是指向本目录的 link），改完代码还要 `npm run dev:sync` 把 `lib/` 同步进 `$DSH_HOME/profiles/<profile>/node_modules/dsh-tavern/`。

## 使用

1. **角色**：导入人物卡（文件选择器或粘贴 JSON）。也可以进入「酒馆 → 导入」，填写原始 TauriTavern 本地安装/数据目录（例如 `E:\TauriTavern`），一次导入人物卡、世界书和预设。
2. **世界书**：导入世界书 JSON（可选）。
3. **预设**：导入 ST 预设 JSON（可选）。
4. **会话**：在「酒馆 → 会话」勾选登场角色，可选择一本或多本世界书（按选择顺序合并注入）与预设，勾选「多 agent 模式」与「叙述者」，点击「开始扮演」。
   - 插件会创建一个 DSH 会话（导演），开场白已写入会话日志；新剧本默认挂载「酒馆极简模式」预设。
   - 酒馆会话会**归档隐藏**：不显示在「对话」页/工作区，只在酒馆页内聊天。
   - 在酒馆页与角色对话；多 agent 模式下导演会调用 `tavern_speak` 让角色以自身性格回应。
5. 会话记录、轨迹、导出等全部是标准 DSH 会话能力；再次打开旧剧本时会先读取持久化记录并 resume 原会话，只有在找不到会话记录时才新建。

## 数据格式兼容

- 人物卡：`chara_card_v2`（默认导出）；读取兼容 v1/v2/v3 与 PNG 嵌入（`ccv3` 优先、`chara` 回退、Base64 值）。
- 头像：记录里的 `avatar` 字段保存 `tavern/avatars/<character-id>.<ext>` 相对路径（PNG / JPEG / WebP / GIF 都接受），文件本体位于 `$DSH_HOME/tavern/avatars/`；旧版 base64 内联头像会在插件启动时自动迁移为文件。
- 世界书：ST 独立世界书（`entries` 为 uid 键对象）与内嵌 `character_book`（entries 数组）均可导入；导出为 ST 世界书文件格式（snake_case `extensions` 元数据镜像）。
- 预设：ST 各类型预设 JSON 均接受；`custom_model` 映射为 DSH 模型路由。
- 聊天：对话完全以 DSH 会话日志为准（可用标准导出能力），资料库只在 `tavern/library/` 存剧本绑定。
- 偏好：`defaultPresetId`、`style` 在 `$DSH_HOME/tavern/prefs.json`；旧版把资料库放在 settings 文档里的安装，启动时会尝试从 `$DSH_HOME/tavern/legacy-library.json` 或 `settings.yaml.imported` / `settings.yaml` 的 `tavern:` 段恢复。读 YAML 需要可用的 `yaml` 模块，缺它时只打印一条指引，不改原文件。
- 本地数据目录：接受 TauriTavern 安装根目录（自动查找 `data/default-user`）、data 根目录、`default-user` 目录或其子目录；如存在 `tauritavern-runtime.json`，会参考其中配置的 `data_root`。按规范化真实数据根目录的 SHA-256 命名空间与相对源文件路径去重，可重复执行；不同安装目录下的同名文件独立导入。旧版无命名空间记录只在内容一致时去重；不会修改原目录。
  > 已知限制：`data_root` 目前只在**位于安装根目录之内**时生效；写成绝对路径或 `..` 跳出安装根会被忽略，此时请直接把那个目录作为导入路径填进来。

## 开发与构建

- `npm run build` / `npx tsdown`：产出 `lib/index.js`（宿主半，ESM）与 `lib/client.js`（浏览器半，CJS 闭包交给宿主的模块加载器；平台模块从宿主模块表解析）。`lib/` 是构建产物，**不提交进仓库**。
- `npm run dev:sync`：构建后再把 `lib/` 同步进 `$DSH_HOME/profiles/<profile>/node_modules/dsh-tavern/`（`dsh web` 实际加载的那份快照）。这一步会写项目之外的目录，所以**不放在 `prepare` 里**——`npm install` 不应产生项目外副作用。
- `npm run typecheck`：宿主与客户端两个独立 TypeScript 程序（避免宿主/客户端 Context 声明合并冲突）；当前工作树两者都是 0 error。
- `npm run verify`：先构建，再跑 `scripts/verify/` 下的五个断言脚本（资料库、世界书激活语义、提示词围栏、开场白 seed、cordis 插件生命周期），基础断言 **103** 项（19 + 38 + 15 + 8 + 23），再执行 **16** 项回归测试，共 **119** 项。生命周期那一份会在**真实的 cordis root context** 里加载构建产物，用 0.2.2 的服务契约替身断言就绪门控、路由挂载/摘除、可选依赖与配置校验，并用宿主自己的 `entryListProblem` 校验预设声明；seed 那一份把 `greetingSeed()` 交给宿主的 `Session.create` 校验。验证脚本直接用 Node 执行 `.ts`，需要 Node ≥ 23.6（或 22.18+ 的默认类型擦除），并且同样需要「安装」一节里的 `@deepseek-ai` 链接（seed/plugin 脚本会直接 import 宿主包）。
- `npm run verify:regressions`：独立运行数据并发/删除、头像所有权、跨目录导入、预设清空导出、环境配置、世界书 HTTP 保存与运行时生命周期/回复边界的 16 项回归测试。数据测试使用隔离临时目录；运行时测试通过公共接口搭配 agent 服务替身，不调用真实模型。头像与 HTTP 测试需要 `--experimental-transform-types`（脚本已包含），以支持 TypeScript 参数属性；完整验证仍建议使用 Node 22.18+ 或 24。
- 类型解析：`@deepseek-ai/*` 通过 `node_modules/@deepseek-ai` 解析（链接方法见「安装」）；三个 tsconfig 都不含绝对路径或 `.ref/` 引用。
- 宿主半没有运行时 `@deepseek-ai` 导入（`import type` 在转译期擦除）；浏览器半通过宿主模块表加载平台模块。

## 已知限制

- 角色/世界书/预设库的浏览与编辑通过 `/tavern` 前缀路由与宿主通信（DSH 官方插件 HTTP 扩展点）；若未来 DSH 提供插件级 RPC 注册机制，可平滑迁移。
- **世界书当前支持的语义**：`disable`、`constant`、主关键字、`keysecondary` + `selectiveLogic`（AND_ANY / NOT_ALL / NOT_ANY / AND_ALL）、`keyregex`、`caseSensitive`、`matchWholeWords`（按 ST 的 `\W` 边界，CJK 算边界）、`probability` + `useProbability`、`delay`、互斥组（按 `groupWeight` 加权抽取，支持 `groupOverride` 与逗号分隔多组名）、`order` 排序、字符预算。正则守卫包含歧义交替检测；预算准入按 ST 的 `order` 降序，且多本书共享同一个上限。概率与分组抽取使用确定性种子（play id + 轮次）。
- **世界书仍未实现**（字段会解析并往返保真，但不影响激活，不要以为它生效）：递归扫描（`excludeRecursion` / `preventRecursion` / `delayUntilRecursion`）、定时效果（`sticky` / `cooldown`）、逐条 `scanDepth`、`vectorized`、各 `match*` 扫描源开关、`position` 放置位置（全部渲染进同一个块）、`role`、`key` 里的 `/regex/flags` 写法、`useGroupScoring`。
- `addMemo` 打开时，条目的 `comment` 会作为 `（注释）` 前缀进入注入内容；不想给模型看的备注不要写进 comment。互斥组只在单本书内选取，不跨书合并。
- 世界书扫描使用最近 12 条消息的文本（`scanMessages` 可调）。
- 角色卡中的 `mes_example` 暂未注入提示词；卡内嵌的 `character_book` 随卡读写，但扮演只注入选中过的独立世界书，卡内书不会自动参与激活。
- 非 PNG 头像（jpg / webp / gif）无法嵌入导出的 PNG 人物卡（需要转码）；导出会回退为空白图，并在响应头 `x-tavern-avatar: omitted-unsupported-format` 中说明。
- 预设注册失败时，**新建剧本会失败**（创建路径会等待预设注册）；已存在会话里的预设挂载失败只记 `WARN`，会话继续以无预设运行。
- 重试/切换（swipe）每条分支最多保留 12 次尝试，超出后最旧的会被丢弃；每次重试/编辑都会 fork 一个新 DSH 会话，旧会话日志留在磁盘上暂不回收。
- 浏览器半通过宿主前端的模块表加载：构建产物只请求 `react`、`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-store`（三者都是宿主平台模块表里的基线模块），其余 `@deepseek-ai/*` 引用是 type-only、转译期已擦除。宿主版本若改了模块表，需要同步 `src/client/vendor.d.ts` 与 `tsdown.config.ts` 的 external 列表。
- 会话日志的读取用的是 `Session.snapshotEvents()` / `eventAt()`：宿主已把它们标注为 **deprecated（"new calls are prohibited"）**，但没有提供等价的一次性全量读取；将来改用 `session.surface` / `ctx.sessionQuery.readSession()` 时，`src/play.ts` 里读日志的几处（取回复文本、世界书扫描、swipe 分叉尾部）需要一起迁移。
- `/tavern` 是本地插件路由，不构成远程访问方案；不要把 DSH web 暴露到公网。
