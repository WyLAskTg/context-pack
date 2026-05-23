#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { createContextPack } from "../lib/contextPack.mjs";
import { renderMarkdown } from "../lib/renderMarkdown.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const task = String(args.task || "").trim();
  if (!task) {
    console.error("Missing required --task value.\n");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const repoPath = path.resolve(String(args.repo || process.cwd()));
  const includeDiff = args.diff !== false;
  const maxFiles = Number(args.maxFiles || 12);
  const outputDir = path.resolve(repoPath, String(args.outDir || ".context-pack"));
  const jsonPath = args.json === false ? "" : path.resolve(repoPath, String(args.json || path.join(outputDir, "context-pack.json")));
  const markdownPath = args.markdown === false ? "" : path.resolve(repoPath, String(args.markdown || path.join(outputDir, "context-pack.md")));

  const pack = await createContextPack({
    repoPath,
    task,
    includeDiff,
    maxFiles
  });

  const markdown = renderMarkdown(pack);

  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(pack, null, 2));
  }

  if (markdownPath) {
    await writeFile(markdownPath, markdown);
  }

  printResult(pack, {
    jsonPath,
    markdownPath,
    print: args.print || "summary",
    markdown
  });
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--help" || current === "-h") {
      parsed.help = true;
      continue;
    }

    if (current === "--no-diff") {
      parsed.diff = false;
      continue;
    }

    if (current === "--no-json") {
      parsed.json = false;
      continue;
    }

    if (current === "--no-markdown") {
      parsed.markdown = false;
      continue;
    }

    if (current.startsWith("--")) {
      const [rawKey, inlineValue] = current.slice(2).split("=", 2);
      const key = toCamelCase(rawKey);
      const value = inlineValue ?? argv[index + 1];

      if (inlineValue === undefined) {
        index += 1;
      }

      parsed[key] = value;
      continue;
    }

    if (current === "-t" || current === "-r") {
      const key = current === "-t" ? "task" : "repo";
      parsed[key] = argv[index + 1];
      index += 1;
      continue;
    }

    if (!parsed.task) {
      parsed.task = current;
    }
  }

  return parsed;
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function printResult(pack, output) {
  if (output.print === "none") return;
  if (output.print === "prompt") {
    console.log(pack.agentPrompt);
    return;
  }
  if (output.print === "markdown") {
    console.log(output.markdown);
    return;
  }
  if (output.print === "json") {
    console.log(JSON.stringify(pack, null, 2));
    return;
  }

  console.log("Context Pack generated");
  console.log(`Summary: ${pack.summary}`);
  console.log(`Relevant files: ${pack.relevantFiles.length}`);
  if (output.markdownPath) console.log(`Markdown: ${output.markdownPath}`);
  if (output.jsonPath) console.log(`JSON: ${output.jsonPath}`);
}

function printHelp() {
  console.log(`Context Pack

Generate an AI coding-agent context pack from a local repository.

Usage:
  node bin/context-pack.mjs --task "Add GitHub OAuth login" --repo .

Options:
  -t, --task <text>          Development task to prepare context for.
  -r, --repo <path>          Repository path. Defaults to the current directory.
      --max-files <number>   Number of relevant files to include. Default: 12.
      --out-dir <path>       Output directory inside the repo. Default: .context-pack.
      --json <path>          JSON output path. Default: .context-pack/context-pack.json.
      --markdown <path>      Markdown output path. Default: .context-pack/context-pack.md.
      --no-json              Skip JSON output.
      --no-markdown          Skip Markdown output.
      --no-diff              Do not include git diff facts.
      --print <mode>         summary, prompt, markdown, json, or none. Default: summary.
  -h, --help                 Show help.

Optional AI refinement:
  Set OPENAI_API_KEY and optionally OPENAI_MODEL in your environment.
`);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
