import type { BridgeApp } from "./app.js";
import { appFetch } from "./app.js";

/** Return model IDs from an OpenAI-compatible /models endpoint. */
export async function fetchAvailableModels(app: BridgeApp): Promise<string[]> {
  const { aiApiBase, aiApiKey } = app.config;
  if (!aiApiBase || !aiApiKey.trim()) {
    throw new Error("请先在 Cloudflare 中配置 AI_API_BASE 和 AI_API_KEY。");
  }

  const endpoint = `${aiApiBase.replace(/\/+$/, "")}/models`;
  const response = await appFetch(app)(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${aiApiKey}` },
  });
  if (!response.ok) {
    throw new Error(`模型列表接口返回 HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ id?: unknown }>;
  };
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const unique = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id.trim()) unique.add(entry.id.trim());
  }
  if (unique.size === 0) throw new Error("模型列表为空，或接口返回格式不兼容。");
  return [...unique].sort((a, b) => a.localeCompare(b));
}
