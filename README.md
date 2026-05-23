# Context Pack

## 中文

Context Pack 是一个本地优先的开发者工具。它会根据“开发任务 + 代码仓库”，生成一份给 AI 编程助手使用的上下文包。

它适合配合 Codex、Cursor、Claude Code、Copilot coding agent 等工具使用。

### 它会生成什么

- 相关文件列表
- 实现计划
- 风险点
- 推荐验证命令
- 可直接复制给 AI coding agent 的 Prompt
- PR 描述草稿
- Markdown 和 JSON 输出

### 本地使用

要求：

- Node.js 18+
- Git，推荐
- ripgrep，可选，扫描更快

运行：

```bash
node bin/context-pack.mjs --task "Add GitHub OAuth login" --repo /path/to/your/repo
```

输出文件：

```text
/path/to/your/repo/.context-pack/context-pack.md
/path/to/your/repo/.context-pack/context-pack.json
```

只打印 Prompt：

```bash
node bin/context-pack.mjs --task "Explain the auth flow" --repo /path/to/your/repo --print prompt
```

可选 AI 增强：

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

没有 API key 时也能使用本地启发式生成。

### GitHub Action

在其他仓库中创建 `.github/workflows/context-pack.yml`：

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

      - uses: your-github-name/context-pack@v1
        with:
          comment-pr: true
```

发布前记得打 tag：

```bash
git tag v1
git push origin main --tags
```

### 检查

```bash
npm run check
```

## English

Context Pack is a local-first developer tool. It turns a development task plus a repository into a focused context pack for AI coding agents.

It works well with Codex, Cursor, Claude Code, Copilot coding agent, and similar tools.

### What It Generates

- Relevant files
- Implementation plan
- Risk notes
- Suggested validation commands
- Agent-ready prompt
- PR description draft
- Markdown and JSON outputs

### Local Usage

Requirements:

- Node.js 18+
- Git, recommended
- ripgrep, optional for faster scanning

Run:

```bash
node bin/context-pack.mjs --task "Add GitHub OAuth login" --repo /path/to/your/repo
```

Output files:

```text
/path/to/your/repo/.context-pack/context-pack.md
/path/to/your/repo/.context-pack/context-pack.json
```

Print only the prompt:

```bash
node bin/context-pack.mjs --task "Explain the auth flow" --repo /path/to/your/repo --print prompt
```

Optional AI refinement:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

Without an API key, Context Pack still works with local heuristics.

### GitHub Action

Create `.github/workflows/context-pack.yml` in another repository:

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

      - uses: your-github-name/context-pack@v1
        with:
          comment-pr: true
```

Before publishing, create a tag:

```bash
git tag v1
git push origin main --tags
```

### Check

```bash
npm run check
```

## License

MIT
