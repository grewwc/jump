# Chat Render Regression Checklist

Purpose: quick manual verification after any rendering/parser change in the chat panel.
Scope: table rendering, underscore handling, file-path link behavior, tool-output cleanup.
Estimated time: 2-4 minutes.

## Semi-automated workflow

Use these commands from workspace root:

```bash
npm run regression:prepare
```

This creates a timestamped run folder under `.tmp/regression-runs/<run-id>/` with:

- `prompts.md` (copy-paste prompts)
- `results.md` (pass/fail sheet)
- `results.json` (machine-readable status template)
- `run-meta.json` (git/version snapshot)

After finishing manual checks and taking screenshots:

```bash
npm run regression:collect -- --run <run-id> --screenshots <img1,img2> --logs <log1,log2> --notes "optional summary"
```

Notes:

- Screenshot/log paths can be absolute or workspace-relative.
- Collector also auto-copies `.dbg/*.log|*.ndjson|*.txt` if present.
- Output summary is written to `.tmp/regression-runs/<run-id>/artifact-summary.md`.

## Preconditions

- Open the AI Chat view in the extension.
- Start a new chat session.
- Keep one source file open in editor, for example src/chatPanel.ts.
- Use a model/agent that can return markdown and can call tools.

## Case 1: Markdown table should stay intact

Input prompt:

Please output exactly this markdown and nothing else:

| col_a | col_b |
|---|---|
| foo | bar |
| left | right |

Steps:

1. Send the prompt.
2. Wait for render to finish.

Expected:

- A valid rendered table is shown.
- First column is not shifted.
- No leading pipe is lost.
- No random escaping artifacts.

## Case 2: Underscore text should not become subscript

Input prompt:

Please output exactly these lines and nothing else:

snake_case_identifier
file_name_with_underscores.ts
cost_is_$5_not_math
path_like /tmp/a_b/c_d.ts

Then output one explicit math block:

$$E=mc^2$$

Steps:

1. Send the prompt.
2. Inspect plain text lines first, then math line.

Expected:

- Plain underscore text stays plain text.
- No accidental subscript rendering on normal lines.
- Explicit math block still renders as math.

## Case 3: File path links should be clickable

Input prompt:

Please output exactly these two paths on separate lines:

src/chatPanel.ts:100
/Users/bytedance/self-dev/jump/src/extension.ts:20

Steps:

1. Send the prompt.
2. Verify both paths are rendered as clickable links.
3. Click each link.

Expected:

- Click opens the target file in editor.
- Cursor jumps near the specified line.
- No malformed or partial link text.

## Case 4: Tool output should be clean (no decorative prefixes)

Input prompt:

Run execute_command with:
ls -la /Users/bytedance/self-dev/jump/src
Then show the command output.

Steps:

1. Send the prompt.
2. Expand tool output sections if collapsed.
3. Inspect multiple output lines.

Expected:

- No repeated decorative leading bars from stream wrappers.
- Normal command output is readable line by line.
- Tool status badges can appear, but output text itself is clean.

## Case 5: Mixed content should not cross-corrupt

Input prompt:

Output in this order:

1) A markdown table.
2) A plain text line with snake_case_value.
3) A file path src/historyProvider.ts:30.
4) A code block with bash command: ls -la

Steps:

1. Send the prompt.
2. Validate each section independently.

Expected:

- Table still valid.
- snake_case line not treated as math.
- Path is clickable.
- Code block syntax highlighting and copy button still work.

## Pass/Fail Template

Use this quick matrix after each run:

- [ ] Case 1 pass
- [ ] Case 2 pass
- [ ] Case 3 pass
- [ ] Case 4 pass
- [ ] Case 5 pass

If any case fails, capture:

- prompt used
- screenshot
- whether failure is deterministic
- first bad line shown in UI
