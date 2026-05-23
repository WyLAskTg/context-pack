import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXCLUDED_DIRS = new Set([
  ".git",
  ".context-pack",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".md",
  ".mjs",
  ".php",
  ".prisma",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const IMPORTANT_FILE_NAMES = new Set([
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "Dockerfile"
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "into",
  "with",
  "this",
  "that",
  "these",
  "those",
  "then",
  "than",
  "when",
  "where",
  "what",
  "why",
  "how",
  "are",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "not",
  "but",
  "you",
  "your",
  "our",
  "their"
]);

export async function createContextPack(input) {
  const task = String(input.task || "").trim();
  if (!task) throw new Error("Task is required.");

  const repoPath = path.resolve(String(input.repoPath || ""));
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("Repository path must be an existing directory.");

  const maxFiles = clamp(Number(input.maxFiles || 12), 6, 24);
  const files = await listRepoFiles(repoPath);
  const git = await readGitFacts(repoPath, input.includeDiff !== false, {
    diffBase: input.diffBase,
    diffHead: input.diffHead
  });
  const importantFiles = await readImportantFiles(repoPath, files);
  const relevantFiles = await scoreRelevantFiles(repoPath, files, task, git.changedFiles, maxFiles);
  const localPack = buildLocalPack({
    repoPath,
    task,
    files,
    git,
    importantFiles,
    relevantFiles
  });

  return (await refineWithOpenAI(localPack, { task, importantFiles, relevantFiles })) || localPack;
}

async function listRepoFiles(repoPath) {
  const rgFiles = await runCommand("rg", [
    "--files",
    "--hidden",
    "-g",
    "!.git/**",
    "-g",
    "!.context-pack/**",
    "-g",
    "!node_modules/**",
    "-g",
    "!dist/**",
    "-g",
    "!build/**",
    "-g",
    "!.next/**",
    "-g",
    "!coverage/**"
  ], repoPath);

  if (rgFiles.ok && rgFiles.stdout.trim()) {
    return rgFiles.stdout
      .split(/\r?\n/)
      .map((item) => normalizePath(item.trim()))
      .filter(Boolean)
      .slice(0, 5000);
  }

  return (await walkFiles(repoPath)).slice(0, 5000);
}

async function walkFiles(root, dir = root, output = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = normalizePath(path.relative(root, absolute));

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        await walkFiles(root, absolute, output);
      }
      continue;
    }

    output.push(relative);
    if (output.length >= 5000) return output;
  }

  return output;
}

async function readGitFacts(repoPath, includeDiff, options = {}) {
  const isGitRepo = (await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!isGitRepo) {
    return {
      status: "No git status available.",
      diffStat: "",
      diffRange: "",
      changedFiles: [],
      recentCommits: []
    };
  }

  const status = await runGit(repoPath, ["status", "--short"]);
  const diffRange = normalizeDiffRange(options.diffBase, options.diffHead);
  const diffArgs = diffRange ? [diffRange] : [];
  const rangeChangedFiles = diffRange ? await runGit(repoPath, ["diff", "--name-only", ...diffArgs]) : "";
  const rangeDiffStat = includeDiff && diffRange ? await runGit(repoPath, ["diff", "--stat", ...diffArgs]) : "";
  const localChangedFiles = rangeChangedFiles || await runGit(repoPath, ["diff", "--name-only"]);
  const localDiffStat = includeDiff && !rangeDiffStat ? await runGit(repoPath, ["diff", "--stat"]) : "";
  const recentCommits = diffRange
    ? await runGit(repoPath, ["log", "--oneline", "-5", `${options.diffBase}..${options.diffHead}`]) || await runGit(repoPath, ["log", "--oneline", "-5"])
    : await runGit(repoPath, ["log", "--oneline", "-5"]);
  const gitStatus = [
    status || "Working tree clean.",
    diffRange ? `Diff range: ${diffRange}` : ""
  ].filter(Boolean).join("\n");

  return {
    status: gitStatus,
    diffStat: rangeDiffStat || localDiffStat,
    diffRange,
    changedFiles: localChangedFiles
      .split(/\r?\n/)
      .map((item) => normalizePath(item.trim()))
      .filter(Boolean),
    recentCommits: recentCommits
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function normalizeDiffRange(diffBase, diffHead) {
  const base = String(diffBase || "").trim();
  const head = String(diffHead || "").trim();
  if (!base || !head) return "";
  return `${base}...${head}`;
}

async function readImportantFiles(repoPath, files) {
  const selected = files
    .filter((file) => IMPORTANT_FILE_NAMES.has(path.basename(file)) || file.toLowerCase().includes("readme"))
    .slice(0, 12);

  const previews = await Promise.all(
    selected.map(async (file) => ({
      path: file,
      preview: await readPreview(path.join(repoPath, file), 2500)
    }))
  );

  return previews.filter((item) => item.preview.trim());
}

async function scoreRelevantFiles(repoPath, files, task, changedFiles, maxFiles) {
  const keywords = expandKeywords(tokenize(task));
  const changed = new Set(changedFiles.map(normalizePath));
  const candidates = files
    .filter(isLikelyTextFile)
    .map((file) => seedCandidate(repoPath, file, keywords, changed));

  const topPathMatches = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 300);

  const scored = await Promise.all(
    topPathMatches.map(async (candidate) => scoreByContent(candidate, keywords))
  );

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map((candidate) => ({
      path: candidate.path,
      reason: candidate.reasons.slice(0, 3).join("; ") || "Possible task match.",
      score: Math.round(candidate.score),
      preview: candidate.preview
    }));
}

function seedCandidate(repoPath, file, keywords, changed) {
  const lowerPath = file.toLowerCase();
  const basename = path.basename(lowerPath);
  const reasons = [];
  let score = 0;

  for (const keyword of keywords) {
    if (lowerPath.includes(keyword)) {
      score += basename.includes(keyword) ? 10 : 5;
      reasons.push(`Path matches "${keyword}"`);
    }
  }

  if (changed.has(file)) {
    score += 14;
    reasons.push("File has local git changes");
  }

  if (/(test|spec|e2e)\./i.test(file)) {
    score += keywords.includes("test") ? 8 : 2;
  }

  if (/(route|controller|api|server|handler)/i.test(file)) {
    score += keywords.some((keyword) => ["api", "server", "backend", "endpoint"].includes(keyword)) ? 8 : 2;
  }

  if (/\.(tsx|jsx|vue|svelte|css|scss|html|js|mjs)$/i.test(file)) {
    score += keywords.some((keyword) => ["ui", "page", "component", "screen", "style"].includes(keyword)) ? 8 : 2;
  }

  return {
    path: file,
    absolutePath: path.join(repoPath, file),
    score,
    preview: "",
    reasons
  };
}

async function scoreByContent(candidate, keywords) {
  const preview = await readPreview(candidate.absolutePath, 6000);
  const lower = preview.toLowerCase();
  let contentScore = 0;

  for (const keyword of keywords) {
    const count = countOccurrences(lower, keyword);
    if (count > 0) {
      contentScore += Math.min(count, 5) * 3;
      candidate.reasons.push(`Content mentions "${keyword}"`);
    }
  }

  return {
    ...candidate,
    score: candidate.score + contentScore,
    preview: preview.slice(0, 1000)
  };
}

function buildLocalPack(input) {
  const packageFile = input.importantFiles.find((file) => path.basename(file.path) === "package.json");
  const packageJson = parsePackageJson(packageFile?.preview);
  const commands = inferValidationCommands(input.files, packageJson);
  const repoName = path.basename(input.repoPath);
  const relevantList = input.relevantFiles.length
    ? input.relevantFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n")
    : "- No high-confidence files found yet.";

  const architectureNotes = inferArchitectureNotes(input.files, input.importantFiles);
  const risks = [
    "Relevant files are inferred from file paths, content snippets, and git state; confirm before editing.",
    input.git.status === "No git status available."
      ? "This path is not a git repository, so diff-aware context is unavailable."
      : "Existing local changes may affect implementation scope.",
    "Generated prompt should be treated as a starting point, not an approval to make broad unrelated refactors."
  ];

  const validationCommands = commands.length ? commands : ["Review project docs for the right validation command."];
  const implementationPlan = [
    "Read the relevant files and confirm the task boundary.",
    "Make the smallest change that satisfies the requested workflow.",
    "Update or add tests near the touched behavior.",
    `Run validation: ${validationCommands.join(" && ")}.`,
    "Prepare a PR description that calls out behavior, risks, and verification."
  ];

  const summary = `Context pack for "${input.task}" in ${repoName}. It found ${input.files.length} files and selected ${input.relevantFiles.length} likely relevant files.`;

  const agentPrompt = [
    "You are working in an existing repository. Use the context below to complete the task with minimal, well-tested changes.",
    "",
    `Task: ${input.task}`,
    `Repository: ${repoName}`,
    "",
    "Architecture notes:",
    architectureNotes.map((note) => `- ${note}`).join("\n"),
    "",
    "Likely relevant files:",
    relevantList,
    "",
    "Git status:",
    input.git.status,
    "",
    "Validation commands:",
    validationCommands.map((command) => `- ${command}`).join("\n"),
    "",
    "Constraints:",
    "- Preserve existing style and architecture.",
    "- Do not rewrite unrelated code.",
    "- Explain any test you could not run.",
    "- Return a concise change summary and verification notes."
  ].join("\n");

  const prDescription = [
    "## Summary",
    `- ${input.task}`,
    "- Updated the relevant implementation after reviewing the selected context.",
    "",
    "## Validation",
    ...validationCommands.map((command) => `- [ ] \`${command}\``),
    "",
    "## Risk",
    "- [ ] Confirmed no unrelated behavior changed."
  ].join("\n");

  return {
    repoName,
    repoPath: input.repoPath,
    generatedAt: new Date().toISOString(),
    task: input.task,
    aiMode: "local",
    summary,
    architectureNotes,
    implementationPlan,
    relevantFiles: input.relevantFiles,
    validationCommands,
    risks,
    git: input.git,
    agentPrompt,
    prDescription,
    rawFacts: {
      totalFiles: input.files.length,
      importantFiles: input.importantFiles
    }
  };
}

async function refineWithOpenAI(pack, input) {
  if (!process.env.OPENAI_API_KEY) return null;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "developer",
            content: [
              "You turn repository facts into practical coding-agent context packs.",
              "Return only valid JSON. Do not include markdown fences.",
              "Keep every file path exactly as provided.",
              "Do not invent commands, files, libraries, or test results.",
              "Prefer concise, implementation-ready language."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              expectedShape: {
                summary: "string",
                architectureNotes: ["string"],
                implementationPlan: ["string"],
                relevantFiles: [{ path: "string", reason: "string", score: 0, preview: "string" }],
                validationCommands: ["string"],
                risks: ["string"],
                agentPrompt: "string",
                prDescription: "string"
              },
              task: input.task,
              localPack: pack,
              importantFiles: input.importantFiles,
              relevantFiles: input.relevantFiles
            })
          }
        ],
        max_output_tokens: 3500
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with ${response.status}.`);
    }

    const data = await response.json();
    const text = extractResponseText(data);
    const parsed = parseJson(text);
    if (!parsed) return null;

    return {
      ...pack,
      aiMode: "openai",
      summary: stringOr(pack.summary, parsed.summary),
      architectureNotes: stringArrayOr(pack.architectureNotes, parsed.architectureNotes),
      implementationPlan: stringArrayOr(pack.implementationPlan, parsed.implementationPlan),
      relevantFiles: relevantFilesOr(pack.relevantFiles, parsed.relevantFiles),
      validationCommands: stringArrayOr(pack.validationCommands, parsed.validationCommands),
      risks: stringArrayOr(pack.risks, parsed.risks),
      agentPrompt: stringOr(pack.agentPrompt, parsed.agentPrompt),
      prDescription: stringOr(pack.prDescription, parsed.prDescription)
    };
  } catch (error) {
    console.warn("OpenAI refinement failed; falling back to local pack.", error);
    return null;
  }
}

function inferArchitectureNotes(files, importantFiles) {
  const notes = new Set();
  const has = (pattern) => files.some((file) => pattern.test(file));

  if (has(/package\.json$/)) notes.add("JavaScript or TypeScript project metadata is present.");
  if (has(/\.(tsx|jsx)$/)) notes.add("React-style UI files are present.");
  if (has(/next\.config\.(js|mjs|ts)$/)) notes.add("Next.js configuration is present.");
  if (has(/vite\.config\.(js|ts)$/)) notes.add("Vite configuration is present.");
  if (has(/server|api|routes|controllers/i)) notes.add("Backend or API-oriented paths are present.");
  if (has(/test|spec|e2e/i)) notes.add("Test files or test directories are present.");
  if (has(/pyproject\.toml|requirements\.txt$/)) notes.add("Python project metadata is present.");
  if (has(/go\.mod$/)) notes.add("Go module metadata is present.");
  if (has(/Cargo\.toml$/)) notes.add("Rust project metadata is present.");

  const readme = importantFiles.find((file) => file.path.toLowerCase().includes("readme"));
  if (readme) notes.add(`README detected at ${readme.path}; use it for product and setup context.`);

  return notes.size ? Array.from(notes) : ["No strong framework signal found from filenames alone."];
}

function inferValidationCommands(files, packageJson) {
  const commands = [];
  const packageManager = files.includes("pnpm-lock.yaml")
    ? "pnpm"
    : files.includes("yarn.lock")
      ? "yarn"
      : "npm";

  if (packageJson?.scripts) {
    for (const script of ["lint", "typecheck", "test", "build", "check"]) {
      if (packageJson.scripts[script]) {
        commands.push(packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`);
      }
    }
  }

  if (files.includes("pyproject.toml") || files.includes("requirements.txt")) commands.push("pytest");
  if (files.includes("go.mod")) commands.push("go test ./...");
  if (files.includes("Cargo.toml")) commands.push("cargo test");

  return Array.from(new Set(commands)).slice(0, 5);
}

function parsePackageJson(content) {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function readPreview(filePath, limit) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 500_000) return "";
    const content = await fs.readFile(filePath, "utf8");
    return content.slice(0, limit);
  } catch {
    return "";
  }
}

function isLikelyTextFile(file) {
  const ext = path.extname(file);
  return TEXT_EXTENSIONS.has(ext) || IMPORTANT_FILE_NAMES.has(path.basename(file));
}

async function runGit(repoPath, args) {
  const result = await runCommand("git", ["-C", repoPath, ...args], repoPath);
  return result.ok ? result.stdout.trim() : "";
}

async function runCommand(command, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: 6000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    });

    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function tokenize(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function expandKeywords(tokens) {
  const expanded = new Set(tokens);
  const groups = {
    auth: ["login", "oauth", "session", "user", "account"],
    login: ["auth", "oauth", "session", "user"],
    oauth: ["auth", "login", "provider", "callback"],
    bug: ["fix", "error", "exception", "issue"],
    fix: ["bug", "error", "test"],
    api: ["server", "route", "endpoint", "handler"],
    ui: ["page", "component", "screen", "style"],
    test: ["spec", "e2e", "assert", "mock"],
    database: ["db", "schema", "model", "migration"],
    ai: ["openai", "model", "prompt", "agent", "llm"]
  };

  for (const token of tokens) {
    for (const item of groups[token] || []) expanded.add(item);
  }

  return Array.from(expanded).slice(0, 40);
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";

  return data.output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    const first = value.indexOf("{");
    const last = value.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    try {
      return JSON.parse(value.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function stringOr(fallback, value) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArrayOr(fallback, value) {
  if (!Array.isArray(value)) return fallback;
  const next = value.filter((item) => typeof item === "string" && item.trim());
  return next.length ? next : fallback;
}

function relevantFilesOr(fallback, value) {
  if (!Array.isArray(value)) return fallback;
  const next = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      if (typeof item.path !== "string") return null;
      return {
        path: item.path,
        reason: typeof item.reason === "string" ? item.reason : "AI-selected relevant file.",
        score: typeof item.score === "number" ? item.score : 0,
        preview: typeof item.preview === "string" ? item.preview : ""
      };
    })
    .filter(Boolean);

  return next.length ? next : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}
