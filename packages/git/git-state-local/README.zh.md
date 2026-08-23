# @deepseek-ai/dsh-git-state-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-git-state`](../git-state/README.zh.md) seam 在 [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.zh.md) 服务之上的本地 Service Provider：`LocalGitStateService` 询问本地 `git` 二进制（`rev-parse --git-dir`、`--abbrev-ref HEAD`、`--short HEAD`）而不是手工解析 `.git`，因此链接工作树、打包引用与 commondir 间接都能正确解析。变化检测监听仓库元数据，并在监听不可用处退化为间隔重解析。解析与观察绝不写入目标仓库。

包根导出默认与具名的 `LocalGitStateService` 插件及其 `Config`。

## Config

```yaml
- id: git-state
  name: '@deepseek-ai/dsh-git-state-local'
  config:
    watchDebounceMs: 150    # coalesces filesystem events before one re-resolution pass
    pollIntervalMs: 5000    # fallback re-resolution interval where watching is unavailable
```

## 行为

- **解析委托给 Git** —— 先探测仓库发现（`--git-dir`）再解析 HEAD，使"普通非仓库"与"损坏元数据"可区分：发现失败且本地存在 `.git` 条目时报告 `unavailable` 而非 `no-repository`。分离检出打上 `detached` 标签并携带缩写提交号；调用者无需解析标识符即可区分状态。
- **监听以解析出的仓库为键，而非调用者** —— 观察按 Git common directory 共享同一 entry（跨调用者引用计数），entry 监听各自工作树的 git-dir 目录。监听目录而非 `HEAD` 文件很关键：Git 通过 rename 原子替换 `HEAD`，某些平台上这会静默切断针对文件的监听。被观察路径尚无仓库时，entry 监听路径本身，从而能看到之后的 `git init`。
- **退化而非沉默** —— 监听注册可能抛错（沙箱部署），存活监听也可能失败；两者都只把该仓库退化为按 `pollIntervalMs` 的间隔重解析，其他仓库保持事件驱动。每次文件系统事件风暴都被去抖为一次重解析（`watchDebounceMs`），因为 Git 每个操作会多次写元数据。
- **只读保证** —— 解析只运行 `rev-parse`（只读 porcelain 查询）；观察只增加文件系统监听。完整观察生命周期不会创建或修改任何 ref、index 条目、锁文件、配置或工作树内容 —— 由针对真实仓库的字节级对比测试证明。
- **不阻塞关机** —— 卸载同步关闭 watcher 并清除定时器；组合销毁后仍恢复的在途续体映射为 unavailable 状态，而不是跨越 teardown 抛出。

## 已知限制与延后工作

- **只在被观察目录本身看到仓库创建** —— 在被观察路径的父目录执行 `git init` 在其他事件或轮询到来前不可见；规格定义的转换覆盖的是在被跟踪目录本身的初始化。
- **悬空 `.git` 指针按损坏处理** —— 记录的 gitdir 不存在的 `.git` 文件报告 `unavailable` 而非 `no-repository`；两者都是确定状态且都不会伪造分支名。
- **固定操作界限** —— 单次调用截止（10s）、kill 宽限（1s）与收集输出上限是常量而非配置：它们约束的是毫秒级只读查询的病态情形，不是部署延迟。
