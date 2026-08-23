# dsh-tavern（DSH 酒馆）

SillyTavern / TauriTavern 风格的角色扮演插件，作为 DeepSeek Harness (DSH) 的外部插件运行：
在 Web 界面的「对话」「轨迹」标签右侧新增 **「酒馆」** 标签，提供**人物卡、世界书、预设**管理，
以及遵循 DSH 范式的**多 agent 角色扮演**。

## 设计：一切通过 DSH

本插件**不运行任何独立后端服务**。所有能力都通过 DSH 自身的服务提供：

| 能力 | 使用的 DSH 机制 |
|---|---|
| 聊天与会话 | 一场扮演 = 一个 **DSH 会话**（导演 agent 的 session）。消息、轨迹、持久化、导出全部走 DSH 会话体系；会话**归档隐藏**，只显示在酒馆页内，「对话」页不会出现酒馆记录 |
| 多 agent | 导演 agent 通过 `ctx.agents` 创建；多 agent 模式下，每个角色是**独立的 DSH agent**（独立会话与记忆），导演用宿主注册的 **`tavern_speak` 工具**（`ctx.tools`）让角色发言 |
| 角色卡 / 世界书 / 预设 | 存为 `$DSH_HOME/tavern/library/` 下的**单条 JSON 文件**（characters / lorebooks / presets / plays / branches 各一个子目录）；角色头像 PNG 存到 `$DSH_HOME/tavern/avatars/`。settings 服务只保存 `defaultPresetId`、`style` 这类小偏好 |
| 角色扮演提示词 | 创建会话时通过 agent setup 装配：角色卡组成 **system prompt 的 persona 槽位**（`deployment:persona`，complete），同名遮蔽预设固定 persona |
| 世界书注入 | 注册为 agent 的 **动态 prompt context**：每次组装按最近消息做关键词激活（SillyTavern 规则：constant / probability / depth / group / selective） |
| 开场白 | 以 **session seed**（平衡的 completed-turn 事件序列）写入会话日志 |
| 前后端通信 | 库管理走 DSH 进程内的 HTTP 插件扩展点（`ctx.webServer` 前缀路由 `/tavern`，由 dsh-host-webserver 提供，非独立端口/进程） |
| 重启恢复 | 播放记录持久化在 `tavern/library/plays/`；重新打开时通过 `ctx.agents.resume` 恢复导演/角色会话，历史完整保留 |

## 安全模型

角色卡与世界书是**第三方内容**——用户从网上下载一张人物卡，就是把一个陌生作者写的文本装进模型的系统提示。插件按这个前提设计：

- **酒馆预设不挂载任何工具。** 扮演会话的系统提示是 `complete` 的人格槽位（完全由卡片内容组成），如果同时给它 bash 和文件系统，一张恶意卡片就等于任意命令执行。预设只保留 persona 行（`includeRuntimeContext: true`，用于世界书注入）。
  - 旧版本预设含 `persistent-bash` + `fs-local` + 编辑器。插件启动时会**自动升级**磁盘上仍与旧版逐字节相同的预设文件；被你手工编辑过的文件不会动（此时请自行移除工具行）。
- **导入文本一律放进随机 nonce 围栏。** 围栏标记带每次装配现生成的随机串，卡片内部无法伪造闭合；同时中和 ChatML / `Human:` / 分节标题等分隔符。
- **本地导入不跟随符号链接。** TauriTavern 导入会 `lstat` + `realpath` 校验目标仍在数据目录内，拒绝 UNC / 设备路径，按类别限制文件大小，错误信息不回显文件内容。
- **世界书正则有 ReDoS 防护**：模式长度、结构与扫描文本长度都有上限（世界书激活是在 prompt 组装里**同步**跑的，一个灾难性回溯的正则会冻死整个宿主进程）。
- **写接口只接受同源请求**，并要求 `Host` 是回环地址或 `localhost`（DNS rebinding 防护）。
  通过真实域名访问时把该域名加入插件配置的 `allowedHosts`（见「插件配置」）。

## 功能

- **酒馆标签**：位于「对话」（order 0）、「轨迹」（order 10）右侧（order 20），会话作用域视图。
- **会话隔离**：酒馆会话（导演/角色）创建与恢复后自动归档，不显示在「对话」页/工作区，聊天只在酒馆页内进行。
- **默认极简预设**：酒馆会话默认挂载**「酒馆极简模式」agent 预设**——**只有人格槽位、不挂载任何工具**（见上「安全模型」），但开启 `includeRuntimeContext` 以保留世界书等动态注入；预设由插件写入 `$DSH_HOME/.agent-presets/tavern/`（幂等、原子写、不覆盖用户编辑）。
- **人物卡**：导入 SillyTavern / TauriTavern 人物卡 —— PNG 卡（`chara`/`ccv3` tEXt 块，Base64 编码）与 JSON 卡（v1 / v2 / v3），编辑角色设定，导出 PNG 卡，头像提取。
- **世界书**：导入/导出 ST 世界书 JSON（entries 为对象或数组均可），条目编辑（关键词、内容、常驻、启用），扮演时按关键词自动激活注入。
- **预设**：导入/导出 ST 预设 JSON（temp、top_p、rep_pen、max_tokens 等映射到 DSH 模型路由与采样参数）。
- **本地 TauriTavern 导入**：在「酒馆 → 导入」填写本地 TauriTavern 安装目录（例如 `E:\TauriTavern`），批量导入原始数据目录中的人物卡、世界书与预设。
- **多 agent 扮演**：导演 + 角色 agent 各自独立；世界书自动注入；开场白自动播种。
- **对话状态**：每条回复实时标记生成状态——正在输出（流式）、已停止、截断（达到长度上限）、生成出错；思维链（reasoning）以可展开/收起的区块呈现；生成中可一键「停止」。
- **重试与多次尝试（Swipe）**：最后一条回复可「重试」重新生成，旧回复保留为一次尝试，底部 ‹ 1/3 › 左右切换不同结果；重试在后台分叉新会话，过程实时可见。
- **消息修改**：任意用户消息可「编辑并重新生成」（从该处分叉重播），角色回复可直接就地改写。DSH 会话日志只追加不可改，因此修改/重试通过**分叉新会话**实现：共享前缀 + 各次尝试的事件尾部全部持久化，可反复切换、重启不丢。
- **经典模式**：关闭多 agent 时，导演一体扮演所有角色（「角色名：」前缀分行）。
- **样式跟随 DSH**：界面基于 DSH 的 `--dsw-*` 设计令牌（`ui-theme`），自动跟随 DSH 亮色/暗色切换；导航栏「样式」可切换为「经典酒馆」暗金配色（偏好持久化在 settings）。

## cordis 集成

插件按 cordis 的生命周期设计，而不是自己造轮子：

- **就绪门控靠 fiber 状态，不靠手写 promise。** `apply` 是 `async` 的；cordis 会在插件体
  resolve 之后才把 fiber 标记为 ACTIVE（`cordis/src/fiber.ts:656,665`），而 fiber 未 ACTIVE 时
  它提供的服务对注入方不可见（`reflect.ts:_getImpl`）。因此「等资料库索引加载完」这件事
  就是在 `apply` 里 `await`，`/tavern` 路由则注册在 `ctx.inject(['tavern'], …)` 的子 fiber 上——
  服务没就绪时路由**根本不存在**，不需要每个 handler 去 `await ready` 再返回 503。
- **`workspaceRegistry` 是可选依赖**，不在 `inject` 里，改用 `ctx.get('workspaceRegistry')` 探测。
  缺它只会让酒馆会话不被归档（也就是会同时出现在「对话」页），其余功能不受影响。
  > 注意：这个 cordis fork **没有** optional inject 语法。`Inject.resolve`
  > （`registry.ts:71-88`）会把对象形式的**每个 key 都变成必需依赖**——对象的 value 是该服务的
  > intercept config，不是 required/optional 分类。写 `{ required: [...], optional: [...] }`
  > 会请求两个名为 `"required"`／`"optional"` 的服务，插件将**静默停在 PENDING 且不报错**。
- **不继承 `Service` 基类**，尽管 DSH 一方插件都这么写。`Service` 是运行时值，而安装后的 profile
  里没有任何 `@deepseek-ai` 树（`$DSH_HOME/profiles/<p>/node_modules/` 只有插件自身和它的
  devDependencies），`import { Service } from '@deepseek-ai/cordis'` 会解析失败、插件直接加载不了。
  所以宿主半的 `@deepseek-ai` 引用**全部是 type-only**，构建后擦除；
  `scripts/verify/plugin.mjs` 里有一条断言守着这个约束。
- **析构是异步的**：插件卸载会 `await` 每个 director / 角色 agent 真正释放，而不是 fire-and-forget。
- **日志级别**：cordis 的 `LoggerLevel` 是 `ERROR=0, INFO=1, WARN=2, DEBUG=3`，过滤条件为
  `targetLevel < level` 时跳过，默认阈值 INFO=1 —— 也就是说 **`.warn` 默认不会输出**。
  用户需要看见的失败一律用 `.error`。

### 插件配置

在配置树的插件行上加 `config:` 即可（cordis 会用插件导出的 `Config` schema 校验）：

```yaml
- id: tavern
  name: dsh-tavern
  config:
    allowedHosts: [tavern.example]   # DNS rebinding 白名单，默认只放行回环/localhost
    maxSwipeVariants: 12             # 每个分叉点保留的重试次数
    worldInfoBudgetChars: 8000       # 世界书单次注入的字符上限
    scanMessages: 12                 # 世界书扫描读取的最近消息条数
    speakTimeoutMs: 120000           # 单次 tavern_speak 等待角色 agent 的超时
```

字段缺失、类型不对或超出范围都会回落到默认值，而不是拒绝启动。
`allowedHosts` 另外仍接受环境变量 `DSH_TAVERN_ALLOWED_HOSTS`（逗号分隔），两者取并集。

## 安装

```sh
# 在插件目录构建（需要 node ≥ 22 + pnpm；类型解析依赖本地 dsh 安装，见“开发”）
pnpm install
pnpm build

# 安装进 web profile
dsh plugin --profile web add <本插件目录>

# 重启 web 服务后生效
```

安装后重新启动 `dsh web`（`dsh --profile web`），浏览器打开界面，
在「对话」标签右侧即可看到「酒馆」标签。

## 使用

1. **角色**：导入人物卡（支持拖文件或粘贴 JSON）。
   - 也可以进入「酒馆 → 导入」，填写原始 TauriTavern 本地安装/数据目录（例如 `E:\TauriTavern`），一次导入人物卡、世界书和预设。
2. **世界书**：导入世界书 JSON（可选）。
3. **预设**：导入 ST 预设 JSON（可选）。
4. **会话**：在「酒馆 → 会话」勾选登场角色，可选择一本或多本世界书（按选择顺序合并注入）与预设，勾选「多 agent 模式」与「叙述者」，点击「开始扮演」。
   - 插件会创建一个 DSH 会话（导演），开场白已写入会话日志；会话默认挂载**「酒馆极简模式」agent 预设**（极简组合 + 开启动态注入），并在启动时自动写入 `$DSH_HOME/.agent-presets/tavern/`（可自由编辑）。
   - 酒馆会话会**归档隐藏**：不显示在「对话」页/工作区，只在酒馆页内聊天。
   - 在酒馆页与角色对话；多 agent 模式下导演会自动调用 `tavern_speak` 让角色以自身性格回应。
5. 会话记录、轨迹、导出等全部是标准 DSH 会话能力。

## 数据格式兼容

- 人物卡：`chara_card_v2`（默认导出）；读取兼容 v1/v2/v3 与 PNG 嵌入（`ccv3` 优先、`chara` 回退、Base64 值）。
- 头像：settings 中的 `avatar` 字段保存 `tavern/avatars/<character-id>.png` 相对路径，文件本体位于 `$DSH_HOME/tavern/avatars/`；旧版 base64 内联头像会在插件启动时自动迁移为文件。
- 世界书：ST 独立世界书（`entries` 为 uid 键对象）与内嵌 `character_book`（entries 数组）均可导入；导出为 ST 世界书文件格式（snake_case `extensions` 元数据镜像）。
- 预设：ST 各类型预设 JSON 均接受；`custom_model` 映射为 DSH 模型路由。
- 聊天：对话完全以 DSH 会话日志为准（可用标准导出能力）。
- 本地数据目录：接受 TauriTavern 安装根目录（自动查找 `data/default-user`）、data 根目录、`default-user` 目录或其子目录；如存在 `tauritavern-runtime.json`，优先使用其中配置的 `data_root`。按源文件去重，可重复执行；不会修改原目录。

## 开发与构建

- `pnpm build`：tsdown 产出 `lib/index.js`（宿主半，ESM）与 `lib/client.js`（浏览器半，`window.__ModuleLoader__.load` 闭包，平台模块 external）。
  `lib/` 是构建产物，**不提交进仓库**。
- `pnpm dev:sync`：构建后再把 `lib/` 同步进 `$DSH_HOME/profiles/<profile>/node_modules/dsh-tavern/`
  （`dsh web` 实际加载的那份快照）。这一步会写项目之外的目录，所以**不放在 `prepare` 里**——
  `npm install` 不应产生项目外副作用。
- `pnpm typecheck`：宿主与客户端两个独立 TypeScript 程序（避免宿主/客户端 Context 声明合并冲突）。
- `pnpm verify`：先构建，再跑 `scripts/verify/` 下的断言脚本（世界书激活语义、提示词围栏、
  资料库存储与迁移、cordis 插件生命周期），共 81 项。生命周期那一份会在**真实的 cordis root
  context** 里加载构建产物，断言就绪门控、路由挂载/摘除、可选依赖与配置校验，并守住
  「宿主半不得运行时 import @deepseek-ai」这条约束。依赖 Node ≥ 23.6 的原生 TypeScript 执行。
- 类型解析：`@deepseek-ai/*` 通过 `node_modules` 正常解析。这些包**不在 npm registry 上**
  （registry 上的多为旧版 rc，不要用作类型来源），需要从本地 dsh 安装链接进 `node_modules/@deepseek-ai`。
  三个 tsconfig 都**不再包含任何绝对路径**；`tsconfig.client.json` 额外用相对路径指向 `.ref/`
  下的参考 checkout 解析 `dsh-client-ui-slots`。
- 宿主半只有一处 `@deepseek-ai` 运行时值导入（客户端 `store.ts` 的 `defineStore`），已声明为
  peerDependency；其余 30+ 处均为 `import type`，转译期擦除。

## 已知限制

- 角色/世界书/预设库的浏览与编辑通过 `/tavern` 前缀路由与宿主通信（DSH 官方插件 HTTP 扩展点）；
  若未来 DSH 提供插件级 RPC 注册机制，可平滑迁移。
- **世界书已实现的语义**：`disable`、`constant`、主关键字、`keysecondary` + `selectiveLogic`
  （AND_ANY / NOT_ALL / NOT_ANY / AND_ALL）、`keyregex`、`caseSensitive`、`matchWholeWords`
  （按 ST 的 `\W` 边界，CJK 算边界）、`probability` + `useProbability`、`delay`、
  互斥组（按 `groupWeight` 加权抽取，支持 `groupOverride` 与逗号分隔多组名）、`order` 排序、token 预算。
  概率与分组抽取使用**确定性种子**（play id + 轮次），同一轮内多次组装结果一致，不会抖动 prompt 缓存。
- **世界书未实现的语义**（字段会解析并往返保真，但不影响激活，不要以为它生效）：
  递归扫描（`excludeRecursion` / `preventRecursion` / `delayUntilRecursion`）、
  定时效果（`sticky` / `cooldown`）、逐条 `scanDepth`、`vectorized`、各 `match*` 扫描源开关、
  `position` 放置位置（全部渲染进同一个块）、`role`。
- 世界书扫描使用最近 12 条消息的文本（与 ST 的 scan depth 语义近似）。
- 角色卡中的 `mes_example` 暂未注入提示词（作为后续增强）。
- 非 PNG 头像（jpg / webp / gif）无法嵌入导出的 PNG 人物卡（需要转码）；导出会回退为空白图，
  并在响应头 `x-tavern-avatar: omitted-unsupported-format` 中说明。
- 「酒馆极简模式」预设由插件写入用户预设目录；若部署关闭用户预设根
  （agent-presets `includeUserRoot: false`）或预设被删除导致挂载失败，新建剧本会失败
  （旧剧本恢复不受影响，仅记录告警）。
- 重试/切换（swipe）每条分支最多保留 12 次尝试，超出后最旧的会被丢弃；
  每次重试/编辑都会 fork 一个新 DSH 会话，旧会话日志留在磁盘上暂不回收。
- `lib/client.js` 实际是 CJS，而包声明 `"type": "module"`。它只由浏览器端的
  `__ModuleLoader__` 加载，Node 从不解析它，因此目前无影响；若将来需要被 Node `import`，
  需改名为 `.cjs`。
