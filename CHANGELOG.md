# Changelog

## 0.1.1 — DSH 0.2.2-rc.3

### Compatibility

- 最低宿主版本更新为 `>=0.2.2-rc.3 <0.3.0`。
- 按当前 Host Inspect 契约为导演与角色的 `agents.create/resume` 透传 `reasoningEffort`；保持 Host 半仅依赖 `node:` 运行时模块。
- 确认 rc.3 Web 平台模块表提供 `@deepseek-ai/dsh-client-store`，明确列入构建外置项；改用 tsdown 的 `deps.neverBundle`。
- 已检查安装版升级索引中的 Chat activity `context` 与归档工作树变更。插件无 activity 穷尽映射、不创建工作树，无需对应代码改写。未使用账号、Forge、Office、CUA 或终端相关变更的 API。

### Fixed

1. 经典模式补充规则的角色名统一去除宿主模板宏，避免 `unknown prompt variable`。
2. 正则主关键词命中后继续执行二级关键词和全部 selectiveLogic 条件。
3. 相同优先级世界书条目按选书顺序、书内索引稳定排序。
4. 默认模型推理强度传入导演与角色的创建/恢复请求。
5. JSON 请求体统一校验为非 null、非数组对象，人物卡解码错误返回 400。
6. 超出 16 MiB 的请求返回 413 后关闭连接，避免提前 reset socket；超限后不再累积请求块。
7. 批量角色落盘尝试结束后传播 AggregateError；TauriTavern 三类导入分别按逐条落盘结果计数并记录固定失败 issue，失败文件可重试。
8. 头像使用 `<id>--<sha256>.<ext>` 不可变版本名，HTTP 保存按每角色串行执行暂存、JSON 提交和旧图清理；失败保留原 JSON 与原头像，兼容旧文件名。
9. 内嵌世界书导出将 canonical 控制字段映射回 extensions，保留未知扩展，并读取扩展中的 keyregex/addMemo。
10. 前端刷新只发布最新请求的结果，忽略过期错误及卸载后结果，避免轮询与操作刷新相互覆盖。
11. 聊天 JSONL 跳过 null、数组和其他非对象记录，继续处理后续有效消息。

### Tests and data

- 新增 `scripts/verify/audit-regressions.mjs`：23 项确定性回归测试，已接入 `verify:regressions`，随 `verify` 与 `verify:ci` 执行。
- 初始缺陷回归测试曾复现 14 个失败；修复后全部通过，并补充推理强度、乱序刷新、成功头像提交与并发失败保护测试。
- 旧资料库格式不变；无需删除、重写整个资料库或迁移 profile 配置。
- 新头像名提供缓存版本隔离。崩溃或独立暂存调用可能留下孤立图片，本版不全盘清理，以保留回滚和数据恢复机会。
- 本轮验证覆盖构建、类型、真实 HTTP、落盘/reload、真实 Cordis/Session 基础类和 agent 契约替身；未调用真实模型，也未安装到用户 profile 或进行 GUI 端到端验收。
