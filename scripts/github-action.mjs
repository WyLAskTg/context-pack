import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createContextPack } from "../lib/contextPack.mjs";
import { renderMarkdown } from "../lib/renderMarkdown.mjs";

const execFileAsync = promisify(execFile);
const COMMENT_MARKER = "<!-- context-pack-action -->";

async function main() {
  const event = await readGitHubEvent();
  const repoPath = path.resolve(getInput("repo-path") || process.env.GITHUB_WORKSPACE || process.cwd());
  const includeDiff = toBoolean(getInput("include-diff"), true);
  const maxFiles = Number(getInput("max-files") || 12);
  const task = getInput("task") || deriveTask(event.name, event.payload);
  const diffRefs = includeDiff ? await resolveDiffRefs(repoPath, event) : {};

  const pack = await createContextPack({
    repoPath,
    task,
    includeDiff,
    maxFiles,
    diffBase: diffRefs.base,
    diffHead: diffRefs.head
  });

  const markdown = renderMarkdown(pack);
  const jsonPath = await maybeWriteFile(repoPath, getInput("output-json", ".context-pack/context-pack.json"), JSON.stringify(pack, null, 2));
  const markdownPath = await maybeWriteFile(repoPath, getInput("output-markdown", ".context-pack/context-pack.md"), markdown);

  if (toBoolean(getInput("write-summary"), true) && process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  if (toBoolean(getInput("comment-pr"), false)) {
    await commentOnPullRequest(event, markdown);
  }

  writeOutput("summary", pack.summary);
  if (jsonPath) writeOutput("json-path", jsonPath);
  if (markdownPath) writeOutput("markdown-path", markdownPath);

  notice(pack.summary);
}

async function readGitHubEvent() {
  const name = process.env.GITHUB_EVENT_NAME || "manual";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return { name, payload: {} };

  try {
    return {
      name,
      payload: JSON.parse(await fs.readFile(eventPath, "utf8"))
    };
  } catch (error) {
    warning(`Could not read GitHub event payload: ${error.message}`);
    return { name, payload: {} };
  }
}

function deriveTask(eventName, payload) {
  if (payload.pull_request) {
    return [
      `Review this pull request and prepare an AI coding-agent context pack: ${payload.pull_request.title}`,
      payload.pull_request.body || ""
    ].filter(Boolean).join("\n\n");
  }

  if (payload.issue) {
    return [
      `Turn this issue into an implementation-ready context pack: ${payload.issue.title}`,
      payload.issue.body || ""
    ].filter(Boolean).join("\n\n");
  }

  if (eventName === "push" && Array.isArray(payload.commits) && payload.commits.length) {
    const messages = payload.commits.slice(-5).map((commit) => `- ${commit.message}`);
    return ["Summarize this push as an AI coding-agent context pack.", ...messages].join("\n");
  }

  return "Generate an AI coding-agent context pack for this repository.";
}

async function resolveDiffRefs(repoPath, event) {
  const pullRequest = event.payload.pull_request;
  if (pullRequest?.base?.sha && pullRequest?.head?.sha) {
    const base = await resolveCommit(repoPath, pullRequest.base.sha, pullRequest.base.ref);
    const head = await resolveCommit(repoPath, pullRequest.head.sha, pullRequest.head.ref);
    return { base, head };
  }

  if (event.name === "push" && event.payload.before && event.payload.after && !/^0+$/.test(event.payload.before)) {
    const base = await resolveCommit(repoPath, event.payload.before);
    const head = await resolveCommit(repoPath, event.payload.after);
    return { base, head };
  }

  return {};
}

async function resolveCommit(repoPath, sha, refName = "") {
  if (!sha) return "";
  if (await hasCommit(repoPath, sha)) return sha;

  await runGit(repoPath, ["fetch", "--no-tags", "--depth=50", "origin", sha]);
  if (await hasCommit(repoPath, sha)) return sha;

  if (refName) {
    await runGit(repoPath, ["fetch", "--no-tags", "--depth=50", "origin", refName]);
    if (await hasCommit(repoPath, sha)) return sha;
  }

  warning(`Could not resolve commit ${sha}; diff context may be incomplete. Use actions/checkout with fetch-depth: 0 for best results.`);
  return "";
}

async function hasCommit(repoPath, sha) {
  const result = await runGit(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.ok;
}

async function runGit(repoPath, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

async function maybeWriteFile(repoPath, targetPath, content) {
  const cleaned = String(targetPath || "").trim();
  if (!cleaned) return "";

  const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(repoPath, cleaned);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return absolute;
}

async function commentOnPullRequest(event, markdown) {
  const pullRequest = event.payload.pull_request;
  if (!pullRequest?.number) {
    notice("comment-pr is enabled, but this event is not a pull request.");
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");
  const token = getInput("github-token") || process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    warning("Skipping PR comment because repository or token information is missing.");
    return;
  }

  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const commentsUrl = `${apiBase}/repos/${owner}/${repo}/issues/${pullRequest.number}/comments`;
  const body = `${COMMENT_MARKER}\n${truncate(markdown, 60000)}`;

  try {
    const commentsResponse = await githubFetch(commentsUrl, token);
    const comments = commentsResponse.ok ? await commentsResponse.json() : [];
    const existing = Array.isArray(comments)
      ? comments.find((comment) => typeof comment.body === "string" && comment.body.includes(COMMENT_MARKER))
      : null;

    if (existing?.url) {
      const response = await githubFetch(existing.url, token, "PATCH", { body });
      if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
      notice("Updated Context Pack pull request comment.");
      return;
    }

    const response = await githubFetch(commentsUrl, token, "POST", { body });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    notice("Created Context Pack pull request comment.");
  } catch (error) {
    warning(`Could not write PR comment: ${error.message}`);
  }
}

function githubFetch(url, token, method = "GET", body) {
  return fetch(url, {
    method,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function getInput(name, fallback = "") {
  const upper = name.toUpperCase();
  const keys = [
    `INPUT_${upper}`,
    `INPUT_${upper.replaceAll("-", "_")}`,
    `INPUT_${upper.replaceAll(" ", "_")}`
  ];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      return String(process.env[key] || "").trim();
    }
  }

  return fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function writeOutput(name, value) {
  const line = `${name}=${escapeOutput(value)}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, line);
    return;
  }
  console.log(line.trim());
}

function escapeOutput(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\n", "%0A").replaceAll("\r", "%0D");
}

function notice(message) {
  console.log(`::notice::${escapeCommand(message)}`);
}

function warning(message) {
  console.warn(`::warning::${escapeCommand(message)}`);
}

function escapeCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 80)}\n\n_Comment truncated. See the workflow artifact for the full Context Pack._`;
}

main().catch((error) => {
  console.error(`::error::${escapeCommand(error.stack || error.message || error)}`);
  process.exitCode = 1;
});
