# Context Pack

[English](README.en.md)

Context Pack 可根据开发任务和本地代码仓库，生成一份给 AI 编程助手（如Codex, Cursor, Claude, Copilot）使用的上下文包。

## 功能

- 扫描本地仓库，找出和任务相关的文件
- 生成实现计划、标记可能的风险和验证建议
- 输出可复制给 AI coding agent 的 Prompt 和 Markdown 报告

## 本地使用方法

要求：

- Node.js 18+
- Git，推荐
- ripgrep，可选，扫描更快

运行：

```bash
node bin/context-pack.mjs --task "Add GitHub OAuth login" --repo /path/to/your/repo
```

输出：

```text
/path/to/your/repo/.context-pack/context-pack.md
/path/to/your/repo/.context-pack/context-pack.json
```

只打印 Prompt：

```bash
node bin/context-pack.mjs --task "Explain the auth flow" --repo /path/to/your/repo --print prompt
```

## GitHub Action

在你的仓库中创建 `.github/workflows/context-pack.yml`：

```yaml
name: Context Pack

on:
  pull_request:

permissions:
  contents: read
  issues: write

jobs:
  context-pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: WyLAskTg/context-pack@v1
        with:
          comment-pr: true
```
