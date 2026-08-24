# Tokenizer Threshold 上下文引擎

面向 OpenClaw `v2026.6.6` 线的 **bundled context engine**。插件**自己拥有**阈值压缩（`ownsCompaction: true`），用 Python **`transformers`** 加载 **DeepSeek-V4-Flash** tokenizer 做本地计数。

**设计选择（当前）：只在 `assemble` 里做超限检查与压缩。**  
摘要优先走插件闭包里的 `api.runtime.llm.complete`；失败或不可用时回退抽取式摘要。  
`afterTurn` **故意空操作**，避免与 mid-loop `assemble` 重复压缩或抢跑第二次 LLM。

---

## 目标与定位

| 目标                       | 做法                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| 固定阈值触发压缩           | Python transformers：`messages + system + tools schema` ≥ `thresholdTokens`                   |
| 只在 prompt 路径压缩       | **仅 `assemble()`** 检查并返回压缩后的消息列表                                                |
| LLM 摘要                   | `api.runtime.llm.complete`（register 时惰性解析），非 `runtimeContext.llm`                    |
| Mid-loop 缩小下一轮 prompt | 工具循环里 host 再次调用 `assemble`                                                           |
| 不抢写锁                   | 不调用 `delegateCompactionToRuntime`；不在 `assemble` 里改 JSONL                              |
| 保留尾对齐原生             | 移植 agent-core `findCutPoint` / `keepRecentTokens`（默认 20000）                             |
| 给 host 记 checkpoint      | `compact()` 复用 `assemble` 已建好的内存视图，返回 `tokensBefore` / `tokensAfter` / `summary` |

启用本插件后，OpenClaw 运行时对该 run **关闭**原生 in-attempt 自动 compaction（由 `ownsCompaction: true` 接管）。

---

## 依赖（Python）

Gateway 主机需要可用的 Python 3，并安装：

```bash
pip install -r extensions/tokenizer-threshold/python/requirements.txt
```

**默认 tokenizer 已打包在插件内**（`python/bundled/deepseek-v4-flash/`，约 6MB：`tokenizer.json` + `tokenizer_config.json`），运行时用 `local_files_only=True` 加载，**不联网**。

刷新打包文件（维护者，需网络一次）：

```bash
python3 extensions/tokenizer-threshold/python/download_bundled_tokenizer.py
```

若把 `tokenizerModel` 改成其他 HF id（非 `deepseek-v4-flash` / 非已存在本地目录），才会走 Hugging Face 下载。Node 侧通过持久 Python worker（stdin/stdout JSONL）计数；Vitest 默认用 chars/4 stub，不启动 Python。Node 22+/24 下 pipe 的公开 `.fd` 为 `undefined` 且 fd 为非阻塞，插件通过 libuv handle 取 fd 并对 `EAGAIN` 重试，保持同步计数 API。

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
          tokenizerModel: "deepseek-v4-flash", // 默认：插件内 bundled，离线
          pythonPath: "python3",
          keepRecentTokens: 20000,
        },
      },
    },
  },
}
```

修改 slot、插件配置或插件源码后，请 **重启 gateway**。若跑的是已构建的 `dist`，还需重新 `pnpm build`。

### 配置项

| 字段               | 类型   | 默认                | 说明                                                                                    |
| ------------------ | ------ | ------------------- | --------------------------------------------------------------------------------------- |
| `thresholdTokens`  | 正整数 | `113000`            | 本地估计达到该值时，`assemble` 触发压缩。应低于模型上下文窗口，并预留回复/工具输出余量  |
| `tokenizerModel`   | 字符串 | `deepseek-v4-flash` | 默认用插件内 bundled tokenizer（离线）。也可给本地目录或其他 HF model id                |
| `pythonPath`       | 字符串 | `python3`           | 运行 `python/token_counter_server.py` 的解释器                                          |
| `keepRecentTokens` | 正整数 | `20000`             | 压缩后从**最新一端**保留的近似 verbatim token 预算（与 agent-core `findCutPoint` 一致） |

约束：

- 若 `keepRecentTokens >= thresholdTokens`，插件会自动夹到 `thresholdTokens - 1`（至少为 1），给摘要前缀留空间。
- 建议：`keepRecentTokens` ≪ `thresholdTokens` ≪ 模型窗口。

---

## 生命周期

```text
llm_input ──► 缓存 system prompt（sessionId / sessionKey）
                 │
 回合开始 / mid-loop 工具后
                 ▼
            assemble()
                 ├─ 未超限 → 原样返回 messages
                 └─ 超限 → api.runtime.llm.complete 摘要（失败则抽取式）
                           → [summary user] + keepRecentTokens 连续尾
                 │
            afterTurn()  ──► 空操作（不压缩）
                 │
 host overflow / /compact / budget
                 ▼
            compact()  ──► 优先复用 assemble 内存状态；或压缩 runtimeContext.messages
```

### `assemble`（唯一压缩入口）

1. 读取缓存的 system prompt（若有）。
2. 估计：`count(messages) + count(systemPrompt)`。
3. **低于** `thresholdTokens`：返回原始 `messages`。
4. **达到**阈值：
   - 若同一 summarizable 指纹已有 LLM 摘要 → 复用；
   - 否则调用 `resolveLlmComplete()` → `api.runtime.llm.complete` 生成摘要；
   - LLM 不可用/失败 → 抽取式摘要；
   - `findCutPoint` 切分 + 组装；消息侧预算 = `thresholdTokens - systemPromptTokens`。
5. 写入进程内 `session-state`，供后续 `assemble` 复用与 `compact` 回报。
6. **不写** transcript / `sessions.json`。

注意：`assemble` 在「下一轮模型调用前」执行；其中的 LLM 摘要会**增加延迟与费用**。这是本设计的显式取舍。首次（或 worker 重启后）会加载 bundled tokenizer（本地磁盘，不联网）。压缩摘要开头会写明本地 token 数、阈值，以及本会话 context engine **第 N 次**触发压缩（同一 summarizable 指纹复用时不递增）。

### `afterTurn`

空实现。不读阈值、不调 LLM、不更新压缩状态。

### `compact`

- 有 `runtimeContext.messages`：用与 `assemble` 相同的 LLM/抽取式逻辑压一次，供 host 强制压缩。
- 否则：返回最近一次 `assemble` 成功写入的内存视图（`tokensBefore` / `tokensAfter` / `summary` / `details.checkpointTrigger`）。
- **不**依赖 `runtimeContext.llm`；LLM 统一走插件的 `api.runtime.llm`。

---

## Token 如何计算

### 计入本地门控

1. **会话 `messages`**：transformers tokenizer + 每条 framing `+4`。
2. **缓存的 system prompt**：来自同插件 `llm_input` hook。
3. **缓存的 tools JSON schema**：来自同插件 `llm_input.tools`（与 OpenClaw 展示的 provider prompt 对齐的关键缺口）。

### 不计入

| 项目                      | 原因                     |
| ------------------------- | ------------------------ |
| Provider wrapper / 图片等 | 不可见或未抽文本         |
| Host `currentTokenCount`  | 滞后；门控用本地实时估计 |

> 若曾出现「阈值设 64k，OpenClaw 显示约 130k 才压」：旧版未计 tools schema。升级后应接近 `/status` 的 Context 数；首次 `llm_input` 前仍可能偏矮。

### Tokenizer 失败时可感知

Python worker 启动/计数失败时**不再静默**：

1. Gateway 日志：`api.logger.warn`（约 30s 冷却），提示安装 `transformers` 并用 `~chars/4` 估算。
2. 压缩摘要触发语追加：`（注意：本地 tokenizer 不可用，当前为估算值。）`
3. `compact` 结果 `details.tokenizerDegraded: true`（若已降级）。

失败回退从「按空白分词」改为 `~chars/4`（对中文更稳；仍只是估算）。

### System prompt 缓存

```ts
api.on("llm_input", (event, ctx) => {
  rememberSystemPrompt({
    sessionId: event.sessionId,
    sessionKey: ctx.sessionKey,
    systemPrompt: event.systemPrompt,
  });
});
```

- 新会话**第一次** `assemble` 可能早于首次 `llm_input`，首拍可能仍是「仅 messages」。
- 非 bundled 需：`hooks.allowConversationAccess: true`。

### LLM 旁路（assemble）

```ts
api.registerContextEngine("tokenizer-threshold", () =>
  createTokenizerThresholdContextEngine({
    config,
    resolveLlmComplete: () => {
      const complete = api.runtime?.llm?.complete;
      return typeof complete === "function"
        ? (request) => complete.call(api.runtime.llm, request)
        : undefined;
    },
  }),
);
```

- 惰性解析：register 时 runtime 可能尚未就绪，**在 assemble 调用时再取**。
- `assemble` 合约本身**不注入** `runtimeContext.llm`；这是插件主动使用 `api.runtime.llm`。

---

## 压缩切分逻辑（`findCutPoint`）

对齐 `packages/agent-core/.../compaction.ts` 的 keep-tail，在 **AgentMessage[]** 上：

1. 从尾向前累加 token，约 `keepRecentTokens`。
2. 合法切点：可切 `user` / `assistant` 等；**不切** `toolResult`。
3. 切在一轮中间时：前缀进摘要区，尾从 `firstKept` 连续保留。
4. 形态：`[user: <summary>…] + 连续尾`；仍超则 trailing window 兜底。

---

## 与「afterTurn 再压」旧方案的对比

|           | 当前（assemble-only）               | 旧方案（afterTurn 升级）             |
| --------- | ----------------------------------- | ------------------------------------ |
| 压缩时机  | 即将发给模型前（含 mid-loop）       | afterTurn 刷新 + assemble 用缓存     |
| LLM 来源  | `api.runtime.llm.complete`          | 多为 `runtimeContext.llm`            |
| afterTurn | 空                                  | 可能二次 LLM / 写状态                |
| 延迟      | 超限时 assemble 内多一次 completion | 摘要在 turn 末，下一轮 assemble 更轻 |

---

## 运维建议

1. 用 `/context detail` 估 system / tools schema，再设 `thresholdTokens`。
2. 接受：超限时 **assemble 会变慢**（等 LLM 摘要）；首次计数会从磁盘加载 bundled tokenizer。
3. 改插件后**重启 gateway**。
4. 若 LLM 摘要频繁失败，日志/行为上会静默回退抽取式（不打断工具循环）。
5. 离线调试可设 `TOKENIZER_THRESHOLD_STUB=1`（字符长度 stub）。

---

## 文件结构

| 路径                                   | 职责                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| `index.ts`                             | `llm_input` + 注册引擎 + 注入 `resolveLlmComplete`   |
| `src/engine.ts`                        | **仅 assemble 压缩**；afterTurn 空；compact 复用状态 |
| `src/compact-logic.ts`                 | 阈值门控 + 原生风格组装                              |
| `src/cut-point.ts`                     | `findCutPoint` 移植                                  |
| `src/native-compact-assemble.ts`       | 摘要包装 + 保留尾                                    |
| `src/tokenizer.ts`                     | TokenCounter + message/prompt counting               |
| `src/python-worker-ipc.ts`             | Sync JSONL bridge to Python worker (Node 22+/24 fds) |
| `python/token_counter_server.py`       | 持久 JSONL tokenizer 进程                            |
| `python/bundled/deepseek-v4-flash/`    | 离线 tokenizer 文件（默认）                          |
| `python/download_bundled_tokenizer.py` | 维护者刷新 bundled 文件                              |
| `python/requirements.txt`              | `transformers` 依赖                                  |
| `src/system-prompt-cache.ts`           | system 缓存                                          |
| `src/tools-schema-cache.ts`            | tools schema token 缓存（llm_input）                 |
| `src/session-state.ts`                 | 进程内压缩视图                                       |
| `src/llm-summary.ts`                   | 调 `llm.complete` 的摘要文案                         |
| `openclaw.plugin.json`                 | 清单 / schema                                        |

---

## 测试

```bash
./node_modules/.bin/vitest run extensions/tokenizer-threshold
```

---

## 已知限制

1. 新会话第一次 `assemble` 可能尚未缓存 system prompt。
2. Tool JSON schema 已从 `llm_input` 计入；首次 model call 前仍可能暂缺。
3. 附件、provider wrapper 等仍可能造成与 `/status` Context 的小偏差。
4. `assemble` 内 LLM 无 host 注入的 `abortSignal`（`compact` 路径可带 signal）。
5. `assemble` 压缩不自动增加 Comped；需 host 再调 `compact()`。
6. 默认 tokenizer 已 bundled；仅自定义其他 HF id 时才需要网络。
7. 需要本机 Python + `transformers`；worker 崩溃时 Node 回退空白分词计数。
