import type { BridgeApp } from "./app.js";
import { appNow } from "./app.js";
import {
  HISTORY_RESET_ACK,
  MAX_LONG_POLL_MS,
  MESSAGE_TYPE_BOT,
  MIN_LONG_POLL_MS,
  SESSION_PAUSE_MS,
  STALE_TOKEN_ERRCODE,
  TYPING_TICKET_TTL_MS,
} from "./constants.js";
import { clearPeerHistory, isHistoryReset, rememberInbound } from "./history.js";
import { KEYS } from "./keys.js";
import { logError, logInfo, logWarn, publicError } from "./log.js";
import { isForwardable, messageDedupeId, normalizeInbound } from "./normalize.js";
import { resolveInboundMedia, sweepMedia } from "./media.js";
import {
  readAllowlist,
  readContextTokens,
  readDedupe,
  readSession,
  readTypingTickets,
  rememberId,
  writeAllowlist,
  writeContextTokens,
  writeDedupe,
  writeTypingTickets,
  type StoredSession,
} from "./state.js";
import { sendBridgeText } from "./send.js";
import type { GetUpdatesResp, WeixinMessage } from "./types.js";
import { replyWithAI } from "./deepseek.js";

export interface PollStepOutcome {
  /** Delay before the next poll. The long poll itself already waited. */
  nextDelayMs: number;
  /** False when there is no session, so the Worker should not arm another alarm. */
  schedule: boolean;
  polled: boolean;
}

/**
 * One getUpdates round: persist the cursor, dedupe, forward allowlisted DMs,
 * and optionally send a typing indicator. A single bad message cannot throw
 * out of this function.
 */
export async function runPollStep(app: BridgeApp): Promise<PollStepOutcome> {
  const session = await readSession(app.storage);
  if (!session) return { nextDelayMs: 5_000, schedule: false, polled: false };
  const now = appNow(app);
  const pausedFor = await pauseRemaining(app, now);
  if (pausedFor > 0) return { nextDelayMs: pausedFor, schedule: true, polled: false };

  const baseUrl = session.baseUrl || app.config.ilinkApiBase;
  await notifyOnce(app, session, baseUrl);
  const cursor = (await app.storage.get(KEYS.cursor)) ?? "";
  const timeoutMs = await nextTimeout(app);
  const started = appNow(app);

  let response: GetUpdatesResp;
  try {
    response = await app.client.getUpdates({
      baseUrl,
      token: session.botToken,
      cursor,
      timeoutMs,
    });
  } catch (err) {
    const delay = await failureDelay(app);
    logError("getupdates_failed", { error: publicError(err) });
    return { nextDelayMs: delay, schedule: true, polled: true };
  }

  if (isApiError(response)) {
    if (response.ret === STALE_TOKEN_ERRCODE || response.errcode === STALE_TOKEN_ERRCODE) {
      const until = now + SESSION_PAUSE_MS;
      await app.storage.set(KEYS.pauseUntil, String(until));
      await app.storage.set(KEYS.pollFailures, "0");
      logError("session_paused", { account_id: session.accountId, until });
      return { nextDelayMs: SESSION_PAUSE_MS, schedule: true, polled: true };
    }
    const delay = await failureDelay(app);
    logError("getupdates_rejected", {
      ret: response.ret ?? null,
      errcode: response.errcode ?? null,
    });
    return { nextDelayMs: delay, schedule: true, polled: true };
  }

  const failureFlag = await app.storage.get(KEYS.pollFailures);
  if (failureFlag && failureFlag !== "0") await app.storage.set(KEYS.pollFailures, "0");
  await rememberServerTimeout(app, response.longpolling_timeout_ms, timeoutMs);
  await sweepMedia(app);
  await dispatchMessages(app, session, response.msgs ?? []);
  const nextCursor = response.get_updates_buf;
  if (nextCursor && nextCursor !== cursor) await app.storage.set(KEYS.cursor, nextCursor);
  // A real long poll already waited inside getUpdates. If the API returns an
  // empty batch immediately, wait out the poll window before the next call so
  // a Worker alarm loop stays inside the Free plan request quota.
  const elapsed = Math.max(0, appNow(app) - started);
  const idle = (response.msgs ?? []).length === 0;
  const nextDelayMs = idle && elapsed < 1_000 ? timeoutMs : 250;
  return { nextDelayMs, schedule: true, polled: true };
}

async function dispatchMessages(app: BridgeApp, session: StoredSession, messages: WeixinMessage[]): Promise<void> {
  let seen = await readDedupe(app.storage);
  let seenChanged = false;
  let allow = await syncAllowlist(app);
  let allowChanged = false;
  let tokens = await readContextTokens(app.storage);
  let tokensChanged = false;

  for (const msg of messages) {
    try {
      const outcome = await handleMessage(app, session, msg, allow, seen, tokens);
      if (outcome.seen !== seen) {
        seen = outcome.seen;
        seenChanged = true;
      }
      if (outcome.allow) {
        allow = outcome.allow;
        allowChanged = true;
      }
      if (outcome.tokens) {
        tokens = outcome.tokens;
        tokensChanged = true;
      }
    } catch (err) {
      logError("inbound_failed", {
        message_id: msg.message_id ?? null,
        error: publicError(err),
      });
    }
  }

  if (allowChanged) await writeAllowlist(app.storage, allow);
  if (tokensChanged) await writeContextTokens(app.storage, tokens);
  if (seenChanged) await writeDedupe(app.storage, seen);
}

async function handleMessage(
  app: BridgeApp,
  session: StoredSession,
  msg: WeixinMessage,
  allow: string[],
  seen: string[],
  tokens: Record<string, string>,
): Promise<{ seen: string[]; allow?: string[]; tokens?: Record<string, string> }> {
  const sender = msg.from_user_id ?? "";
  if (msg.group_id) {
    logInfo("ignored_group", { sender: sender || null });
    return { seen };
  }
  if (msg.message_type === MESSAGE_TYPE_BOT || (sender && sender === session.accountId)) {
    return { seen };
  }
  const id = messageDedupeId(msg);
  let nextSeen = seen;
  if (id) {
    const remembered = rememberId(seen, id);
    if (remembered.duplicate) return { seen };
    nextSeen = remembered.seen;
  }
  let nextAllow = allow;
  // Fail closed: never let an arbitrary first inbound sender claim a personal bot.
  // The QR scanner is pinned during login when iLink supplies its user id.
  if (!sender || !nextAllow.includes(sender)) {
    logInfo("ignored_sender", { sender: sender || null });
    return { seen: nextSeen, ...(nextAllow !== allow ? { allow: nextAllow } : {}) };
  }
  let nextTokens = tokens;
  if (msg.context_token && tokens[sender] !== msg.context_token) {
    nextTokens = { ...tokens, [sender]: msg.context_token };
  }
  const built = normalizeInbound(msg, session.accountId, app.config.bridgePublicUrl);
  const event = await resolveInboundMedia(app, built);
  if (isForwardable(event)) {
    if (await handleModelCommand(app, event)) {
      return {
        seen: nextSeen,
        ...(nextAllow !== allow ? { allow: nextAllow } : {}),
        ...(nextTokens !== tokens ? { tokens: nextTokens } : {}),
      };
    }
    if (app.config.historyReset && isHistoryReset(event)) {
      await clearPeerHistory(app, sender);
      logInfo("history_reset", { sender });
      const ack = await sendBridgeText(app, {
        to: sender,
        text: HISTORY_RESET_ACK,
        ...(msg.context_token ? { contextToken: msg.context_token } : {}),
      });
      if (ack.ok) await clearPeerHistory(app, sender);
      return {
        seen: nextSeen,
        ...(nextAllow !== allow ? { allow: nextAllow } : {}),
        ...(nextTokens !== tokens ? { tokens: nextTokens } : {}),
      };
    }
    try {
      event.history = await rememberInbound(app, sender, event);
    } catch (err) {
      event.history = [];
      logWarn("history_read_failed", { sender, error: publicError(err) });
    }
    const selectedProvider = (await app.storage.get(KEYS.aiProvider)) ?? "custom";
    const aiApp: BridgeApp =
      selectedProvider === "deepseek"
        ? {
            ...app,
            config: {
              ...app.config,
              aiApiBase: "https://api.deepseek.com",
              aiApiKey: app.config.deepseekApiKey,
              aiModel: "deepseek-chat",
            },
          }
        : app;
    const ok = await replyWithAI(aiApp, event);
    logInfo("inbound_replied", {
      sender,
      message_id: event.message_id,
      type: event.type,
      ok,
    });
    if (ok && app.config.sendTyping && msg.context_token) {
      await sendTypingBestEffort(app, session, sender, msg.context_token);
    }
  }
  return {
    seen: nextSeen,
    ...(nextAllow !== allow ? { allow: nextAllow } : {}),
    ...(nextTokens !== tokens ? { tokens: nextTokens } : {}),
  };
}

async function handleModelCommand(app: BridgeApp, event: import("./types.js").InboundEvent): Promise<boolean> {
  const command = event.text.trim().toLowerCase();
  if (command !== "/model" && !command.startsWith("/model ")) return false;

  const selection = command.slice("/model".length).trim();
  const current = (await app.storage.get(KEYS.aiProvider)) ?? "custom";
  let reply: string;

  if (!selection || selection === "help") {
    reply = [
      "模型切换：",
      "/model deepseek —— 切换到 DeepSeek",
      "/model custom —— 切回 Cloudflare 中配置的自定义模型",
      "/model —— 查看当前模型",
      "",
      `当前模式：${current === "deepseek" ? "DeepSeek（deepseek-chat）" : `自定义（${app.config.aiModel}）`}`,
    ].join("\n");
  } else if (selection === "deepseek") {
    if (!app.config.deepseekApiKey.trim()) {
      reply = "没有检测到原来的 DEEPSEEK_API_KEY。请先在 Cloudflare 中恢复这个 Secret，再发送 /model deepseek。";
    } else {
      await app.storage.set(KEYS.aiProvider, "deepseek");
      reply = "已切换到 DeepSeek（deepseek-chat）。之后的普通消息将使用 DeepSeek。";
    }
  } else if (selection === "custom") {
    await app.storage.delete(KEYS.aiProvider);
    reply = `已切回自定义模型：${app.config.aiModel}。将使用 Cloudflare 中配置的 AI_API_BASE、AI_API_KEY 和 AI_MODEL。`;
  } else {
    reply = "不认识这个模型选项。发送 /model help 查看用法。";
  }

  await sendBridgeText(app, {
    to: event.sender.id,
    text: reply,
    ...(event.context_token ? { contextToken: event.context_token } : {}),
  });
  return true;
}

async function sendTypingBestEffort(
  app: BridgeApp,
  session: StoredSession,
  userId: string,
  contextToken: string,
): Promise<void> {
  const baseUrl = session.baseUrl || app.config.ilinkApiBase;
  try {
    const tickets = await readTypingTickets(app.storage);
    const cached = tickets[userId];
    let ticket = cached && appNow(app) - cached.fetchedAt < TYPING_TICKET_TTL_MS ? cached.ticket : "";
    if (!ticket) {
      const config = await app.client.getConfig({
        baseUrl,
        token: session.botToken,
        userId,
        contextToken,
      });
      if (config.ret !== undefined && config.ret !== 0) return;
      if (!config.typing_ticket) return;
      ticket = config.typing_ticket;
      tickets[userId] = { ticket, fetchedAt: appNow(app) };
      await writeTypingTickets(app.storage, tickets);
    }
    await app.client.sendTyping({
      baseUrl,
      token: session.botToken,
      userId,
      typingTicket: ticket,
    });
  } catch (err) {
    logWarn("typing_failed", { sender: userId, error: publicError(err) });
    const tickets = await readTypingTickets(app.storage);
    if (tickets[userId]) {
      delete tickets[userId];
      await writeTypingTickets(app.storage, tickets);
    }
  }
}

async function syncAllowlist(app: BridgeApp): Promise<string[]> {
  if (app.config.allowFrom.length === 0) return readAllowlist(app.storage);
  const current = await readAllowlist(app.storage);
  if (!sameList(current, app.config.allowFrom)) await writeAllowlist(app.storage, app.config.allowFrom);
  return app.config.allowFrom;
}

async function notifyOnce(app: BridgeApp, session: StoredSession, baseUrl: string): Promise<void> {
  const flag = await app.storage.get(KEYS.notifyStarted);
  if (flag === session.accountId) return;
  try {
    await app.client.notifyStart({ baseUrl, token: session.botToken });
    await app.storage.set(KEYS.notifyStarted, session.accountId);
  } catch (err) {
    logWarn("notify_start_failed", { error: publicError(err) });
  }
}

async function pauseRemaining(app: BridgeApp, now: number): Promise<number> {
  const raw = await app.storage.get(KEYS.pauseUntil);
  if (!raw) return 0;
  const until = Number(raw);
  if (!Number.isFinite(until) || until <= now) {
    await app.storage.delete(KEYS.pauseUntil);
    return 0;
  }
  return Math.max(1_000, until - now);
}

async function nextTimeout(app: BridgeApp): Promise<number> {
  const raw = await app.storage.get(KEYS.nextTimeoutMs);
  const parsed = raw ? Number(raw) : app.config.longPollTimeoutMs;
  if (!Number.isFinite(parsed)) return app.config.longPollTimeoutMs;
  return clamp(parsed, MIN_LONG_POLL_MS, MAX_LONG_POLL_MS);
}

async function rememberServerTimeout(app: BridgeApp, suggested: number | undefined, current: number): Promise<void> {
  if (suggested === undefined || suggested <= 0) return;
  const next = clamp(suggested, MIN_LONG_POLL_MS, MAX_LONG_POLL_MS);
  if (next !== current) await app.storage.set(KEYS.nextTimeoutMs, String(next));
}

async function failureDelay(app: BridgeApp): Promise<number> {
  const raw = await app.storage.get(KEYS.pollFailures);
  const failures = (Number(raw ?? "0") || 0) + 1;
  if (failures >= 3) {
    await app.storage.set(KEYS.pollFailures, "0");
    return 30_000;
  }
  await app.storage.set(KEYS.pollFailures, String(failures));
  return 2_000;
}

function isApiError(response: GetUpdatesResp): boolean {
  const retBad = response.ret !== undefined && response.ret !== 0;
  const codeBad = response.errcode !== undefined && response.errcode !== 0;
  return retBad || codeBad;
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
