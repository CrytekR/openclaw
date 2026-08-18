# Tokenizer Threshold 上下文引擎

面向 OpenClaw `v2026.6.6` 线的 **bundled context engine**。插件**自己拥有**阈值压缩（`ownsCompaction: true`），用本地 `js-tiktoken` 计数，在不抢 session write lock 的前提下，把 mid-loop / 回合内的 prompt 压到固定阈值以下。

---

## 目标与定位

| 目标                       | 做法                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| 固定阈值触发压缩           | 本地 tiktoken：`messages + 缓存的 system prompt` ≥ `thresholdTokens`         |
| Mid-loop 缩小下一轮 prompt | `assemble()` 直接返回压缩后的消息列表                                        |
| 不抢写锁                   | 不调用 `delegateCompactionToRuntime`；不在 `assemble`/`afterTurn` 里改 JSONL |
| 保留尾对齐原生             | 移植 agent-core `findCutPoint` / `keepRecentTokens`（默认 20000）            |
| 给 host 记 checkpoint      | `compact()` 返回 `tokensBefore` / `tokensAfter` / `summary`                  |

启用本插件后，OpenClaw 运行时对该 run **关闭**原生 in-attempt 自动 compaction（由 `ownsCompaction: true` 接管）。

---

## 启用与配置

在 `openclaw.json`（或等价配置）中：

```json5
{
  plugins: {
    slots: {
      contextEngine: "tokenizer-threshold",
    },
    entries: {
      "tokenizer-threshold": {
        enabled: true,
        // 非 bundled 安装若要用 llm_input 缓存 system prompt，必须打开：
        // hooks: { allowConversationAccess: true },
        config: {
          thresholdTokens: 113000,
          encoding: "cl100k_base",
          keepRecentTokens: 20000,
        },
      },
    },
  },
}
```

修改 slot、插件配置或插件源码后，请 **重启 gateway**。若跑的是已构建的 `dist`，还需重新 `pnpm build`。

### 配置项

| 字段               | 类型   | 默认          | 说明                                                                                    |
| ------------------ | ------ | ------------- | --------------------------------------------------------------------------------------- |
| `thresholdTokens`  | 正整数 | `113000`      | 本地估计达到该值时触发压缩。应低于模型上下文窗口，并预留回复/工具输出余量               |
| `encoding`         | 枚举   | `cl100k_base` | `js-tiktoken` 编码：`cl100k_base` \| `o200k_base` \| `p50k_base` \| `r50k_base`         |
| `keepRecentTokens` | 正整数 | `20000`       | 压缩后从**最新一端**保留的近似 verbatim token 预算（与 agent-core `findCutPoint` 一致） |

约束：

- 若 `keepRecentTokens >= thresholdTokens`，插件会自动夹到 `thresholdTokens - 1`（至少为 1），给摘要前缀留空间。
- 建议：`keepRecentTokens` ≪ `thresholdTokens` ≪ 模型窗口。

---

## 生命周期（三条主路径）

```text
llm_input ──► 缓存 system prompt（按 sessionId / sessionKey）
                 │
 mid-loop / 回合开始
                 ▼
            assemble()  ──► 超阈值则返回 [摘要 user 消息] + 保留尾
                 │
            （模型调用 / 工具循环）
                 ▼
            afterTurn() ──► 超阈值则刷新引擎视图；有 llm 时可升级摘要
                 │
 host 调用（overflow / /compact / budget）
                 ▼
            compact()   ──► 返回 CompactResult，供 host 写 checkpoint
```

### 1. `assemble`（prompt 视图）

- **输入**：当前会话 `messages`（**不含** OpenClaw system prompt 正文；system 在独立字段里）。
- **行为**：
  - 读取进程内缓存的 system prompt（若有）。
  - 估计：`count(messages) + count(systemPrompt)`。
  - 低于 `thresholdTokens`：原样返回 `messages`。
  - 达到阈值：按 `findCutPoint` 切分 → 摘要 + 连续保留尾；必要时再做尾部 window。
  - 消息侧预算 = `thresholdTokens - systemPromptTokens`，避免「消息压到阈值内、加上 system 又超」。
- **输出**：
  - `messages`：可能已压缩的列表（**仍不含** system；host 另行注入）。
  - `estimatedTokens`：压缩后消息 + 缓存 system（有缓存时）。
  - 可选 `systemPromptAddition`（memory 相关追加，与阈值计数无关）。
- **不写** transcript / `sessions.json`。

### 2. `afterTurn`（回合或 mid-loop 工具后）

- 用同样的本地估计做门控；低于阈值直接返回。
- 超阈值时刷新**进程内**压缩视图。
- 若 host 在 `runtimeContext.llm` 提供了 `complete`，且当前前缀尚无 LLM 摘要，则尝试 LLM 摘要并写入缓存；失败则回退抽取式摘要。
- **不**自行写 `sessions.json` 的 Comped / compaction 计数；那些由 host 在调用 `compact()` 成功后维护。

### 3. `compact`（host 显式压缩）

- 供 overflow、`/compact`、budget 等路径使用。
- 优先用 `runtimeContext.messages`；若无，则复用 `assemble`/`afterTurn` 已准备好的内存状态。
- 成功时返回：
  - `result.tokensBefore` / `tokensAfter` / `summary`
  - `details.checkpointTrigger`：`path: "context_engine"`, `trigger: "threshold"` 等诊断字段
- 可与 run abort / 安全超时的 `abortSignal` 配合。

---

## Token 如何计算

### 计入本地门控的

1. **会话 `messages`**：user / assistant / toolResult 等，用 tiktoken 数文本（每条另加少量 framing `+4`）。
2. **缓存的 system prompt**：来自同插件注册的 `llm_input` hook；同样 tiktoken + framing。

### 明确不计入的

| 项目                                   | 原因                                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| Tools JSON schema                      | 不在 system 正文，也不在 `assemble` 入参；引擎合约拿不到           |
| Provider wrapper / 隐藏头              | 不可见                                                             |
| 图片等非文本载荷                       | 当前计数器只抽文本字段                                             |
| Host `currentTokenCount`（usage 快照） | 会滞后、在大 tool 后跳变，且与 tiktoken 不一致；**故意不用**做门控 |

### System prompt 缓存（`llm_input`）

Context engine 合约**读不到** system 正文。本插件在 `register` 里额外挂：

```ts
api.on("llm_input", (event, ctx) => {
  rememberSystemPrompt({
    sessionId: event.sessionId,
    sessionKey: ctx.sessionKey,
    systemPrompt: event.systemPrompt,
  });
});
```

- 缓存键：`sessionId` 与 `sessionKey`（有则双写）。
- **时机**：`llm_input` 在「即将调模型」时触发；同轮**第一次** `assemble` 往往早于首次 `llm_input`，新会话首拍可能仍是「仅 messages」。
- **权限**：bundled 默认可用；非 bundled 需  
  `plugins.entries["tokenizer-threshold"].hooks.allowConversationAccess: true`。

---

## 压缩切分逻辑（`findCutPoint`）

对齐 `packages/agent-core/.../compaction.ts` 的 keep-tail，在 **AgentMessage[]** 上实现：

1. 从列表**尾部**向前累加本地 token，直到约 `keepRecentTokens`。
2. 落到**合法切点**：可切在 `user` / `assistant` / 若干 harness 角色上；**绝不**切在 `toolResult` 上（避免拆开 tool call / result 对）。
3. 若切点落在一轮中间（非 user 开头），标记 `isSplitTurn`：该轮前缀进入可摘要区，尾部从合法 `firstKept` 起连续保留。
4. 组装形态：

```text
[ user 消息：原生包装的 <summary>...</summary> ]
+ messages[firstKept … end]   // 连续 verbatim 尾
```

5. 摘要来源：
   - **抽取式**（默认，`assemble` 无 LLM）：截断拼接早期消息文本。
   - **LLM**（`afterTurn`/`compact` 且 `runtimeContext.llm` 可用）：升级同一 summarizable 指纹的摘要并缓存。
6. 若「摘要 + 保留尾」仍超过**消息侧预算**，对保留尾做 trailing window；仍不够则整表 trailing window 兜底。

进程内状态（`session-state`）按 session 记住：压缩后消息、摘要、指纹、`tokensBefore`/`tokensAfter`、是否来自 LLM，供后续 `assemble` 复用与 `compact` 回报。

---

## 与原生 compaction / 其它路径的关系

| 对比项        | 本插件                                    | 原生阈值 compaction                             |
| ------------- | ----------------------------------------- | ----------------------------------------------- |
| 触发依据      | 本地 tiktoken（messages + 缓存 system）   | 多为 provider `usage`（已含 system/tools）      |
| Mid-loop      | `assemble` 缩小 prompt 视图               | 默认靠 turn 末 / overflow；可选 midTurnPrecheck |
| 写 transcript | `assemble`/`afterTurn` 不写 JSONL         | 成功 compact 会落盘摘要等                       |
| Comped 计数   | 仅 host 调 `compact()` 成功后由 host 更新 | host/runtime 路径更新                           |
| Tools schema  | 本地估计不含                              | usage 通常已含                                  |

本插件压缩的是**发给模型的 messages 视图**，不是静默改写磁盘上的完整会话树（除非 host 再走 `compact` + rewrite 合约）。

---

## 运维建议

1. 用 `/context detail` 看 system、tools schema、bootstrap 大概体积，再设 `thresholdTokens`（例如：窗口 − 固定开销 − `keepRecentTokens` − 回复余量）。
2. 模型换家族时考虑换 `encoding`（如偏 OpenAI 新模型可试 `o200k_base`）；与账单仍可能有几个百分点误差。
3. 改插件后**必须重启 gateway**；否则仍跑旧注册逻辑。
4. 调试：确认 slot 已切到 `tokenizer-threshold`；非 bundled 时确认 `allowConversationAccess`；观察首轮后 system 缓存是否生效（首 `assemble` 可能仍偏乐观）。

---

## 文件结构（实现索引）

| 路径                             | 职责                                            |
| -------------------------------- | ----------------------------------------------- |
| `index.ts`                       | 插件入口：`llm_input` + `registerContextEngine` |
| `src/config.ts`                  | 配置解析与默认值                                |
| `src/engine.ts`                  | `assemble` / `afterTurn` / `compact`            |
| `src/compact-logic.ts`           | 阈值门控 + 调用原生风格组装                     |
| `src/cut-point.ts`               | `findCutPoint` 消息列表移植                     |
| `src/native-compact-assemble.ts` | 摘要包装 + 保留尾 + window 兜底                 |
| `src/tokenizer.ts`               | js-tiktoken 计数                                |
| `src/system-prompt-cache.ts`     | `llm_input` system 缓存                         |
| `src/session-state.ts`           | 进程内压缩视图                                  |
| `src/llm-summary.ts`             | 可选 LLM 摘要升级                               |
| `openclaw.plugin.json`           | 清单 / schema / UI hints                        |

---

## 测试

```bash
./node_modules/.bin/vitest run extensions/tokenizer-threshold
# 或
node scripts/run-vitest.mjs extensions/tokenizer-threshold
```

---

## 已知限制（摘要）

1. 新会话第一次 `assemble` 可能尚未缓存 system prompt。
2. Tool JSON schema、附件/图片、provider wrapper 不计入本地估计。
3. `assemble` 压缩不自动增加 Comped；需 host 调用 `compact()`。
4. 与 provider 真实 tokenizer 不完全一致；门控偏保守或偏激进都可能，应用 `/context` 与实机 usage 校准阈值。
