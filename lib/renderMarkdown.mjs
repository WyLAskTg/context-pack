export function renderMarkdown(pack) {
  const files = pack.relevantFiles.length
    ? pack.relevantFiles.map((file) => `| ${file.score} | \`${escapeTable(file.path)}\` | ${escapeTable(file.reason)} |`).join("\n")
    : "| - | - | No high-confidence files found. |";

  return [
    "# Context Pack",
    "",
    `**Task:** ${pack.task}`,
    "",
    `**Mode:** ${pack.aiMode}`,
    "",
    "## Summary",
    "",
    pack.summary,
    "",
    "## Architecture Notes",
    "",
    ...pack.architectureNotes.map((item) => `- ${item}`),
    "",
    "## Relevant Files",
    "",
    "| Score | File | Why |",
    "| ---: | --- | --- |",
    files,
    "",
    "## Implementation Plan",
    "",
    ...pack.implementationPlan.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Validation",
    "",
    ...pack.validationCommands.map((command) => `- \`${command}\``),
    "",
    "## Risks",
    "",
    ...pack.risks.map((item) => `- ${item}`),
    "",
    "## Agent Prompt",
    "",
    "<details>",
    "<summary>Expand prompt</summary>",
    "",
    "```text",
    pack.agentPrompt,
    "```",
    "",
    "</details>",
    "",
    "## PR Draft",
    "",
    "```markdown",
    pack.prDescription,
    "```"
  ].join("\n");
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
