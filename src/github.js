const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const DEFAULT_READ_DELAY_MS = 150;
const DEFAULT_WRITE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 2;

let requestQueue = Promise.resolve();
let lastRequestAt = 0;

export function tokenFromConfig(config) {
  return process.env.GITHUB_TOKEN || config.github?.token || "";
}

export async function validateToken(token) {
  const user = await githubRequest("/user", { token });
  return {
    login: user.login,
    id: user.id,
    html_url: user.html_url
  };
}

export async function listStarredRepos(token, { maxPages = 100 } = {}) {
  const repos = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const items = await githubRequest(`/user/starred?per_page=100&page=${page}&sort=created&direction=desc`, {
      token,
      accept: "application/vnd.github.star+json"
    });
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      const repo = item.repo || item;
      repos.push(normalizeRepo(repo, item.starred_at));
    }
    if (items.length < 100) break;
  }
  return repos;
}

export async function starRepo(token, fullName) {
  const { owner, repo } = splitRepo(fullName);
  await githubRequest(`/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    method: "PUT",
    expectEmpty: true
  });
}

export async function unstarRepo(token, fullName) {
  const { owner, repo } = splitRepo(fullName);
  await githubRequest(`/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    method: "DELETE",
    expectEmpty: true
  });
}

export function normalizeRepo(repo, starredAt) {
  return {
    id: repo.id,
    full_name: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login || repo.full_name?.split("/")[0] || "",
    description: repo.description || "",
    html_url: repo.html_url,
    language: repo.language || "",
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    stargazers_count: repo.stargazers_count || 0,
    forks_count: repo.forks_count || 0,
    archived: Boolean(repo.archived),
    fork: Boolean(repo.fork),
    private: Boolean(repo.private),
    pushed_at: repo.pushed_at || null,
    updated_at: repo.updated_at || null,
    starred_at: starredAt || null
  };
}

export function splitRepo(fullName) {
  const [owner, repo] = String(fullName).split("/");
  if (!owner || !repo) throw new Error(`Expected owner/repo, got "${fullName}".`);
  return { owner, repo };
}

export async function githubGraphql(token, query, variables = {}) {
  if (!token) throw new Error("GitHub token is required. Run: gham auth set-token");
  const { response, text, payload } = await githubFetch(GITHUB_GRAPHQL, {
    method: "POST",
    mutating: isGraphqlMutation(query),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-ai-manager"
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok || payload?.errors?.length) {
    const detail = enrichGitHubError(payload?.errors?.map((error) => error.message).join("; ") || payload?.message || text || response.statusText);
    throw new Error(`GitHub GraphQL failed (${response.status}): ${detail}`);
  }
  return payload.data;
}

export async function githubRequest(path, { token, method = "GET", accept = "application/vnd.github+json", expectEmpty = false } = {}) {
  if (!token) throw new Error("GitHub token is required. Run: gham auth set-token");
  const { response, text, payload } = await githubFetch(`${GITHUB_API}${path}`, {
    method,
    mutating: isMutatingMethod(method),
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-ai-manager"
    }
  });
  if (response.status === 204 && expectEmpty) return null;
  if (!response.ok) {
    const detail = enrichGitHubError(payload?.message || text || response.statusText);
    throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload;
}

async function githubFetch(url, { mutating = false, ...options } = {}) {
  const maxRetries = integerEnv("GHAM_GITHUB_MAX_RETRIES", DEFAULT_MAX_RETRIES);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await paceGitHubRequest(mutating);
    const response = await fetch(url, options);
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    const retryDelay = githubRetryDelayMs(response, payload, attempt);
    if (retryDelay > 0 && attempt < maxRetries) {
      await sleep(retryDelay);
      continue;
    }
    return { response, text, payload };
  }
  throw new Error("GitHub request retry loop ended unexpectedly.");
}

async function paceGitHubRequest(mutating) {
  const delayMs = integerEnv(
    mutating ? "GHAM_GITHUB_WRITE_DELAY_MS" : "GHAM_GITHUB_READ_DELAY_MS",
    mutating ? DEFAULT_WRITE_DELAY_MS : DEFAULT_READ_DELAY_MS
  );
  const run = requestQueue.then(async () => {
    const waitMs = Math.max(0, lastRequestAt + delayMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
  });
  requestQueue = run.catch(() => {});
  await run;
}

function githubRetryDelayMs(response, payload, attempt) {
  const message = [
    payload?.message,
    ...(Array.isArray(payload?.errors) ? payload.errors.map((error) => error?.message) : [])
  ].filter(Boolean).join(" ").toLowerCase();
  const hasRateLimitMessage = /secondary rate limit|abuse detection|rate limit/.test(message);
  if (response.status === 200 && hasRateLimitMessage) {
    return Math.min(60000, 5000 * (attempt + 1));
  }
  if (![403, 429, 500, 502, 503, 504].includes(response.status)) return 0;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (remaining === 0 && Number.isFinite(reset) && reset > 0) {
    return Math.max(1000, (reset * 1000) - Date.now() + 1000);
  }
  if (response.status === 403 && hasRateLimitMessage) {
    return Math.min(60000, 5000 * (attempt + 1));
  }
  if ([429, 500, 502, 503, 504].includes(response.status)) {
    return Math.min(30000, 1000 * (2 ** attempt));
  }
  return 0;
}

function isGraphqlMutation(query) {
  return /^\s*mutation\b/i.test(String(query || ""));
}

function isMutatingMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "GET").toUpperCase());
}

function integerEnv(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enrichGitHubError(detail) {
  const message = String(detail || "");
  if (/resource not accessible by personal access token/i.test(message)) {
    return `${message}. Check that the configured GitHub token can perform this GraphQL mutation; some fine-grained tokens can read data but cannot mutate user-level Star Lists.`;
  }
  return message;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
