import { listStarredRepos, starRepo, tokenFromConfig, unstarRepo } from "./github.js";
import { applyProxyConfig } from "./proxy.js";
import { addRepoToGitHubList, createGitHubList, deleteGitHubList, getGitHubList, listGitHubLists, removeRepoFromGitHubList } from "./star-lists.js";
import { readConfig } from "./storage.js";

const PROTOCOL_VERSION = "2024-11-05";

const tools = [
  {
    name: "stars_list",
    description: "List repositories starred by the authenticated GitHub user.",
    inputSchema: objectSchema({
      limit: numberSchema("Maximum repositories to return.", 50),
      maxPages: numberSchema("Maximum GitHub REST pages to read.", 100)
    })
  },
  {
    name: "stars_search",
    description: "Search authenticated user's starred repositories by name, description, language, or topic.",
    inputSchema: objectSchema({
      query: stringSchema("Search query.", true),
      limit: numberSchema("Maximum repositories to return.", 50),
      maxPages: numberSchema("Maximum GitHub REST pages to read.", 100)
    }, ["query"])
  },
  {
    name: "star_repo",
    description: "Star a GitHub repository.",
    inputSchema: objectSchema({
      repo: stringSchema("Repository full name, for example owner/repo.", true)
    }, ["repo"])
  },
  {
    name: "unstar_repo",
    description: "Unstar a GitHub repository.",
    inputSchema: objectSchema({
      repo: stringSchema("Repository full name, for example owner/repo.", true)
    }, ["repo"])
  },
  {
    name: "lists_list",
    description: "List GitHub Star Lists for the authenticated user.",
    inputSchema: objectSchema({
      includeItems: booleanSchema("Whether to include repository details for each list.", false)
    })
  },
  {
    name: "lists_show",
    description: "Show repositories in a GitHub Star List.",
    inputSchema: objectSchema({
      name: stringSchema("Star List name or slug.", true)
    }, ["name"])
  },
  {
    name: "lists_create",
    description: "Create a GitHub Star List.",
    inputSchema: objectSchema({
      name: stringSchema("Star List name.", true),
      description: stringSchema("Star List description.", false),
      private: booleanSchema("Whether the Star List should be private.", false)
    }, ["name"])
  },
  {
    name: "lists_add_repo",
    description: "Add a repository to a GitHub Star List, preserving its other list memberships.",
    inputSchema: objectSchema({
      list: stringSchema("Star List name or slug.", true),
      repo: stringSchema("Repository full name, for example owner/repo.", true),
      create: booleanSchema("Create the list if it is missing.", false),
      star: booleanSchema("Star the repository first if it is not starred.", true)
    }, ["list", "repo"])
  },
  {
    name: "lists_remove_repo",
    description: "Remove a repository from a GitHub Star List, preserving its other list memberships.",
    inputSchema: objectSchema({
      list: stringSchema("Star List name or slug.", true),
      repo: stringSchema("Repository full name, for example owner/repo.", true)
    }, ["list", "repo"])
  },
  {
    name: "lists_delete",
    description: "Delete a GitHub Star List. This removes the list, not the repositories' stars.",
    inputSchema: objectSchema({
      name: stringSchema("Star List name or slug.", true)
    }, ["name"])
  }
];

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      await handleLine(line, output);
    }
  }
}

async function handleLine(line, output) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeMessage(output, errorResponse(null, -32700, `Parse error: ${error.message}`));
    return;
  }
  if (!Object.hasOwn(request, "id")) {
    await handleNotification(request);
    return;
  }
  try {
    const result = await handleRequest(request);
    writeMessage(output, { jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    writeMessage(output, errorResponse(request.id, -32603, error instanceof Error ? error.message : String(error)));
  }
}

async function handleNotification() {
  // No-op. MCP clients send notifications such as notifications/initialized.
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "github-ai-manager",
        version: "0.1.1"
      },
      instructions: [
        "Use these tools to manage the authenticated user's GitHub stars and GitHub Star Lists.",
        "Read operations use live GitHub APIs. Write operations modify GitHub directly.",
        "Do not call write tools until the user has clearly approved the intended change."
      ].join(" ")
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "resources/list") return { resources: [] };
  if (request.method === "prompts/list") return { prompts: [] };
  if (request.method === "tools/call") return callTool(request.params || {});
  throw new Error(`Unsupported MCP method "${request.method}".`);
}

async function callTool(params) {
  const name = String(params.name || "");
  const args = params.arguments || {};
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  try {
    const data = await runTool(name, args, token);
    return toolResult(data);
  } catch (error) {
    return toolResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, true);
  }
}

async function runTool(name, args, token) {
  if (name === "stars_list") {
    const stars = await listStarredRepos(token, { maxPages: integerArg(args.maxPages, 100) });
    return {
      ok: true,
      stars: stars.slice(0, integerArg(args.limit, 50))
    };
  }
  if (name === "stars_search") {
    const query = requiredString(args.query, "query").toLowerCase();
    const stars = await listStarredRepos(token, { maxPages: integerArg(args.maxPages, 100) });
    return {
      ok: true,
      stars: stars.filter((repo) => repoMatches(repo, query)).slice(0, integerArg(args.limit, 50))
    };
  }
  if (name === "star_repo") {
    const repo = requiredString(args.repo, "repo");
    await starRepo(token, repo);
    return { ok: true, repo, changed: true };
  }
  if (name === "unstar_repo") {
    const repo = requiredString(args.repo, "repo");
    await unstarRepo(token, repo);
    return { ok: true, repo, changed: true };
  }
  if (name === "lists_list") {
    const state = await listGitHubLists(token, { includeItems: Boolean(args.includeItems) });
    return { ok: true, lists: state.lists };
  }
  if (name === "lists_show") {
    const list = await getGitHubList(token, requiredString(args.name, "name"));
    if (!list) throw new Error(`GitHub list "${args.name}" does not exist.`);
    return { ok: true, list };
  }
  if (name === "lists_create") {
    const list = await createGitHubList(token, {
      name: requiredString(args.name, "name"),
      description: stringArg(args.description, ""),
      isPrivate: Boolean(args.private)
    });
    return { ok: true, list };
  }
  if (name === "lists_add_repo") {
    const result = await addRepoToGitHubList(token, requiredString(args.list, "list"), requiredString(args.repo, "repo"), {
      create: Boolean(args.create),
      star: args.star !== false
    });
    return { ok: true, ...result };
  }
  if (name === "lists_remove_repo") {
    const result = await removeRepoFromGitHubList(token, requiredString(args.list, "list"), requiredString(args.repo, "repo"));
    return { ok: true, ...result };
  }
  if (name === "lists_delete") {
    const result = await deleteGitHubList(token, requiredString(args.name, "name"));
    return { ok: true, ...result };
  }
  throw new Error(`Unknown tool "${name}".`);
}

function toolResult(value, isError = false) {
  return {
    isError,
    content: [{
      type: "text",
      text: `${JSON.stringify(value, null, 2)}\n`
    }]
  };
}

function writeMessage(output, message) {
  output.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

function repoMatches(repo, keyword) {
  return [
    repo.full_name,
    repo.description,
    repo.language,
    ...(repo.topics || [])
  ].join(" ").toLowerCase().includes(keyword);
}

function requiredString(value, name) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error(`Tool argument "${name}" is required.`);
  return clean;
}

function stringArg(value, fallback) {
  const clean = String(value || "").trim();
  return clean || fallback;
}

function integerArg(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function stringSchema(description) {
  return {
    type: "string",
    description
  };
}

function numberSchema(description, defaultValue) {
  return {
    type: "integer",
    description,
    default: defaultValue,
    minimum: 1
  };
}

function booleanSchema(description, defaultValue) {
  return {
    type: "boolean",
    description,
    default: defaultValue
  };
}
