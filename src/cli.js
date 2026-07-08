import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { applySuggestions, readCollections, writeCollections, addRepoToCollection, removeRepoFromCollection, ensureCollection } from "./collections.js";
import { listStarredRepos, starRepo, tokenFromConfig, unstarRepo, validateToken } from "./github.js";
import { MODEL_PRESETS, listCodexModels, listPiModels, recommendedCodexModel, suggestCollections } from "./ai.js";
import { DATA_DIR, appendHistory, dataPath, readConfig, readJson, removeData, writeConfig, writeJson } from "./storage.js";

export async function main(argv) {
  const args = argv.slice(2);
  const [group, command, ...rest] = args;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    printHelp(command);
    return;
  }
  if (group === "auth") return authCommand(command, rest);
  if (group === "model") return modelCommand(command, rest);
  if (group === "stars") return starsCommand(command, rest);
  if (group === "collections") return collectionsCommand(command, rest);
  if (group === "ai") return aiCommand(command, rest);
  if (group === "data") return dataCommand(command, rest);
  throw new Error(`Unknown command "${group}". Run: gh-ai-client help`);
}

function printHelp(topic = "") {
  const sections = {
    auth: "auth set-token | auth status | auth clear-token",
    model: "model list [pi [provider]|codex|local|--all] | model use <provider[:model]|codex> | model current | model test",
    stars: "stars sync [--max-pages N] | stars list [--limit N] | stars search <keyword> | stars star <owner/repo> | stars unstar <owner/repo>",
    collections: "collections list | collections show <name> | collections create <name> | collections add <name> <owner/repo> | collections remove <name> <owner/repo> | collections export [file] | collections import <file> [--replace]",
    ai: "ai suggest [--provider mock|pi|openai-compatible] [--model name] [--limit N] | ai status | ai step [--apply] | ai skip | ai review | ai apply | ai clear",
    data: "data path | data doctor"
  };
  if (topic && sections[topic]) {
    console.log(`Usage: gh-ai-client ${sections[topic]}`);
    return;
  }
  console.log(`gh-ai-client

Usage:
  gh-ai-client help [auth|model|stars|collections|ai|data]
  gh-ai-client auth set-token
  gh-ai-client model use <provider[:model]|codex>
  gh-ai-client stars sync
  gh-ai-client ai suggest
  gh-ai-client ai step
  gh-ai-client ai apply

Commands:
  ${sections.auth}
  ${sections.model}
  ${sections.stars}
  ${sections.collections}
  ${sections.ai}
  ${sections.data}

Data:
  ${DATA_DIR}`);
}

async function authCommand(command, args) {
  const config = await readConfig();
  if (command === "set-token") {
    const token = args[0] || await promptSecret("GitHub token: ");
    const user = await validateToken(token);
    config.github = { token, user };
    await writeConfig(config);
    console.log(`Saved GitHub token for @${user.login}.`);
    return;
  }
  if (command === "status") {
    const token = tokenFromConfig(config);
    if (!token) {
      console.log("No GitHub token configured.");
      return;
    }
    const user = await validateToken(token);
    console.log(`GitHub token works for @${user.login}.`);
    return;
  }
  if (command === "clear-token") {
    config.github = {};
    await writeConfig(config);
    console.log("Cleared GitHub token from config.");
    return;
  }
  printHelp("auth");
}

async function modelCommand(command, args) {
  const config = await readConfig();
  if (command === "list") {
    if (args[0] === "local") {
      for (const item of MODEL_PRESETS.filter((preset) => preset.provider === "mock")) {
        console.log(`${item.provider}:${item.model} - ${item.note}`);
      }
      return;
    }
    if (args[0] === "codex") {
      const rows = await listCodexModels();
      for (const row of rows.slice(0, Number(readOption(args, "--limit") || 30))) {
        console.log(`pi:${row.provider}/${row.id} - ${row.name || row.id}${row.reasoning ? " / reasoning" : ""}`);
      }
      if (rows.length === 0) console.log("No Codex models found in pi.");
      return;
    }
    if (args[0] === "pi") {
      const rows = await listPiModels(args[1] || "");
      for (const row of rows.slice(0, Number(readOption(args, "--limit") || 80))) {
        console.log(`pi:${row.provider}/${row.id} - ${row.name || row.id}${row.reasoning ? " / reasoning" : ""}`);
      }
      if (rows.length === 0) console.log("No pi models found.");
      return;
    }
    const rows = args.includes("--all") ? MODEL_PRESETS : MODEL_PRESETS.filter((preset) => preset.provider !== "mock");
    for (const item of rows) {
      console.log(`${item.provider}:${item.model} - ${item.note}`);
    }
    return;
  }
  if (command === "use") {
    const value = args[0];
    if (!value) throw new Error("Usage: gh-ai-client model use <provider[:model]|codex>");
    if (isCodexAlias(value)) {
      const model = await recommendedCodexModel();
      config.ai = { provider: "pi", model: `${model.provider}/${model.id}` };
      await writeConfig(config);
      console.log(`Using Codex model through pi: ${config.ai.model}.`);
      if (model.provider === "openai" && !process.env.OPENAI_API_KEY) {
        console.log("OpenAI auth is not configured in this shell. Set OPENAI_API_KEY before running: gh-ai-client ai suggest");
      }
      return;
    }
    const [provider, model = defaultModelForProvider(provider)] = value.split(":");
    config.ai = { provider, model };
    await writeConfig(config);
    console.log(`Using model provider ${provider}:${model}.`);
    return;
  }
  if (command === "current") {
    console.log(`${config.ai?.provider || "mock"}:${config.ai?.model || "local-rules"}`);
    return;
  }
  if (command === "test") {
    const result = await suggestCollections({ limit: 5 });
    console.log(`AI provider returned ${result.collections?.length || 0} collection suggestions.`);
    return;
  }
  printHelp("model");
}

async function starsCommand(command, args) {
  const config = await readConfig();
  const token = tokenFromConfig(config);
  if (command === "sync") {
    const maxPages = Number(readOption(args, "--max-pages") || 100);
    const stars = await listStarredRepos(token, { maxPages });
    await writeJson("stars", { synced_at: new Date().toISOString(), stars });
    console.log(`Synced ${stars.length} starred repositories.`);
    return;
  }
  if (command === "list") {
    const limit = Number(readOption(args, "--limit") || 50);
    const state = await readJson("stars", { stars: [] });
    printRepos(state.stars.slice(0, limit));
    return;
  }
  if (command === "search") {
    const keyword = args.join(" ").trim().toLowerCase();
    if (!keyword) throw new Error("Usage: gh-ai-client stars search <keyword>");
    const state = await readJson("stars", { stars: [] });
    printRepos(state.stars.filter((repo) => repoMatches(repo, keyword)).slice(0, 100));
    return;
  }
  if (command === "star") {
    await starRepo(token, args[0]);
    console.log(`Starred ${args[0]}.`);
    return;
  }
  if (command === "unstar") {
    await unstarRepo(token, args[0]);
    console.log(`Unstarred ${args[0]}.`);
    return;
  }
  printHelp("stars");
}

async function collectionsCommand(command, args) {
  const state = await readCollections();
  if (command === "list") {
    if (state.collections.length === 0) {
      console.log("No local collections yet.");
      return;
    }
    for (const collection of state.collections) {
      console.log(`${collection.name} (${collection.repos.length}) ${collection.description || ""}`);
    }
    return;
  }
  if (command === "show") {
    const name = args.join(" ");
    const collection = findCollection(state, name);
    console.log(`${collection.name}: ${collection.description || ""}`);
    for (const repo of collection.repos) console.log(`  ${repo}`);
    return;
  }
  if (command === "create") {
    const name = args.join(" ");
    ensureCollection(state, name);
    await writeCollections(state);
    console.log(`Created collection ${name}.`);
    return;
  }
  if (command === "add") {
    const { name, repo } = collectionRepoArgs(args);
    addRepoToCollection(state, name, repo);
    await writeCollections(state);
    console.log(`Added ${repo} to ${name}.`);
    return;
  }
  if (command === "remove") {
    const { name, repo } = collectionRepoArgs(args);
    removeRepoFromCollection(state, name, repo);
    await writeCollections(state);
    console.log(`Removed ${repo} from ${name}.`);
    return;
  }
  if (command === "export") {
    const payload = JSON.stringify(state, null, 2);
    const file = args[0];
    if (!file) {
      console.log(payload);
      return;
    }
    await writeFile(file, `${payload}\n`, "utf8");
    console.log(`Exported ${state.collections.length} collections to ${file}.`);
    return;
  }
  if (command === "import") {
    const file = args[0];
    if (!file) throw new Error("Usage: gh-ai-client collections import <file> [--replace]");
    const incoming = normalizeCollectionState(JSON.parse(await readFile(file, "utf8")));
    const next = args.includes("--replace") ? incoming : mergeCollectionStates(state, incoming);
    await writeCollections(next);
    await appendHistory({ action: "collections.import", file, mode: args.includes("--replace") ? "replace" : "merge" });
    console.log(`Imported ${incoming.collections.length} collections from ${file}.`);
    return;
  }
  printHelp("collections");
}

async function aiCommand(command, args) {
  if (command === "suggest") {
    const provider = readOption(args, "--provider");
    const model = readOption(args, "--model");
    const limit = Number(readOption(args, "--limit") || 200);
    const result = await suggestCollections({ provider, model, limit });
    console.log(`Wrote ${result.collections?.length || 0} collection suggestions to suggestions.json.`);
    for (const collection of result.collections || []) {
      console.log(`${collection.name} (${collection.repos.length})`);
    }
    return;
  }
  if (command === "status") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const total = countSuggestedAssignments(suggestions);
    const remaining = countUnappliedSuggestions(suggestions, state);
    console.log(`${remaining}/${total} suggested repo assignments remaining.`);
    return;
  }
  if (command === "apply") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const applied = applySuggestions(state, suggestions);
    await writeCollections(state);
    await writeJson("suggestions", { ...suggestions, collections: [] });
    await appendHistory({ action: "ai.apply", count: applied.length });
    console.log(`Applied ${applied.length} repo assignments.`);
    return;
  }
  if (command === "step") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const action = firstSuggestedAction(suggestions, state);
    if (!action) {
      console.log("No unapplied suggestion action available. Run: gh-ai-client ai suggest");
      return;
    }
    console.log(JSON.stringify(action, null, 2));
    if (args.includes("--apply")) {
      await applySuggestedAction(state, suggestions, action, "ai.step.apply");
      console.log(`Applied: ${action.repo} -> ${action.collection}`);
    }
    return;
  }
  if (command === "skip") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const action = firstSuggestedAction(suggestions, state);
    if (!action) {
      console.log("No unapplied suggestion action available. Run: gh-ai-client ai suggest");
      return;
    }
    removeSuggestedAssignment(suggestions, action);
    await writeJson("suggestions", suggestions);
    await appendHistory({ action: "ai.step.skip", repo: action.repo, collection: action.collection });
    console.log(`Skipped: ${action.repo} -> ${action.collection}`);
    return;
  }
  if (command === "review") {
    await reviewSuggestions();
    return;
  }
  if (command === "clear") {
    await removeData("suggestions");
    console.log("Cleared suggestions.");
    return;
  }
  printHelp("ai");
}

async function dataCommand(command) {
  if (command === "path") {
    console.log(DATA_DIR);
    console.log(`config: ${dataPath("config")}`);
    console.log(`stars: ${dataPath("stars")}`);
    console.log(`collections: ${dataPath("collections")}`);
    console.log(`suggestions: ${dataPath("suggestions")}`);
    console.log(`history: ${dataPath("history")}`);
    return;
  }
  if (command === "doctor") {
    const config = await readConfig();
    const stars = await readJson("stars", { stars: [] });
    const collections = await readCollections();
    const suggestions = await readJson("suggestions", { collections: [] });
    const starNames = new Set((stars.stars || []).map((repo) => repo.full_name));
    const collectionNames = new Set();
    const duplicateCollections = [];
    const unknownRepos = [];
    for (const collection of collections.collections || []) {
      const key = String(collection.name || "").trim().toLowerCase();
      if (collectionNames.has(key)) duplicateCollections.push(collection.name);
      collectionNames.add(key);
      for (const repo of collection.repos || []) {
        if (starNames.size > 0 && !starNames.has(repo)) unknownRepos.push(`${collection.name}:${repo}`);
      }
    }
    console.log(`Data dir: ${DATA_DIR}`);
    console.log(`GitHub token: ${tokenFromConfig(config) ? "configured" : "missing"}`);
    console.log(`AI model: ${config.ai?.provider || "mock"}:${config.ai?.model || "local-rules"}`);
    console.log(`Stars: ${(stars.stars || []).length}`);
    console.log(`Collections: ${(collections.collections || []).length}`);
    console.log(`Pending suggestions: ${countSuggestedAssignments(suggestions)}`);
    if (duplicateCollections.length) console.log(`Duplicate collection names: ${duplicateCollections.join(", ")}`);
    if (unknownRepos.length) console.log(`Repos in collections but not in current stars: ${unknownRepos.slice(0, 20).join(", ")}${unknownRepos.length > 20 ? " ..." : ""}`);
    if (!duplicateCollections.length && !unknownRepos.length) console.log("No obvious data issues.");
    return;
  }
  printHelp("data");
}

function printRepos(repos) {
  if (!repos.length) {
    console.log("No repositories.");
    return;
  }
  for (const repo of repos) {
    const meta = [repo.language, repo.archived ? "archived" : "", repo.starred_at ? `starred ${repo.starred_at.slice(0, 10)}` : ""].filter(Boolean).join(" / ");
    console.log(`${repo.full_name}${meta ? ` - ${meta}` : ""}`);
    if (repo.description) console.log(`  ${repo.description}`);
  }
}

function repoMatches(repo, keyword) {
  return [
    repo.full_name,
    repo.description,
    repo.language,
    ...(repo.topics || [])
  ].join(" ").toLowerCase().includes(keyword);
}

function findCollection(state, name) {
  const clean = String(name || "").trim().toLowerCase();
  const collection = state.collections.find((item) => item.name.toLowerCase() === clean);
  if (!collection) throw new Error(`Collection "${name}" does not exist.`);
  return collection;
}

function collectionRepoArgs(args) {
  const repo = args[args.length - 1];
  const name = args.slice(0, -1).join(" ");
  if (!name || !repo) throw new Error("Usage: gh-ai-client collections add <collection name> <owner/repo>");
  return { name, repo };
}

function defaultModelForProvider(provider) {
  if (provider === "pi") return "openai/gpt-4o-mini";
  if (provider === "codex") return "auto";
  if (provider === "openai-compatible") return "env";
  return "local-rules";
}

function isCodexAlias(value) {
  return ["codex", "pi:codex", "pi:openai/codex"].includes(String(value || "").toLowerCase());
}

function firstSuggestedAction(suggestions, state = { collections: [] }) {
  for (const collection of suggestions.collections || []) {
    for (const repo of collection.repos || []) {
      if (collectionContainsRepo(state, collection.name, repo)) continue;
      return {
        action: "add_to_collection",
        repo,
        collection: collection.name,
        description: collection.description || "",
        reason: `Suggested by ${suggestions.provider || "ai"}:${suggestions.model || "unknown"}`
      };
    }
  }
  return null;
}

function collectionContainsRepo(state, collectionName, repoFullName) {
  const cleanName = String(collectionName || "").trim().toLowerCase();
  const collection = state.collections?.find((item) => item.name.toLowerCase() === cleanName);
  return Boolean(collection?.repos?.includes(repoFullName));
}

function removeSuggestedAssignment(suggestions, action) {
  suggestions.collections = (suggestions.collections || [])
    .map((collection) => {
      if (collection.name !== action.collection) return collection;
      return {
        ...collection,
        repos: (collection.repos || []).filter((repo) => repo !== action.repo)
      };
    })
    .filter((collection) => (collection.repos || []).length > 0);
}

async function applySuggestedAction(state, suggestions, action, historyAction) {
  addRepoToCollection(state, action.collection, action.repo, action.description || "");
  removeSuggestedAssignment(suggestions, action);
  await writeCollections(state);
  await writeJson("suggestions", suggestions);
  await appendHistory({ action: historyAction, repo: action.repo, collection: action.collection });
}

async function reviewSuggestions() {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const suggestions = await readJson("suggestions", { collections: [] });
      const state = await readCollections();
      const action = firstSuggestedAction(suggestions, state);
      if (!action) {
        console.log("No unapplied suggestion action available. Run: gh-ai-client ai suggest");
        return;
      }
      console.log(`\n${action.repo} -> ${action.collection}`);
      if (action.description) console.log(action.description);
      console.log(action.reason);
      const answer = (await rl.question("Apply this action? [a]pply/[s]kip/[q]uit: ")).trim().toLowerCase();
      if (answer === "q" || answer === "quit") return;
      if (answer === "s" || answer === "skip") {
        removeSuggestedAssignment(suggestions, action);
        await writeJson("suggestions", suggestions);
        await appendHistory({ action: "ai.review.skip", repo: action.repo, collection: action.collection });
        console.log(`Skipped: ${action.repo} -> ${action.collection}`);
        continue;
      }
      if (answer === "" || answer === "a" || answer === "apply" || answer === "y" || answer === "yes") {
        await applySuggestedAction(state, suggestions, action, "ai.review.apply");
        console.log(`Applied: ${action.repo} -> ${action.collection}`);
        continue;
      }
      console.log("Enter a/apply, s/skip, or q/quit.");
    }
  } finally {
    rl.close();
  }
}

function normalizeCollectionState(value) {
  if (!value || !Array.isArray(value.collections)) {
    throw new Error("Collection file must be JSON with a collections array.");
  }
  return {
    collections: value.collections.map((collection) => ({
      name: String(collection.name || "").trim(),
      description: String(collection.description || ""),
      repos: [...new Set((collection.repos || []).map((repo) => String(repo).trim()).filter(Boolean))].sort(),
      created_at: collection.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    })).filter((collection) => collection.name)
  };
}

function mergeCollectionStates(current, incoming) {
  const next = normalizeCollectionState(current);
  for (const collection of incoming.collections) {
    const target = ensureCollection(next, collection.name, collection.description || "");
    if (!target.description && collection.description) target.description = collection.description;
    for (const repo of collection.repos) {
      addRepoToCollection(next, target.name, repo, collection.description || "");
    }
  }
  return next;
}

function countSuggestedAssignments(suggestions) {
  return (suggestions.collections || []).reduce((total, collection) => total + (collection.repos || []).length, 0);
}

function countUnappliedSuggestions(suggestions, state) {
  let total = 0;
  for (const collection of suggestions.collections || []) {
    for (const repo of collection.repos || []) {
      if (!collectionContainsRepo(state, collection.name, repo)) total += 1;
    }
  }
  return total;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}

async function promptSecret(label) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}
