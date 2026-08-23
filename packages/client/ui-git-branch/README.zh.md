# @deepseek-ai/dsh-client-ui-git-branch

[English](README.md) | 中文

浏览器侧插件，渲染会话头部的 Git 分支 chip：当前展示会话的工作目录所在分支。它注册进既有的 `conversation.session.header.actions` 列表 slot（`id: 'git-branch'`、`order: -12`），与 agent-preset 标签并列 —— 不改 slot 契约，不新增席位。

状态来自 [`@deepseek-ai/dsh-client-runtime`](../runtime/README.zh.md) 的 `ctx.gitState`，它镜像 Host 按"活跃会话 cwd"推送的 `host/git-state-changed` 帧。本插件是纯读取者：按会话自身 cwd 选择一条记录并渲染，因此不同仓库中的并发会话各自显示自己的分支，更新无需用户操作。

## 行为

- **缺席即缺席** —— 所有非分支状态（无仓库、不可读、解析中、会话没有 cwd）都完全不渲染：没有骨架、没有预留宽度、没有控制台噪音。常见的非仓库工作区布局与未安装本插件的部署完全一致。
- **可区分的标记** —— chip 携带客户端构建版本徽章所没有的分支图形；即使分支名恰好长得像提交号也一样显示。分离 HEAD 额外显示大写 "Detached HEAD" 标记和虚线边框。
- **高压下仍可读** —— 过长名称用 CSS 省略号截断；原生 `title` 在悬停和键盘聚焦时暴露完整名称。
- **设计上不可交互** —— 无激活可供性、无点击动作、无按钮语义。

## 已知限制与延后工作

- **只覆盖被跟踪路径** —— 共享状态映射中只有被某个活跃会话报告为 cwd 的目录；任意路径选择器需要基于同一 runtime 域的独立 Consumer。
- **没有手动刷新** —— 时效跟随 Host 的监听/轮询节奏；下拉刷新等可供性延后到有真实工作流提出时再做。
