# Agent Note：Git 仓库状态 seam 与会话头部分支 chip

Status: implemented

[English](2026-08-23-git-repository-state-seam.md) | 中文

## 问题

Agent 会在会话进行中创建并切换 Git 分支，而用户看到的界面上没有任何东西标明工作正落在哪个分支上。UI 中唯一长得像版本控制的元素是 `DSH_CLIENT_COMMIT_HASH` —— 客户端构建自身的提交号，跨会话恒定 —— 这恰好引诱出最错误的推断。同时侧边栏可能并存多个不同仓库的会话，回答"这是哪个分支"必须离开应用。

任何方案都要同时满足三件事：在真实工作区会遇到的布局上保持正确（链接工作树、打包引用、分离 HEAD）、观察成本以"不同仓库数"而非"打开的会话数"为界、以及远程 Host 天然可用——因为浏览器碰不到文件系统。

## 决策

一个新的能力 seam 拥有"这条路径在哪个分支"的答案，按标准三角色拆分：

- **Service Definition** —— [`@deepseek-ai/dsh-git-state`](../../../../packages/git/git-state) 声明 `ctx.gitState`：`resolve(request): Spec`、`run(spec)`、返回 disposer 的 `attach(spec, observer)`。每次解析恰好产生四个标签之一——`named-branch`、`detached`、`no-repository`、`unavailable`——封闭联合的 switch 以 `assertNever` 收尾。本 seam 绝不向调用者抛错，也绝不写目标仓库。
- **Provider** —— [`@deepseek-ai/dsh-git-state-local`](../../../../packages/git/git-state-local) 经 `ctx.subprocess` 把每个问题都交给 `git` 二进制（`rev-parse --git-dir`、`--abbrev-ref HEAD`、`--short HEAD`）。仓库发现先于 HEAD 解析，使损坏元数据（发现失败且本地存在 `.git` 条目）报告 `unavailable` 而不是塌缩为 `no-repository`。观察 entry 以解析出的 Git common directory 为键做引用计数；各 entry 监听其工作树的 git-dir **目录**——而非 `HEAD` 文件，后者的原子 rename 替换会让针对文件的监听在 macOS 上静默失联。监听注册是可失败的：任何抛错或运行时错误都只把该仓库退化为间隔重解析。监听去抖与兜底轮询间隔是经过校验的 `Config` 字段。
- **Consumers** —— apiproxy 域（`gitState.resolve`）加上宿主对活跃会话 cwd 的跟踪推送 `host/git-state-changed` 帧；[`@deepseek-ai/dsh-client-runtime`](../../../../packages/client/runtime) 将其镜像进按 path 为键、由一元 resolve 播种的 store；[`@deepseek-ai/dsh-client-ui-git-branch`](../../../../packages/client/ui-git-branch) 向既有 `conversation.session.header.actions` slot 注册一个只读 chip（`order: -12`，与 agent-preset 标签并列）。

值得复述的产品规则：对每一个非分支状态——包括首次解析完成之前——chip 完全不渲染，也不预留宽度；分离 HEAD 带有大写标记和虚线边框，即便分支名恰好与构建徽章同名也能区分；分支文本绝不进入模型请求或会话日志（无 `SessionEventMap` 成员，无格式升级）。

## 备选方案

- **直接解析 `.git/HEAD`。** 最快、无子进程。否决：它重新实现工作树与 commondir 解析，而对信任指示器来说，显示错误分支比不显示更糟。
- **以轮询 `git rev-parse` 作为主机制。** 沙箱友好且简单。作为主机制被否决：足够省的轮询必然滞后于 agent 自己的 checkout——这正是动机场景。它作为监听失败处的按仓库兜底保留下来。
- **引入 Git 库依赖。** 否决：所有候选都会拖入对象存储实现，只为回答二进制几毫秒就能回答的一个问题。
- **Host 端每会话一个 watcher。** 记账简单，但同一工作树上的 N 个会话持有 N 个 watcher 并把同一变化报告 N 次。按 common directory 引用计数把成本约束到不同仓库数上。
- **在每会话 mux 流上发布分支状态。** 会迫使宿主把一次文件系统事件扇出到多条会话帧，并向共享仓库的每个会话重复相同状态。以 path 为键的宿主级帧让各消费者自行选择自己的条目。

## 后果

线上新增了一个可加性 RPC 方法和一个 host 帧；回滚就是卸载三个 bundle 行。没有该域的远程 Host 退化为 unavailable 状态而非连接错误，客户端将其映射为同样的静默缺席渲染。监听现在在 macOS 上使用递归 FSEvents、其他平台回退平铺监听，且 watcher 创建移出 cordis 事件栈——这些来之不易的细节连同测试一起留在 `startWatch` / `ensureWatch` 里。明确放弃的：在被观察路径的**父目录**发生 `git init` 在其他事件或轮询到来前不可见；悬空 `.git` 指针归类为损坏（`unavailable`）而非缺失；两种状态都不会伪造分支名。
