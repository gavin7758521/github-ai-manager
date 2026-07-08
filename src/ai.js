import { readConfig, readJson, writeJson } from "./storage.js";
import { createPiCredentialStore } from "./pi-auth.js";

export const MODEL_PRESETS = [
  { provider: "mock", model: "local-rules", note: "No external model; groups by language/topics." },
  { provider: "pi", model: "openai/gpt-4o-mini", note: "Uses @earendil-works/pi-ai built-in providers." },
  { provider: "codex", model: "auto", note: "Alias for the recommended OpenAI Codex model through pi." },
  { provider: "openai-compatible", model: "env", note: "Uses OPENAI_COMPATIBLE_* environment variables." }
];

export async function suggestCollections({ provider, model, limit = 200 } = {}) {
  const config = await readConfig();
  const selectedProvider = provider || config.ai?.provider || "mock";
  const selectedModel = model || (provider && provider !== config.ai?.provider ? defaultModelForProvider(provider) : config.ai?.model) || defaultModelForProvider(selectedProvider);
  const ai = {
    provider: selectedProvider,
    model: selectedModel
  };
  const stars = await readJson("stars", { stars: [] });
  const collections = await readJson("collections", { collections: [] });
  const sample = stars.stars.slice(0, limit);
  const suggestions =
    ai.provider === "mock"
      ? mockSuggest(sample)
      : await modelSuggest(ai, sample, collections);
  const payload = {
    provider: ai.provider,
    model: ai.model,
    created_at: new Date().toISOString(),
    source_count: sample.length,
    ...suggestions
  };
  await writeJson("suggestions", payload);
  return payload;
}

function defaultModelForProvider(provider) {
  if (provider === "pi") return "openai/gpt-4o-mini";
  if (provider === "openai-compatible") return "env";
  return "local-rules";
}

function mockSuggest(stars) {
  const groups = new Map();
  for (const repo of stars) {
    const name = classifyRepo(repo);
    if (!groups.has(name)) {
      groups.set(name, {
        name,
        description: `Repositories related to ${name}.`,
        repos: []
      });
    }
    groups.get(name).repos.push(repo.full_name);
  }
  return {
    collections: [...groups.values()]
      .map((item) => ({ ...item, repos: item.repos.slice(0, 50).sort() }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

function classifyRepo(repo) {
  const text = [
    repo.full_name,
    repo.description,
    repo.language,
    ...(repo.topics || [])
  ].join(" ").toLowerCase();
  if (/\b(ai|llm|agent|openai|gpt|prompt|rag|embedding|model)\b/.test(text)) return "AI";
  if (/\b(react|vue|svelte|frontend|css|tailwind|ui)\b/.test(text)) return "Frontend";
  if (/\b(cli|terminal|shell|zsh|command)\b/.test(text)) return "CLI";
  if (/\b(database|postgres|sqlite|mysql|redis|sql)\b/.test(text)) return "Data";
  if (/\b(devops|kubernetes|docker|terraform|ci|actions)\b/.test(text)) return "DevOps";
  if (repo.language) return repo.language;
  return "Unsorted";
}

async function modelSuggest(ai, stars, collections) {
  if (ai.provider === "openai-compatible") {
    return openAiCompatibleSuggest(stars, collections);
  }
  if (ai.provider === "pi") {
    return piSuggest(ai, stars, collections);
  }
  throw new Error(`Unsupported AI provider "${ai.provider}". Run: gh-ai-client model list`);
}

async function openAiCompatibleSuggest(stars, collections) {
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
      messages: buildMessages(stars, collections)
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "AI request failed.");
  return parseJsonContent(payload?.choices?.[0]?.message?.content);
}

async function piSuggest(ai, stars, collections) {
  let pi;
  try {
    pi = await import("@earendil-works/pi-ai/providers/all");
  } catch {
    throw new Error("pi provider is not installed. Run npm install in the gh-ai-client project.");
  }
  const modelRef = process.env.GH_AI_CLIENT_PI_MODEL || ai.model || "openai/gpt-4o-mini";
  const [provider, ...modelParts] = modelRef.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) {
    throw new Error("pi model must be provider/model, for example: gh-ai-client model use pi:openai/gpt-4o-mini");
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
  const response = await models.completeSimple(model, {
    systemPrompt: "You organize GitHub starred repositories. Return only strict JSON with collections.",
    messages: [{
      role: "user",
      content: buildMessages(stars, collections).map((message) => message.content).join("\n\n"),
      timestamp: Date.now()
    }]
  }, {
    reasoning: "low"
  });
  const text = extractText(response);
  if (!text) {
    throw new Error(`pi model ${provider}/${modelId} returned no text. Try a different model or check provider credentials.`);
  }
  return parseJsonContent(text);
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
  if (provider === "openai-codex") return "Run: gh-ai-client codex login.";
  if (provider === "openai") return "Set OPENAI_API_KEY in this shell.";
  if (provider === "anthropic") return "Set ANTHROPIC_API_KEY in this shell.";
  if (provider === "google") return "Set GEMINI_API_KEY or GOOGLE_API_KEY in this shell.";
  return "Set the provider API key environment variable.";
}

function buildMessages(stars, collections) {
  return [
    {
      role: "system",
      content: "You organize GitHub starred repositories. Return only strict JSON with {\"collections\":[{\"name\":\"...\",\"description\":\"...\",\"repos\":[\"owner/repo\"]}]}. Do not include repositories not present in input."
    },
    {
      role: "user",
      content: JSON.stringify({ stars, existingCollections: collections.collections }, null, 2)
    }
  ];
}

function parseJsonContent(content) {
  const clean = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed.collections)) throw new Error("AI JSON must include collections array.");
  return parsed;
}
