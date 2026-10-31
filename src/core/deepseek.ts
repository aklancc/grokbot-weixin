import type { BridgeApp } from "./app.js";
import type { InboundEvent } from "./types.js";
import { appFetch } from "./app.js";
import { logWarn, publicError } from "./log.js";
import { sendBridgeText } from "./send.js";

const SYSTEM_PROMPT = "你是一个通过微信与用户交流的中文 AI 助手。请用自然、清晰、简洁的中文回答。遇到不确定的信息要明确说明，不要编造。";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { message?: string };
};

/** Generate a reply with any OpenAI Chat Completions-compatible provider. */
export async function replyWithAI(app: BridgeApp, event: InboundEvent): Promise<boolean> {
  const { aiApiBase, aiApiKey, aiModel } = app.config;
  if (!aiApiKey || !aiApiBase || !aiModel) {
    logWarn("ai_not_configured", { message_id: event.message_id });
    return false;
  }

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const turn of event.history) {
    messages.push({ role: turn.role, content: turn.text.slice(0, 8_000) });
  }

  const attachmentNotes = event.media
    .map((item) => {
      const detail = [item.kind, item.file_name, item.transcript].filter(Boolean).join("，");
      return detail ? \`[收到附件：\${detail}]\` : \`[收到\${item.kind}附件]\`;
    })
    .join("\\n");
  const quote = event.quote?.text || event.quote?.title || "";
  const current = [event.text, attachmentNotes, quote ? \`[引用内容：\${quote}]\` : ""]
    .filter(Boolean)
    .join("\\n")
    .slice(0, 12_000);
  messages.push({ role: "user", content: current || "用户发送了一条消息，请自然回应。" });

  try {
    const endpoint = \`\${aiApiBase.replace(/\\/+$/, "")}/chat/completions\`;
    const response = await appFetch(app)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${aiApiKey}\`,
      },
      body: JSON.stringify({
        model: aiModel,
        messages,
        temperature: 0.7,
        max_tokens: 1_200,
        stream: false,
      }),
    });
    const data = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) {
      logWarn("ai_provider_rejected", {
        status: response.status,
        provider: new URL(aiApiBase).hostname,
        message: data.error?.message?.slice(0, 300) ?? "unknown",
      });
      await sendBridgeText(app, { to: event.sender.id, text: "我暂时无法生成回复，请稍后再试。", ...(event.context_token ? { contextToken: event.context_token } : {}) });
      return false;
    }
    const raw = data.choices?.[0]?.message?.content;
    const answer = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "").trim();
    if (!answer) throw new Error("AI provider returned an empty answer");
    const result = await sendBridgeText(app, {
      to: event.sender.id,
      text: answer.slice(0, 4_000),
      ...(event.context_token ? { contextToken: event.context_token } : {}),
    });
    return result.ok;
  } catch (err) {
    logWarn("ai_provider_failed", { message_id: event.message_id, error: publicError(err) });
    await sendBridgeText(app, { to: event.sender.id, text: "刚才回复失败了，请稍后再发一次。", ...(event.context_token ? { contextToken: event.context_token } : {}) });
    return false;
  }
}

/** Backwards-compatible export for integrations that used the old function name. */
export const replyWithDeepSeek = replyWithAI;
