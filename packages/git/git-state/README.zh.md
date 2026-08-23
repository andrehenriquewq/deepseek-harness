# @deepseek-ai/dsh-git-state

[English](README.md) | 中文

Git 仓库状态能力 seam（`ctx.gitState`）的 Service Definition：解析一个目录路径当前所在分支（或分支缺失的情况），并在调用者持有观察期间报告该答案的变化。本 seam 拥有四态确定词汇（`named-branch` / `detached` / `no-repository` / `unavailable`）、请求/规格拆分（`resolve()` 显式应用所有默认值；`run()` / `attach()` 只接收已解析的规格）以及只读保证。Git 机制与监听策略属于提供方；本地实现见 [`@deepseek-ai/dsh-git-state-local`](../git-state-local/README.zh.md)。

包根导出默认与具名的 `GitStateService` 类，以及 `./types` 中的状态/请求词汇。

## 行为

- **每次解析恰好一个确定状态** —— 任何路径都解析为 `named-branch`、`detached`、`no-repository` 或 `unavailable`；不存在歧义结果，封闭联合的 switch 可以 `assertNever` 收尾。
- **绝不向调用者抛出** —— 路径缺失、目录不可读、git 二进制不可用、仓库元数据损坏都会解析为携带诊断原因的 `unavailable`；观察者异步调用且绝不重入。
- **观察有界且必然释放** —— `attach()` 返回幂等的 disposer，释放该观察获取的所有宿主资源；宿主关机时在不阻塞关机的前提下释放仍未释放的观察。

## 已知限制与延后工作

- **只关心分支身份** —— 脏状态、领先/落后计数、stash 与冲突指示不在本 seam 范围内。
- **没有写路径** —— checkout、建分支或分支选择器将是带独立安全故事的独立 Consumer；本 seam 契约上就是只读。
