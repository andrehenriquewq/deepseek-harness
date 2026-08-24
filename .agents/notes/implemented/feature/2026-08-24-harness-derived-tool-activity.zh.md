# Agent Note: Harness-derived tool activity

Status: implemented

[English](2026-08-24-harness-derived-tool-activity.md) | 中文

## Problem

把模型撰写的 `description` 从 `bash`、`pwsh` 与 `run_code` 中移除后，Gemini 系模型不再出现「宣布了一次调用却始终没有发出它」的情况（[只有前言的工具调用](../bug-fix/2026-08-22-preamble-only-tool-calls.zh.md)）。但这同时也拿走了 UI 关于 `run_code` 程序在做什么的唯一一句话：一个运行中的程序只显示自己源码的第一行，之后无论调用多少工具都不再有任何提示。

能说出更多的素材本就已入日志、也本就可展示，且完全不需要模型参与。每次子派发都会追加 `tool/code-dispatch-start` 与 `tool/code-dispatch`，携带工具 `name` 以及 bridge 派发的那份 JSON 规范化 `arguments`；而多数工具已经声明了纯函数 `presentCall`/`presentResult`，正是把这些参数变成卡片（[render intent 联合类型](../architecture/2026-07-02-tool-render-intent-union.zh.md)）。Host 只为 `tool/call` 与 `tool/result` 计算这些 view，于是子调用到达客户端时 `callView: null`、`resultView: null`——没有 read 窗口、没有 diff、没有终端卡片、没有声明的标签——父级也就无话可报。

## Decision

展示从调用本身推导，且就在已经为原生调用推导展示的那个接缝上完成。

[`dsh-host-apiproxy`](../../../../packages/host/apiproxy/src/api-proxy.ts) 中的 `viewFor` 为另外两类事件解析 `ToolEventView`。`tool/code-dispatch-start` 用事件自带的 `arguments` 运行所命名工具的 `presentCall`；`tool/code-dispatch` 用同一份参数加上结算的 `content`/`isError` 运行 `presentResult`。两者都不需要原生 `tool/result` 所需的 call/result 配对，因为这两个事件本身就携带参数。既有的软降级覆盖所有落空情形：没有 presenter 就没有 view；presenter 抛错也没有 view；客户端有文档记载的通用卡片负责兜底。

折叠这对派发事件的两个 Conversation Node 定义——[chat](../../../../packages/client/ui-conversation/src/client/conversation-nodes/tool.ts) 与 [trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts)——像它们本来对 root 调用那样，为 child 调用读取 `match.view`；child 的结算也像 root 一样保留待处理阶段的 `callView`。

[`dsh-client-ui-tool`](../../../../packages/client/ui-tool/src/client/tool/models/tool-call-model.ts) 中的两处推导把这些变成行内文本。未归类的行改用工具声明的 call view 标题作摘要，不再是 wire 名称加一个原始参数；已归类的行保留由参数推导的摘要，因为它给出的正是标题与图标说不出的那个具体值。`subCallActivity` 用运行中父调用最新一个尚未结算的 child 来报告它，标签取自该 child 声明的 view，没有则取该 child 自己那一行由参数推导的摘要。没有 child 的父调用，以及所有已结算的父调用，都保留自己的摘要。

面向模型的契约未变，并保持最小：`run_code` 只收 `code`，`bash` 与 `pwsh` 收一条命令加执行器选项。任何只为展示服务的属性都不得加回——[schema 测试](../../../../packages/core/tools/tests/code-mode.spec.ts)逐字锁定每个属性列表，因此这类字段会在抵达模型之前先让测试失败。

## 子派发的结算事件不带结果元数据

`tool/code-dispatch` 记录子调用面向模型的结果（`content` + `isError`），不带 `meta`。因此从结果元数据投影卡片的 presenter——`grep`/`glob` 的 search 卡片、`read` 的行窗口——对子调用返回空，子调用回退为承载同样文本的通用正文。始终生效的是 call view，携带活动标签的也正是它。

把 `meta` 穿进派发日志，等于为了 UI 把工具私有的展示载荷写入一个持久事件，而这条日志本就会为体积较大的子调用内容做外溢处理。call 一侧已经回答了这次退化真正涉及的问题。

## Alternatives considered

**把展示写进 `tool/code-dispatch-start` 的载荷。** 派发事件是持久会话日志，而 render intent 不是。view 由投递时已注册的 presenter 重新计算，并刻意永不持久化，因此同一个事件在后续投递中可以携带不同的 view（或没有 view），UI 改版也无需改动格式。把它写进日志会把今天的卡片冻进每一个会话文件，并为一个显示问题抬升 `SESSION_FORMAT_VERSION`。

**在 UI 里根据工具名和参数推导出友好文案。** 一张把 `pnpm test` 映射成「正在跑测试」的表，是第二套展示实现，写死在一种语言里，且位于工具无法维护的地方——它还会对同一次调用给出与工具自身卡片不同的答案。工具本就拥有 `presentCall`；缺的只是没人为子调用去运行它。

**换个名字，保留一个可选的摘要字段。** 实测结果否决了这条路：模型看得见的字段就是它会去填的字段，而填它正是 Gemini 系模型停下来的地方。「可选」已经试过，并不够（[只有前言的工具调用](../bug-fix/2026-08-22-preamble-only-tool-calls.zh.md)）。

**再叫一次模型来给调用配文案。** 为了一行标签付出一次网络往返和一份 token 账单，而这个界面还必须在没有任何模型的会话日志回放中照样渲染。presenter 之所以是参数的纯函数，正是为了让回放与实时流保持一致。

## Consequences

`run_code` 程序现在渲染得像它发起的那些工具调用：每个子调用画出自己工具的卡片，父级行报告当前那一个。所有 provider 同等受益——这条路径上没有任何 Gemini 专属逻辑；唯一由 provider 驱动的约束是那份最小 schema，而每个模型都从中受益。

没有 presenter 的工具不受影响，仍渲染通用行；声明了 call view 的工具，现在会在未归类的行上看到自己的标题，取代原先的 wire 名称。`grep`、`glob` 与 `read` 的子调用在派发日志携带结果元数据之前，显示的是通用正文而非各自的结果卡片。

执行路径未被触碰：sandbox、code runtime、派发、权限、重试、工具结果与参数序列化都没有变化。新增的开销是投递路径上每个派发事件一次 presenter 调用，且位于既有的 try/catch 内。

## Testing

[Host view 套件](../../../../packages/host/apiproxy/tests/api-proxy-view.spec.ts)覆盖：一对子派发拿到其工具的卡片、没有 presenter 的子工具不带 view 投递、以及 presenter 抛错时软降级且不影响事件本身。两个 Conversation Node 套件覆盖 child 取到自己的 view 并在结算后保留它。[行模型套件](../../../../packages/client/ui-tool/tests/tool-row.client.spec.tsx)覆盖声明标题的优先级、标题为空或缺失时的回退，以及 `subCallActivity` 的每种情形，另有一个渲染用例验证 `run_code` 行从程序首行切换到 child 标签。`run_code`、`bash` 与 `pwsh` 的 schema 测试逐字锁定属性列表，作为退化守卫。

离线 `?fixture` 客户端只镜像 call 一侧：它的结果 presenter 按工具名给出作者写死的样例载荷，那些载荷描述的是各自轮次里的文件，而不是某次子调用实际接触的对象。
