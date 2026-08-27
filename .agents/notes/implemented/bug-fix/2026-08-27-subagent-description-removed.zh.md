# Agent Note：移除 `subagent` 委派工具的 `description`

Status: implemented

[English](2026-08-27-subagent-description-removed.md) | 中文

## 问题

`subagent`（以及 `subagent_fork`）工具在 `prompt` 载荷之外一直保留着必填的 `description` 参数，而 `bash`、`pwsh`、`run_code` 的同名参数已在 [2026-08-22](2026-08-22-preamble-only-tool-calls.zh.md) 中移除。当时的 Note 刻意把这类「派发」工具留下：它们的摘要是 subagent 自身的持久创建标签，并非装饰。这使它们同样暴露于其他工具遭遇的「只有前言」残缺调用——Gemini 系列模型可能只发出 `{"description":"Check the README"}` 就停止，唯一的兜底是修复指令。

`description` 流向 [packages/subagent/tool-subagent/src/index.ts](../../../packages/subagent/tool-subagent/src/index.ts) 中的三个 label 位点：`request.label`（传给 `ctx.subagents.start`）、`ctx.subagents.startContinuable({label})`、`jobs.start({label})`。该 label 会成为 `OneShotSubagentDescriptorData.label` 以及会话/任务枚举使用的 `JobSnapshot.label`，因此移除该字段需要替代而非单纯删除。

## 决策

从 `subagent` 参数 schema 中移除 `description`，改为从 `prompt` 派生 label，对应 [packages/core/tools/src/code-mode.ts](../../../packages/core/tools/src/code-mode.ts) 中的 `runCodeTitle(args.code)`。新增的 `subagentLabel(prompt, fallback)` 辅助函数取 `prompt` 的第一行非空文本，超过 `SUBAGENT_LABEL_MAX_LENGTH`（72，与 `RUN_CODE_TITLE_MAX_LENGTH` 对齐）时以 `\u2026` 省略，`prompt` 为纯空白时回退到配置的 `toolName`。continuable 契约（`startContinuable({label: string})`）依然满足，因为 `prompt` 为 `required: true`，而回退覆盖了 schema 不拒绝的纯空白情形。

`subagent_fork` 工具是同一插件换了一个 `toolName`，因此一次改动同时覆盖两者。

## 证据

`tool-subagent` 单元测试覆盖了派生逻辑：单行 prompt 原样通过；多行 prompt 取第一行非空文本；过长 prompt 以 `\u2026` 省略；纯空白与空 prompt 回退到 `toolName`。capture-provider 测试断言所有用例下 `request.label` 等于派生值。schema 键测试确认模型可见参数现在为 `['prompt', 'run_in_background']`（禁用 background 时为 `['prompt']`）。

无密钥快照套件（`pnpm run test:snapshot`）刷新了 ACP、headless、JSON-RPC 示例树中所有 `subagent/descriptor` 的 label 与所有 `tool-schemas` 块；每处差异仅为移除的 `description` 参数，以及 label 从模型自撰摘要变为派生的 prompt 首行。

## 后果

`subagent` 与 `subagent_fork` 不再存在 `description`。读取该字段的组合读到的是任何调用都不再携带的字段：工具改为从 `prompt` 派生 `label`。本变更前的日志调用仍携带该字段；展示层忽略它，回放不受影响，与 [2026-08-22](2026-08-22-preamble-only-tool-calls.zh.md) 的 shell/code 调用先例一致。

转录中失去了派发调用上模型自撰的一行摘要。读者在会话与任务列表中看到的是任务 prompt 的首行，比摘要更直白、更少雕琢。continuable 描述符的持久创建标签由派生而来而非模型自撰；冷启动恢复与枚举不受影响，因为 label 仍是非空字符串。

`ToolArgsError.message` 与重复链 `ignoredArgumentKeys` 默认值未变：`description` 本就在默认忽略列表中，字段从 schema 移除后链键就只剩载荷。

## 备选方案

**固定回退 label（如 `"subagent"`）。** 否决：在会话与任务列表中失去子项之间的区分度，而 prompt 派生 label 几乎零成本地保留了该区分。

**让 `label` 在各处可选。** 否决：continuable 描述符与 `startContinuable` 契约要求非空 `label`，放弃该要求意味着契约变更并在服务边界而非工具层回退。在工具层派生保持服务契约不变。

**把 `description` 改名为 `label` 作为显式参数。** 否决理由同 2026-08-22 Note 否决可选 `description`：模型能看到的字段就是它会填的字段，而填它正是它停下之处。残缺只是搬家而非消失。
