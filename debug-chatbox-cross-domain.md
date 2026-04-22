# [OPEN] chatbox-cross-domain

## Symptom
- Chat 面板里出现了不符合预期的 `Thinking` 文本和 `Cross-domain link discovered` 文本。
- 这些内容看起来像前端渲染流中的异常注入或错误分类，而不是正常 assistant 回复。

## Expected
- `thinking` 内容应只出现在受控的折叠块中。
- 非 assistant 正文的运行时日志不应混入正文渲染流。

## Hypotheses
- H1: 某个前端库或 Webview 运行时错误被 `window.error` 捕获后，以普通消息流形式注入了聊天正文。
- H2: `stderr` / `stdout` 合流后，某些 agent 元信息被错误地当作 assistant 正文输出。
- H3: `thinkingStart` / `thinkingEnd` 与新的 `<details>` 注入逻辑存在重复路径，导致额外文本节点残留。
- H4: Markdown 渲染前的预处理逻辑错误识别了普通文本，触发了非预期 HTML 结构或链接处理。
- H5: 某段工具执行日志在进入 `processLine()` 时没有被识别为 tool/thinking/status，而是落入了默认正文分支。

## Plan
- 仅添加运行时埋点，不改业务逻辑。
- 记录 `stdout/stderr`、`processLine` 分类结果、`streamChunk` 注入内容、Webview error 事件。
- 让用户复现一次后，根据证据决定最小修复方案。

## Evidence
- `trae-debug-log-chatbox-cross-domain.ndjson:10` 显示 `processLine` 收到原始行 `"[Thinking] Cross-domain link discovered"`。
- `trae-debug-log-chatbox-cross-domain.ndjson:11` 显示这行内容进入了 `emitAssistantText`，因此被当成 assistant 正文渲染。
- `trae-debug-log-chatbox-cross-domain.ndjson:6` 显示 `thinking` 正文与 `╰─ done thinking` 出现在同一行，原逻辑会直接关闭 thinking 块并丢失该行正文部分。

## Conclusion
- H1 rejected: 不是 `window.error` 导致的普通报错文本注入。
- H2 inconclusive: 当前证据未证明它一定来自 `stderr`，但已证明它来自 agent 流文本本身。
- H3 partially confirmed: thinking 的新旧 UI 路径曾有重复，已先清掉旧占位。
- H4 rejected: 这次的 `Cross-domain link discovered` 不是 markdown 误渲染的根因，而是正文分类错误。
- H5 confirmed: `processLine()` 未识别 `[Thinking] ...` 形式，落入默认正文分支。

## Fix
- 把 `[Thinking] ...` 归类成折叠的 thinking 块，而不是正文。
- 处理 `thinking正文 + done thinking标记` 在同一行的情况，先输出正文再关闭折叠块。
