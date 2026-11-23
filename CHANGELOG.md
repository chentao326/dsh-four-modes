# Changelog

所有值得注意的变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-23

首个公开版本。

### Added

- 输入框工具栏模式 chip（`conversation.input.left` 槽位）：显示当前模式，点击展开四项菜单，当前项打勾。
- `/mode` 命令：`list`、`<id|别名|显示名|前缀>`、`next`。
- 四种内置模式切换：标准（`standard`）、PTC（`code`，别名 `ptc`）、极简（`minimal`）、创造（`cordis`）。
- 按名册自适应 preset id：精确 id → 别名 → 显示名（中/英）→ 前缀，兼容 `ptc` ↔ `code` 的版本漂移。
- 安全护栏：turn 执行中拒绝切换、per-Session 串行化、`recompose` 半失败按实际组合补记事件、`append` 失败自动补记。
- 按模式记忆模型（含推理强度），切换时自动应用；菜单内显示记忆的模型名。
- 自定义 preset 会列在四个内置模式之后，可直接切换。
- 菜单视口自适应（空间不足反向展开）、portal 渲染、Escape/点击外部关闭、乐观更新。
- 87 项自动化测试：Host 26、名册 32、Client 7、真实 Chrome DOM 集成 22。
