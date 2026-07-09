import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { MODEL_PRESETS, listCodexModels, listPiModels, planGitHubActions, recommendedCodexModel, testConfiguredModel } from "./ai.js";
import { listStarredRepos, starRepo, tokenFromConfig, unstarRepo, validateToken } from "./github.js";
import { CODEX_PROVIDER_ID, createPiCredentialStore, readPiCredential } from "./pi-auth.js";
import { applyProxyConfig, normalizeProxyConfig, proxyStatusLines } from "./proxy.js";
import { addRepoToGitHubList, createGitHubList, getGitHubList, listGitHubLists, removeRepoFromGitHubList } from "./star-lists.js";
import { DATA_DIR, dataPath, readConfig, writeConfig } from "./storage.js";

export async function main(argv) {
  const args = argv.slice(2);
  const [group, command, ...rest] = args;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    printHelp(command);
    return;
  }
  if (group === "auth") return authCommand(command, rest);
  if (group === "proxy") return proxyCommand(command, rest);
  if (group === "codex") return codexCommand(command);
  if (group === "model") return modelCommand(command, rest);
  if (group === "stars") return starsCommand(command, rest);
  if (group === "lists") return listsCommand(command, rest);
  if (group === "ai") return aiCommand(command, rest);
  if (group === "data") return dataCommand(command);
  throw new Error(`Unknown command "${group}". Run: ghac help`);
}

function printHelp(topic = "") {
  const sections = {
    auth: "auth set-token | auth status | auth clear-token",
    proxy: "proxy set <url> | proxy set --http <url> [--https <url>] [--all <url>] [--no-proxy list] | proxy status | proxy clear",
    codex: "codex login | codex status | codex logout",
    model: "model list [pi [provider]|codex|--all] | model use <provider[:model]|codex> | model current | model test",
    stars: "stars list [--limit N] [--max-pages N] | stars search <keyword> [--max-pages N] | stars star <owner/repo> | stars unstar <owner/repo>",
    lists: "lists list | lists show <name> | lists create <name> [--description text] [--private] | lists add <name> <owner/repo> [--create] | lists remove <name> <owner/repo>",
    ai: "ai | ai plan <prompt>",
    data: "data path | data doctor"
  };
  if (topic && sections[topic]) {
    console.log(`Usage: ghac ${sections[topic]}`);
    return;
  }
  console.log(`ghac

Usage:
  ghac help [auth|proxy|codex|model|stars|lists|ai|data]
  ghac auth set-token
  ghac proxy set http://127.0.0.1:7890
  ghac codex login
  ghac model use codex
  ghac stars list
  ghac lists list
  ghac ai

Commands:
  ${sections.auth}
  ${sections.proxy}
  ${sections.codex}
  ${sections.model}
  ${sections.stars}
  ${sections.lists}
  ${sections.ai}
  ${sections.data}

Data:
  Only credentials and configuration are stored under ${DATA_DIR}.
  GitHub stars and Star Lists are read from GitHub APIs live.`);
}

async function authCommand(command, args) {
  const config = await readConfig();
  await applyProxyConfig(config);
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

async function proxyCommand(command, args) {
  const config = await readConfig();
  if (command === "set") {
    config.proxy = parseProxyArgs(args);
    await writeConfig(config);
    console.log("Saved proxy configuration.");
    for (const line of proxyStatusLines(config).slice(1)) console.log(line);
    return;
  }
  if (command === "status") {
    for (const line of proxyStatusLines(config)) console.log(line);
    return;
  }
  if (command === "clear") {
    delete config.proxy;
    await writeConfig(config);
    console.log("Cleared proxy configuration.");
    return;
  }
  printHelp("proxy");
}

async function codexCommand(command) {
  const config = await readConfig();
  await applyProxyConfig(config);
  if (command === "login") {
    const store = createPiCredentialStore();
    const models = await createPiModelsWithStore(store);
    const provider = models.getProvider(CODEX_PROVIDER_ID);
    if (!provider?.auth?.oauth) throw new Error("pi provider openai-codex does not support OAuth login.");
    const rl = createInterface({ input, output });
    try {
      const credential = await provider.auth.oauth.login({
        prompt: (prompt) => authLoginPrompt(rl, prompt),
        notify: notifyAuthEvent
      });
      await store.modify(CODEX_PROVIDER_ID, async () => credential);
      const model = await recommendedCodexModel();
      config.ai = { provider: "pi", model: `${model.provider}/${model.id}` };
      await writeConfig(config);
      console.log(`Saved Codex login and selected ${config.ai.model}.`);
    } finally {
      rl.close();
    }
    return;
  }
  if (command === "status") {
    const credential = await readPiCredential(CODEX_PROVIDER_ID);
    if (!credential) {
      console.log("Codex login is not configured. Run: ghac codex login");
      console.log(`Current model: ${modelLabel(config)}`);
      return;
    }
    const models = await createPiModelsWithStore(createPiCredentialStore());
    const selected = await recommendedCodexModel();
    const model = models.getModel(selected.provider, selected.id);
    const auth = model ? await models.getAuth(model) : null;
    console.log(`Codex login: ${auth ? `configured via ${auth.source || "OAuth"}` : "stored but not usable"}`);
    console.log(`Current model: ${modelLabel(config)}`);
    return;
  }
  if (command === "logout") {
    await createPiCredentialStore().delete(CODEX_PROVIDER_ID);
    console.log("Cleared Codex login.");
    return;
  }
  printHelp("codex");
}

async function modelCommand(command, args) {
  const config = await readConfig();
  if (command === "list") {
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
    const rows = args.includes("--all") ? MODEL_PRESETS : MODEL_PRESETS.filter((preset) => preset.provider !== "codex");
    for (const item of rows) console.log(`${item.provider}:${item.model} - ${item.note}`);
    return;
  }
  if (command === "use") {
    const value = args[0];
    if (!value) throw new Error("Usage: ghac model use <provider[:model]|codex>");
    if (isCodexAlias(value)) {
      const model = await recommendedCodexModel();
      config.ai = { provider: "pi", model: `${model.provider}/${model.id}` };
      await writeConfig(config);
      console.log(`Using Codex model through pi: ${config.ai.model}.`);
      if (model.provider === CODEX_PROVIDER_ID && !await readPiCredential(CODEX_PROVIDER_ID)) {
        console.log("Codex login is not configured. Run: ghac codex login");
      } else if (model.provider === "openai" && !process.env.OPENAI_API_KEY) {
        console.log("OpenAI auth is not configured in this shell. Set OPENAI_API_KEY before running: ghac ai");
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
    console.log(modelLabel(config));
    return;
  }
  if (command === "test") {
    const result = await testConfiguredModel();
    console.log(result.reply || `AI provider returned ${result.actions?.length || 0} actions.`);
    return;
  }
  printHelp("model");
}

async function starsCommand(command, args) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  if (command === "list") {
    const maxPages = Number(readOption(args, "--max-pages") || 100);
    const limit = Number(readOption(args, "--limit") || 50);
    const stars = await listStarredRepos(token, { maxPages });
    printRepos(stars.slice(0, limit));
    return;
  }
  if (command === "search") {
    const keyword = positionalArgs(args, ["--max-pages"]).join(" ").trim().toLowerCase();
    if (!keyword) throw new Error("Usage: ghac stars search <keyword>");
    const maxPages = Number(readOption(args, "--max-pages") || 100);
    const stars = await listStarredRepos(token, { maxPages });
    printRepos(stars.filter((repo) => repoMatches(repo, keyword)).slice(0, 100));
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

async function listsCommand(command, args) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  if (command === "list") {
    const state = await listGitHubLists(token, { includeItems: false });
    if (!state.lists.length) {
      console.log("No GitHub Star Lists.");
      return;
    }
    for (const list of state.lists) {
      const visibility = list.private ? "private" : "public";
      console.log(`${list.name} (${list.total_count || list.repos?.length || 0}, ${visibility})${list.description ? ` - ${list.description}` : ""}`);
    }
    return;
  }
  if (command === "show") {
    const name = positionalArgs(args).join(" ");
    const list = await getGitHubList(token, name);
    if (!list) throw new Error(`GitHub list "${name}" does not exist.`);
    console.log(`${list.name}: ${list.description || ""}`);
    for (const repo of list.repos || []) {
      console.log(`  ${repo.full_name}${repo.language ? ` - ${repo.language}` : ""}`);
      if (repo.description) console.log(`    ${repo.description}`);
    }
    return;
  }
  if (command === "create") {
    const name = positionalArgs(args, ["--description"], ["--private"]).join(" ");
    const description = readOption(args, "--description");
    const list = await createGitHubList(token, {
      name,
      description,
      isPrivate: args.includes("--private")
    });
    console.log(`Created GitHub Star List ${list.name}.`);
    return;
  }
  if (command === "add") {
    const { name, repo } = listRepoArgs(args, ["--create", "--no-star"]);
    const result = await addRepoToGitHubList(token, name, repo, {
      create: args.includes("--create"),
      star: !args.includes("--no-star")
    });
    console.log(`${result.changed ? "Added" : "Already in list"}: ${result.repo} -> ${result.list.name}.`);
    return;
  }
  if (command === "remove") {
    const { name, repo } = listRepoArgs(args);
    const result = await removeRepoFromGitHubList(token, name, repo);
    console.log(`${result.changed ? "Removed" : "Not in list"}: ${result.repo} -> ${result.list.name}.`);
    return;
  }
  printHelp("lists");
}

async function aiCommand(command, args) {
  if (!command) {
    await startAiRepl();
    return;
  }
  if (command === "plan") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("Usage: ghac ai plan <prompt>");
    const plan = await createPlanFromLiveGitHub(prompt);
    printPlan(plan);
    console.log("Command-line plans are not saved. Run ghac ai to review and apply in one session.");
    return;
  }
  printHelp("ai");
}

async function startAiRepl() {
  const session = { plan: null, history: [], context: null };
  const rl = createInterface({ input, output });
  console.log("ghac ai interactive shell. Type /help for commands, /exit to quit.");
  try {
    while (true) {
      const answer = await readReplAnswer(rl, "ghac-ai> ");
      if (answer === null) return;
      const line = answer.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const shouldExit = await runAiReplCommand(rl, line.slice(1), session);
        if (shouldExit) return;
        continue;
      }
      await handleNaturalAiInput(rl, line, session);
    }
  } finally {
    rl.close();
  }
}

async function runAiReplCommand(rl, line, session) {
  const args = parseCommandLine(line);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "help") {
    printAiReplHelp();
    return false;
  }
  if (["exit", "quit", "q"].includes(command)) return true;
  if (command === "auth") {
    await authCommand(subcommand, rest);
    return false;
  }
  if (command === "proxy") {
    await proxyCommand(subcommand, rest);
    return false;
  }
  if (command === "codex") {
    await codexCommand(subcommand);
    return false;
  }
  if (command === "model") {
    await modelCommand(subcommand || "current", rest);
    return false;
  }
  if (command === "stars") {
    await starsCommand(subcommand, rest);
    if (["star", "unstar"].includes(subcommand)) invalidateSessionGitHubState(session);
    return false;
  }
  if (command === "lists") {
    await listsCommand(subcommand, rest);
    if (["create", "add", "remove"].includes(subcommand)) invalidateSessionGitHubState(session);
    return false;
  }
  if (command === "data") {
    await dataCommand(subcommand);
    return false;
  }
  if (command === "plan") {
    if (subcommand) {
      session.plan = await createPlanFromSession([subcommand, ...rest].join(" "), session);
      printPlan(session.plan);
    } else {
      printPlan(session.plan || { actions: [] });
    }
    return false;
  }
  if (command === "apply") {
    if (!session.plan?.actions?.length) {
      console.log("No pending plan in this session. Type a request first, or use /plan <request>.");
      return false;
    }
    printPlan(session.plan);
    const answer = (await rl.question("Apply this plan to GitHub? [y/N]: ")).trim().toLowerCase();
    if (["y", "yes"].includes(answer)) {
      const applied = await applyGitHubPlan(session.plan);
      rememberTurn(session, {
        role: "system",
        content: `Applied ${applied.length} GitHub actions from the pending plan.`
      });
      session.plan = null;
      session.context = null;
      console.log(`Applied ${applied.length} plan actions.`);
    }
    return false;
  }
  if (command === "refresh") {
    await loadSessionGitHubContext(session, { force: true });
    printSessionContext(session);
    return false;
  }
  if (command === "context") {
    printSessionContext(session);
    return false;
  }
  if (command === "forget" || command === "clear") {
    session.history = [];
    session.plan = null;
    console.log("Cleared in-memory conversation and pending plan. GitHub context remains in memory; use /refresh to reload it.");
    return false;
  }
  console.log(`Unknown AI shell command "/${command}". Type /help.`);
  return false;
}

async function handleNaturalAiInput(rl, text, session) {
  session.plan = await createPlanFromSession(text, session);
  printPlan(session.plan);
  if (!session.plan.actions?.length) return;
  const answer = (await rl.question("Apply this plan to GitHub now? [y/N]: ")).trim().toLowerCase();
  if (["y", "yes"].includes(answer)) {
    const applied = await applyGitHubPlan(session.plan);
    rememberTurn(session, {
      role: "system",
      content: `Applied ${applied.length} GitHub actions from the pending plan.`
    });
    session.plan = null;
    session.context = null;
    console.log(`Applied ${applied.length} plan actions.`);
  } else {
    rememberTurn(session, {
      role: "system",
      content: "User did not apply the pending plan."
    });
  }
}

async function createPlanFromLiveGitHub(prompt) {
  const session = { plan: null, history: [], context: null };
  return createPlanFromSession(prompt, session);
}

async function createPlanFromSession(prompt, session) {
  const context = await loadSessionGitHubContext(session);
  const plan = await planGitHubActions({
    prompt,
    stars: context.stars,
    lists: context.lists,
    history: session.history,
    pendingPlan: session.plan
  });
  rememberTurn(session, { role: "user", content: prompt });
  rememberTurn(session, {
    role: "assistant",
    content: plan.reply || "",
    actions: plan.actions || []
  });
  return plan;
}

async function loadSessionGitHubContext(session, { force = false } = {}) {
  if (session.context && !force) return session.context;
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  console.log(force ? "Refreshing live GitHub stars and Star Lists..." : "Reading live GitHub stars and Star Lists...");
  const [stars, listState] = await Promise.all([
    listStarredRepos(token),
    listGitHubLists(token, { includeItems: true })
  ]);
  session.context = {
    loadedAt: new Date().toISOString(),
    stars,
    lists: listState.lists || []
  };
  return session.context;
}

function rememberTurn(session, turn) {
  session.history.push(turn);
  if (session.history.length > 30) session.history = session.history.slice(-30);
}

function printSessionContext(session) {
  const context = session.context;
  console.log(`Conversation turns: ${session.history.length}`);
  console.log(`Pending plan actions: ${session.plan?.actions?.length || 0}`);
  if (!context) {
    console.log("GitHub context: not loaded in this session");
    return;
  }
  console.log(`GitHub context loaded: ${context.loadedAt}`);
  console.log(`Stars in memory: ${context.stars.length}`);
  console.log(`Star Lists in memory: ${context.lists.length}`);
  const assignments = context.lists.reduce((total, list) => total + (list.repos?.length || 0), 0);
  console.log(`List repo assignments in memory: ${assignments}`);
}

function invalidateSessionGitHubState(session) {
  session.context = null;
  if (session.plan) {
    session.plan = null;
    console.log("Cleared pending plan because GitHub data changed.");
  }
}

async function applyGitHubPlan(plan) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  const applied = [];
  for (const action of plan.actions || []) {
    if (action.type === "create_list") {
      const list = await createGitHubList(token, {
        name: action.name,
        description: action.description || "",
        isPrivate: Boolean(action.private)
      });
      applied.push({ type: action.type, list: list.name });
      continue;
    }
    if (action.type === "add_repo_to_list") {
      const result = await addRepoToGitHubList(token, action.list, action.repo, {
        create: Boolean(action.create),
        star: true
      });
      applied.push({ type: action.type, repo: result.repo, list: result.list.name, changed: result.changed });
      continue;
    }
    if (action.type === "remove_repo_from_list") {
      const result = await removeRepoFromGitHubList(token, action.list, action.repo);
      applied.push({ type: action.type, repo: result.repo, list: result.list.name, changed: result.changed });
      continue;
    }
    throw new Error(`Unsupported plan action "${action.type}".`);
  }
  return applied;
}

function printAiReplHelp() {
  console.log(`AI shell commands:
  /help
  /exit
  /model [current|list|use ...]
  /auth status
  /stars list|search|star|unstar
  /lists list|show|create|add|remove
  /plan [natural language request]
  /apply
  /context
  /refresh
  /forget

Natural language input reuses current session memory and GitHub context, asks the configured model for a plan, and asks before writing.`);
}

function printPlan(plan) {
  if (plan.reply) console.log(plan.reply);
  const actions = plan.actions || [];
  if (!actions.length) {
    console.log("No GitHub actions planned.");
    return;
  }
  console.log("Plan:");
  actions.forEach((action, index) => {
    console.log(`  ${index + 1}. ${formatPlanAction(action)}`);
  });
}

function formatPlanAction(action) {
  if (action.type === "create_list") return `create list "${action.name}"${action.private ? " (private)" : ""}`;
  if (action.type === "add_repo_to_list") return `add ${action.repo} to "${action.list}"${action.create ? " (create list if missing)" : ""}`;
  if (action.type === "remove_repo_from_list") return `remove ${action.repo} from "${action.list}"`;
  return JSON.stringify(action);
}

async function dataCommand(command) {
  if (command === "path") {
    console.log(DATA_DIR);
    console.log(`config: ${dataPath("config")}`);
    console.log(`pi auth: ${dataPath("pi-auth.json")}`);
    console.log("No GitHub stars, Star Lists, or AI plans are stored locally.");
    return;
  }
  if (command === "doctor") {
    const config = await readConfig();
    console.log(`Data dir: ${DATA_DIR}`);
    console.log(`GitHub token: ${tokenFromConfig(config) ? "configured" : "missing"}`);
    console.log(proxyStatusLines(config).join("; "));
    console.log(`AI model: ${modelLabel(config)}`);
    console.log("GitHub data mode: online API only");
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

function listRepoArgs(args, booleanOptions = []) {
  const values = positionalArgs(args, [], booleanOptions);
  const repo = values[values.length - 1];
  const name = values.slice(0, -1).join(" ");
  if (!name || !repo) throw new Error("Usage: ghac lists add <list name> <owner/repo>");
  return { name, repo };
}

function positionalArgs(args, valueOptions = [], booleanOptions = []) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (valueOptions.includes(item)) {
      index += 1;
      continue;
    }
    if (booleanOptions.includes(item)) continue;
    values.push(item);
  }
  return values;
}

function parseProxyArgs(args) {
  if (!args.length) throw new Error("Usage: ghac proxy set <url>");
  if (!args[0].startsWith("--")) {
    const url = args[0];
    return normalizeProxyConfig({ http: url, https: url });
  }
  const proxy = normalizeProxyConfig({
    http: readOption(args, "--http"),
    https: readOption(args, "--https"),
    all: readOption(args, "--all"),
    noProxy: readOption(args, "--no-proxy")
  });
  if (!Object.keys(proxy).length) throw new Error("Usage: ghac proxy set --http <url> [--https <url>] [--all <url>] [--no-proxy list]");
  return proxy;
}

function defaultModelForProvider(provider) {
  if (provider === "pi") return "openai/gpt-4o-mini";
  if (provider === "codex") return "auto";
  if (provider === "openai-compatible") return "env";
  return "";
}

function modelLabel(config) {
  if (!config.ai?.provider) return "not configured";
  if (!config.ai?.model) return config.ai.provider;
  return `${config.ai.provider}:${config.ai.model}`;
}

async function createPiModelsWithStore(store) {
  const pi = await import("@earendil-works/pi-ai/providers/all");
  return pi.builtinModels({ credentials: store });
}

async function authLoginPrompt(rl, prompt) {
  if (prompt.type === "select") {
    console.log(`\n${prompt.message}`);
    prompt.options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);
    });
    const answer = (await questionWithSignal(rl, `Enter number (1-${prompt.options.length}, default 1): `, prompt.signal)).trim();
    const index = answer ? Number(answer) - 1 : 0;
    return prompt.options[index]?.id || prompt.options[0]?.id || "";
  }
  const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
  return questionWithSignal(rl, `${prompt.message}${suffix}: `, prompt.signal);
}

async function questionWithSignal(rl, message, signal) {
  try {
    return await rl.question(message, signal ? { signal } : undefined);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Login prompt was cancelled.");
    throw error;
  }
}

function notifyAuthEvent(event) {
  if (event.type === "auth_url") {
    console.log(`\nOpen this URL in your browser:\n${event.url}`);
    if (event.instructions) console.log(event.instructions);
    return;
  }
  if (event.type === "device_code") {
    console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
    console.log(`Enter code: ${event.userCode}`);
    return;
  }
  if (event.type === "progress") console.log(event.message);
}

function isCodexAlias(value) {
  return ["codex", "pi:codex", "pi:openai/codex"].includes(String(value || "").toLowerCase());
}

async function readReplAnswer(rl, prompt) {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(error?.message || "")) return null;
    throw error;
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}

function parseCommandLine(line) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of String(line || "")) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in command.");
  if (current) args.push(current);
  return args;
}

async function promptSecret(label) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}
