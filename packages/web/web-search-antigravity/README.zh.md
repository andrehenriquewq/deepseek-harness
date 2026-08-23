# @deepseek-ai/dsh-web-search-antigravity

[English](README.md) | 中文

一个由 [Antigravity](https://github.com/google/antigravity) 代理支撑的 `WebSearchProvider`，服务于 harness 的 [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用本地代理兼容 OpenAI 的 `POST /chat/completions` 端点；每次搜索都是一次辅助模型调用，后端的 Gemini 通过 Google Search grounding 在服务端完成检索。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（那是 `@deepseek-ai/dsh-tool-web`）。与 Exa、Perplexity 兄弟包一样，它是注册自身后端的函数／命名空间插件（`inject: ['web']`），而非 default-export 服务。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$ANTIGRAVITY_API_KEY` | 供需要鉴权的代理使用的 Bearer 令牌。为空时不发送 `authorization` 头且仍然可用——本地代理通常无需鉴权。 |
| `baseURL` | `http://127.0.0.1:8080/v1` | 代理端点基址；自动追加 `/chat/completions`。无法解析的值会使提供方不可用。 |
| `model` | `gemini-3-flash` | 作为聊天 `model` 字段发送的模型名；必须是代理可用的、支持 Search grounding 的 Gemini 模型。 |
| `maxTokens` | `1024` | 生成的回答 token 上限（`max_tokens`）。必须为正整数。 |

```yaml
- id: web-search-antigravity
  name: '@deepseek-ai/dsh-web-search-antigravity'
  config:
    baseURL: 'http://127.0.0.1:8080/v1'
```

在自己的组合 overlay 中，将 `@deepseek-ai/dsh-web` 行的 `searchProvider` 设为 `antigravity` 即可把 seam 指向该提供方。

## 映射

生成的回答成为 `content`。来源只来自转发的 Google Search grounding 元数据：响应包络上的 `groundingMetadata.groundingChunks[]` 将每个 chunk 的 `web.uri` 映射为 `url`、`web.title` 映射为 `title`；没有 URI 的 chunk 被丢弃。有依据的回答若未附带转发元数据，则是来源为空的有效结果——绝不会从回答正文中提取引用链接。固定系统指令请求启用 grounding，但是否真正执行取决于代理及其账户配额。提供方失败（HTTP 错误、网络失败、无法解析或形状错误的响应体）表现为 `WebError` `WEB_PROVIDER_ERROR`；中止的请求表现为 `WEB_ABORTED`。HTTP 重定向在接触 `Location` 目标之前即被拒绝，表现为 `WEB_PROVIDER_ERROR`。

## Model Experience

间接地，通过 [`dsh-tool-web`](../tool-web/README.zh.md)：它在 consumer 的错误包装下保留本提供方生成的回答以及 grounding chunk 的 URL 和标题，或其确切的 `Antigravity search aborted`、`Antigravity search request failed: <error>`、`Antigravity proxy returned an unprocessable response body: <error>` 失败信息；提供方私有字段不会进入上下文。

#### KV Cache 效应

无直接失效；请求前缀的任何变化由具名的 consumer 负责。

## 已知限制与推迟的工作

- **Grounding 元数据的转发取决于代理** —— 丢弃包络上 `groundingMetadata` 的代理仍能给出良好回答，但返回零来源，因为从回答正文中抓取引用链接会让 seam 说谎。
- **无法从这里强制启用 grounding** —— 兼容 OpenAI 的聊天形状没有可移植的方式来要求服务端 Search 工具；如果某个代理需要显式 tool 字段，那属于 Service Definition 变更，将推迟到提供方中立的 seam 字段。
- **非官方上游访问** —— 通过 Antigravity 代理执行搜索会在其预期客户端之外消耗 Google 账户配额，可能违反其服务条款；请将该路由保留在个人组合中。
