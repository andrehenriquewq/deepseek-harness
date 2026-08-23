# git/ — Git 仓库状态能力家族

[English](README.md) | 中文

该能力家族回答"这个目录当前在哪个分支上"，覆盖宿主可达的任意路径，并在被观察期间报告变化，且绝不改动仓库。两个包均为**产品**包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`git-state/`](git-state/README.zh.md) | 定义 Service Provider 与 Consumer 共享的确定状态词汇。 | `ctx.gitState` |
| [`git-state-local/`](git-state-local/README.zh.md) | 通过本地 `git` 可执行文件解析，并监听仓库元数据的变化。 | （注册 `ctx.gitState`） |

解析委托给 Git 本身，从不手工解析 `.git` 文件，因此链接工作树、打包引用与 commondir 间接都能正确解析。观察按解析出的仓库做引用计数，同一工作树上的并发调用者共享同一个 watcher。
