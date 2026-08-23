# Agent Note: Antigravity 代理搜索提供方

Status: implemented

[English](2026-08-23-antigravity-proxy-search-provider.md) | 中文

## 问题

DeepSeek Harness 此前只有一条搜索路由（`web-search-deepseek`），每次搜索都计入所配置的 DeepSeek API 凭据。运行本地 Antigravity 代理——一个兼容 OpenAI 的中继，背后是 Google Antigravity Cloud Code 后端、其 Gemini 模型以 Google Search grounding 为回答提供依据——的操作者希望由该 grounding 来支撑 `web_search`，完全不经过 DeepSeek API。

## 决策

`packages/web/web-search-antigravity/` 是 `ctx.web` seam 上的第四个搜索提供方，沿用其 Exa 与 Perplexity 兄弟包相同的 Service Provider 形态：每次搜索对应一次辅助模型调用（`POST {baseURL}/chat/completions`），生成的答案映射为 `content`，转发的 Google Search grounding chunk（`groundingMetadata.groundingChunks[].web`）映射为 `sources`。它在两处有意偏离兄弟包：

- **空的 `apiKey` 仍然可用。** Exa 与 Perplexity 因 API 必须有密钥而将 `available()` 与凭据存在性绑定；本地 Antigravity 代理通常无需鉴权，因此这里的可用性只取决于配置形状。
- **来源只来自结构化 grounding 元数据；缺失时返回来源为空的成功结果。** 兼容 OpenAI 的聊天形状没有可移植的方式来强制要求服务端 Search 工具，各代理是否转发 `groundingMetadata` 也各不相同，所以诚实的契约是尽力映射而非报错——但绝不会从答案正文中抓取引用链接。

该提供方不挂载在随发行的基础组合中；DeepSeek 路由仍是默认值，Antigravity 路由仅作为个人组合 overlay 记录在文档里，因为通过 Antigravity 代理执行搜索会在其预期客户端之外消耗 Google 账户配额，并可能违反其服务条款。

## 已考虑的替代方案

- **复用现有提供方指向代理** —— 每个兄弟包的线上格式都固定于单一厂商的 API；没有一个能讲兼容 OpenAI 的聊天加 Gemini grounding 元数据。
- **做一个按厂商参数化的通用「grounded chat」提供方** —— 只有一个具体消费者的投机抽象；因 current-owner 规则被否决。
- **回退到从答案文本提取 markdown 链接** —— 会让 seam 编造提供方从未返回过的来源；依据 deepseek 先例（报错或返回空而非抓取）被否决。

## 后果

搜索可以完全跑在本地代理上、不涉及 DeepSeek API，代价是每次查询消耗一次 Google 账户配额上的辅助模型调用。「零来源」结果与真正无来源的回答无法区分，这对搜索是可接受的（模型仍收到有依据的回答文本），但意味着操作者无法在不查看代理日志的情况下区分「代理剥离了元数据」和「确实没有结果」。如果未来某代理需要显式 tool 字段才能强制 grounding，诚实的做法是把它放进提供方中立的 seam 字段，而不是本包的配置。
