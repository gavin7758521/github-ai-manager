import { readConfig } from "./storage.js";
import { createPiCredentialStore } from "./pi-auth.js";
import { applyProxyConfig, proxyEnvFromConfig } from "./proxy.js";

export const MODEL_PRESETS = [
  { provider: "pi", model: "openai/gpt-4o-mini", note: "Uses @earendil-works/pi-ai built-in providers." },
  { provider: "codex", model: "auto", note: "Alias for the recommended OpenAI Codex model through pi." },
  { provider: "openai-compatible", model: "env", note: "Uses OPENAI_COMPATIBLE_* environment variables." }
];

export async function planGitHubActions({ prompt, stars = [], lists = [], history = [], pendingPlan = null, limit = 120 } = {}) {
  const message = String(prompt || "").trim();
  if (!message) throw new Error("Prompt is required.");
  const config = await readConfig();
  await applyProxyConfig(config);
  const ai = {
    provider: config.ai?.provider || "",
    model: config.ai?.model || ""
  };
  if (!ai.provider) {
    throw new Error("No AI model configured. Run: gham codex login, then gham model use codex");
  }
  const text = await completeText(ai, buildActionPlanMessages(message, stars, lists, history, pendingPlan, limit), config, {
    systemPrompt: "You help manage GitHub starred repositories and GitHub Star Lists. Return only strict JSON."
  });
  const parsed = parseActionPlan(text);
  return {
    provider: ai.provider,
    model: ai.model,
    created_at: new Date().toISOString(),
    prompt: message,
    ...parsed
  };
}

export async function testConfiguredModel() {
  return planGitHubActions({
    prompt: "只说明你已经可以生成 GitHub Star Lists 操作计划，不要生成任何操作。",
    stars: [],
    lists: [],
    limit: 0
  });
}

async function completeText(ai, messages, config, { systemPrompt = "You are a concise GitHub management assistant." } = {}) {
  if (ai.provider === "openai-compatible") return openAiCompatibleComplete(messages);
  if (ai.provider === "pi") return piComplete(ai, messages, config, { systemPrompt });
  throw new Error(`Unsupported AI provider "${ai.provider}". Run: gham model list`);
}

async function openAiCompatibleComplete(messages) {
  const baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Set OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_MODEL.");
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "AI request failed.");
  return payload?.choices?.[0]?.message?.content || "";
}

async function piComplete(ai, messages, config, { systemPrompt }) {
  let pi;
  try {
    pi = await import("@earendil-works/pi-ai/providers/all");
  } catch {
    throw new Error("pi provider is not installed. Run npm install in the github-ai-manager project.");
  }
  const modelRef = process.env.GHAM_PI_MODEL || ai.model || "openai/gpt-4o-mini";
  const [provider, ...modelParts] = modelRef.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) {
    throw new Error("pi model must be provider/model, for example: gham model use pi:openai/gpt-4o-mini");
  }
  const models = pi.builtinModels({ credentials: createPiCredentialStore() });
  const model = models.getModel(provider, modelId);
  if (!model) {
    const examples = models.getModels(provider).slice(0, 8).map((item) => `${provider}/${item.id}`).join(", ");
    throw new Error(`pi model ${provider}/${modelId} was not found.${examples ? ` Examples: ${examples}` : ""}`);
  }
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error(`pi model ${provider}/${modelId} is not configured. ${piAuthHint(provider)}`);
  }
  const proxyEnv = proxyEnvFromConfig(config);
  const response = await models.completeSimple(model, {
    systemPrompt,
    messages: [{
      role: "user",
      content: messages.map((message) => message.content).join("\n\n"),
      timestamp: Date.now()
    }]
  }, {
    reasoning: "low",
    ...(Object.keys(proxyEnv).length ? { env: proxyEnv } : {})
  });
  const text = extractText(response);
  if (!text) {
    throw new Error(`pi model ${provider}/${modelId} returned no text. Try a different model or check provider credentials.`);
  }
  return text;
}

export async function listPiModels(provider = "") {
  const pi = await import("@earendil-works/pi-ai/providers/all");
  const models = pi.builtinModels();
  const providers = provider ? [provider] : models.getProviders().map((item) => item.id);
  return providers.flatMap((providerId) =>
    models.getModels(providerId).map((model) => ({
      provider: providerId,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: Boolean(model.reasoning)
    }))
  );
}

export async function listCodexModels() {
  const subscriptionRows = await listPiModels("openai-codex");
  const apiRows = await listPiModels("openai");
  const openAiCodexRows = apiRows
    .filter((model) => model.id.toLowerCase().includes("codex"))
    .sort((left, right) => codexModelScore(right.id) - codexModelScore(left.id));
  return [...subscriptionRows, ...openAiCodexRows];
}

export async function recommendedCodexModel() {
  const models = await listCodexModels();
  const subscriptionCodex = models.find((model) => model.provider === "openai-codex" && model.id.toLowerCase().includes("codex"));
  const subscription = models.find((model) => model.provider === "openai-codex");
  const exactCodex = models.find((model) => model.provider === "openai" && /^gpt-\d+(?:\.\d+)?-codex$/i.test(model.id));
  const selected = subscriptionCodex || subscription || exactCodex || models[0];
  if (!selected) throw new Error("No Codex model was found in pi's OpenAI model list.");
  return selected;
}

function buildActionPlanMessages(prompt, stars, lists, history, pendingPlan, limit) {
  const repoSample = stars.slice(0, limit).map((repo) => ({
    full_name: repo.full_name,
    description: repo.description,
    language: repo.language,
    topics: repo.topics,
    stargazers_count: repo.stargazers_count,
    archived: repo.archived,
    fork: repo.fork,
    starred_at: repo.starred_at
  }));
  const listSample = lists.map((list) => ({
    name: list.name,
    slug: list.slug,
    description: list.description,
    private: list.private,
    repos: (list.repos || []).map((repo) => repo.full_name)
  }));
  const conversation = history.slice(-12).map((item) => ({
    role: item.role,
    content: item.content,
    actions: Array.isArray(item.actions) ? item.actions.map(compactAction) : undefined
  }));
  return [
    {
      role: "system",
      content: [
        "Return only strict JSON with this shape:",
        "{\"reply\":\"short Chinese response\",\"actions\":[{\"type\":\"create_list\",\"name\":\"...\",\"description\":\"...\",\"private\":false},{\"type\":\"add_repo_to_list\",\"repo\":\"owner/repo\",\"list\":\"...\",\"create\":true},{\"type\":\"remove_repo_from_list\",\"repo\":\"owner/repo\",\"list\":\"...\"},{\"type\":\"delete_list\",\"name\":\"...\"}]}",
        "Use actions only when the user is asking to organize or change GitHub Star Lists.",
        "Do not invent repository names. Use repos from context unless the user explicitly writes an owner/repo.",
        "Use conversation and pendingPlan when the current request refers to earlier turns.",
        "When modifying a previous plan, return the complete replacement actions, not only a diff.",
        "For unclear requests, return no actions and ask a concise clarification in reply."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        request: prompt,
        conversation,
        pendingPlan: pendingPlan ? {
          reply: pendingPlan.reply || "",
          actions: (pendingPlan.actions || []).map(compactAction)
        } : null,
        stars: repoSample,
        lists: listSample
      }, null, 2)
    }
  ];
}

function compactAction(action) {
  if (!action || typeof action !== "object") return action;
  return {
    type: action.type,
    repo: action.repo,
    list: action.list,
    name: action.name,
    description: action.description,
    private: action.private,
    create: action.create
  };
}

function parseActionPlan(content) {
  const clean = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(clean);
  const actions = Array.isArray(parsed.actions) ? parsed.actions.map(normalizeAction).filter(Boolean) : [];
  return {
    reply: String(parsed.reply || "").trim(),
    actions
  };
}

function normalizeAction(action) {
  const type = String(action?.type || "").trim();
  if (type === "create_list") {
    const name = String(action.name || "").trim();
    if (!name) return null;
    return {
      type,
      name,
      description: String(action.description || ""),
      private: Boolean(action.private)
    };
  }
  if (type === "delete_list") {
    const name = String(action.name || "").trim();
    if (!name) return null;
    return {
      type,
      name
    };
  }
  if (type === "add_repo_to_list" || type === "remove_repo_from_list") {
    const repo = String(action.repo || "").trim();
    const list = String(action.list || "").trim();
    if (!repo || !list) return null;
    return {
      type,
      repo,
      list,
      create: Boolean(action.create)
    };
  }
  return null;
}

function extractText(message) {
  return (message.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function codexModelScore(id) {
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?-codex(?:-(.+))?$/i);
  if (!match) return 0;
  const major = Number(match[1] || 0);
  const minor = Number(match[2] || 0);
  const suffix = match[3] || "";
  const variantScore = suffix === "" ? 100 : suffix === "max" ? 80 : suffix === "spark" ? 70 : suffix === "mini" ? 50 : 10;
  return major * 10000 + minor * 100 + variantScore;
}

function piAuthHint(provider) {
  if (provider === "openai-codex") return "Run: gham codex login.";
  if (provider === "openai") return "Set OPENAI_API_KEY in this shell.";
  if (provider === "anthropic") return "Set ANTHROPIC_API_KEY in this shell.";
  if (provider === "google") return "Set GEMINI_API_KEY or GOOGLE_API_KEY in this shell.";
  return "Set the provider API key environment variable.";
}
