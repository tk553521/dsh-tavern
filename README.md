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
| 角色卡 / 世界书 / 预设 | 存入 DSH 的 **settings 服务**（`ctx.settings`，`$DSH_HOME` 下的持久化文档）；角色头像 PNG 存到 `$DSH_HOME/tavern/avatars/`，settings 只保存相对路径 |
| 角色扮演提示词 | 创建会话时通过 agent setup 装配：角色卡组成 **system prompt 的 persona 槽位**（`deployment:persona`，complete），同名遮蔽预设固定 persona |
| 世界书注入 | 注册为 agent 的 **动态 prompt context**：每次组装按最近消息做关键词激活（SillyTavern 规则：constant / probability / depth / group / selective） |
| 开场白 | 以 **session seed**（平衡的 completed-turn 事件序列）写入会话日志 |
| 前后端通信 | 库管理走 DSH 进程内的 HTTP 插件扩展点（`ctx.webServer` 前缀路由 `/tavern`，由 dsh-host-webserver 提供，非独立端口/进程） |
| 重启恢复 | 播放记录持久化在 settings；重新打开时通过 `ctx.agents.resume` 恢复导演/角色会话，历史完整保留 |

## 功能

- **酒馆标签**：位于「对话」（order 0）、「轨迹」（order 10）右侧（order 20），会话作用域视图。
- **会话隔离**：酒馆会话（导演/角色）创建与恢复后自动归档，不显示在「对话」页/工作区，聊天只在酒馆页内进行。
- **默认极简预设**：酒馆会话默认挂载**「酒馆极简模式」agent 预设**——与 DSH `minimal` 预设同款组合（持久 bash + 编辑器），但开启 `includeRuntimeContext` 以保留世界书等动态注入；预设由插件写入 `$DSH_HOME/.agent-presets/tavern/`（幂等、不覆盖用户编辑）。
- **人物卡**：导入 SillyTavern / TauriTavern 人物卡 —— PNG 卡（`chara`/`ccv3` tEXt 块，Base64 编码）与 JSON 卡（v1 / v2 / v3），编辑角色设定，导出 PNG 卡，头像提取。
- **世界书**：导入/导出 ST 世界书 JSON（entries 为对象或数组均可），条目编辑（关键词、内容、常驻、启用），扮演时按关键词自动激活注入。
- **预设**：导入/导出 ST 预设 JSON（temp、top_p、rep_pen、max_tokens 等映射到 DSH 模型路由与采样参数）。
- **本地 TauriTavern 导入**：在「酒馆 → 导入」填写本地 TauriTavern 安装目录（例如 `E:\TauriTavern`），批量导入原始数据目录中的人物卡、世界书与预设。
- **多 agent 扮演**：导演 + 角色 agent 各自独立；世界书自动注入；开场白自动播种。
- **经典模式**：关闭多 agent 时，导演一体扮演所有角色（「角色名：」前缀分行）。
- **样式跟随 DSH**：界面基于 DSH 的 `--dsw-*` 设计令牌（`ui-theme`），自动跟随 DSH 亮色/暗色切换；导航栏「样式」可切换为「经典酒馆」暗金配色（偏好持久化在 settings）。

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
- `pnpm typecheck`：宿主与客户端两个独立 TypeScript 程序（避免宿主/客户端 Context 声明合并冲突）。
- 类型解析：`tsconfig.*.json` 的 `paths` 将 `@deepseek-ai/*` 指向本地 dsh 安装
  （`node_modules/@deepseek-ai` 目录链接或 npx 缓存路径）；npm registry 上的
  `@deepseek-ai/*` 多为旧版 rc，不要用作类型来源。
- 宿主半零 `@deepseek-ai` 运行时依赖（settings schema 为手写 Standard-Schema 可调用对象），
  因此安装后无需额外解析 DSH 包。

## 已知限制

- 角色/世界书/预设库的浏览与编辑通过 `/tavern` 前缀路由与宿主通信（DSH 官方插件 HTTP 扩展点）；
  若未来 DSH 提供插件级 RPC 注册机制，可平滑迁移。
- 世界书激活使用最近 12 条消息的文本扫描（与 ST 的 scan depth 语义近似），
  高级 ST 选项（vectorized、正则键、分组轮换等）部分保留字段但未完全实现语义。
- 角色卡中的 `mes_example` 暂未注入提示词（作为后续增强）。
- 「酒馆极简模式」预设由插件写入用户预设目录；若部署关闭用户预设根
  （agent-presets `includeUserRoot: false`）或预设被删除导致挂载失败，新建剧本会失败
  （旧剧本恢复不受影响，仅记录告警）。
