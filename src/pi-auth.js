import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataPath } from "./storage.js";

export const CODEX_PROVIDER_ID = "openai-codex";

const AUTH_PATH = dataPath("pi-auth.json");

export function createPiCredentialStore() {
  return new FileCredentialStore();
}

export async function readPiCredential(providerId) {
  const state = await readAuthState();
  return state[providerId];
}

class FileCredentialStore {
  async read(providerId) {
    return readPiCredential(providerId);
  }

  async modify(providerId, fn) {
    const state = await readAuthState();
    const current = state[providerId];
    const next = await fn(current);
    if (next !== undefined) {
      state[providerId] = next;
      await writeAuthState(state);
    }
    return state[providerId];
  }

  async delete(providerId) {
    const state = await readAuthState();
    delete state[providerId];
    await writeAuthState(state);
  }
}

async function readAuthState() {
  try {
    return JSON.parse(await readFile(AUTH_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeAuthState(state) {
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await chmod(AUTH_PATH, 0o600).catch(() => {});
}
