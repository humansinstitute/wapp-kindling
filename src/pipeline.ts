import { PIPELINE_NAME, WINGMAN_URL } from "./config.ts";
import type { Message } from "./db.ts";

export type PipelineStartInput = {
  chatId: string;
  userPubkey: string;
  userNpub: string;
  message: string;
  history: Array<Pick<Message, "role" | "content" | "createdAt">>;
  webhookUrl: string;
  webhookToken: string;
  autopilotUrl?: string;
  pipelineName?: string;
};

export type PipelineStartResult = {
  mode: "autopilot-http" | "mock";
  runId: string;
  status: "running" | "mocked";
};

export type PipelineTriggerRequest = {
  url: string;
  method: "POST";
  body: {
    input: {
      source: "chat-wapp";
      chatId: string;
      userPubkey: string;
      userNpub: string;
      message: string;
      history: Array<Pick<Message, "role" | "content" | "createdAt">>;
      webhook: {
        url: string;
        token: string;
        authHeader: "x-chat-wapp-token";
      };
    };
  };
};

export function buildPipelineTriggerRequest(input: PipelineStartInput): PipelineTriggerRequest {
  const autopilotUrl = (input.autopilotUrl || WINGMAN_URL).replace(/\/$/, "");
  if (!autopilotUrl) throw new Error("Autopilot URL is required");
  const pipelineName = input.pipelineName || PIPELINE_NAME;
  const url = new URL(`/api/pipelines/triggers/http/${encodeURIComponent(pipelineName)}`, autopilotUrl);
  return {
    url: url.toString(),
    method: "POST",
    body: {
      input: {
        source: "chat-wapp",
        chatId: input.chatId,
        userPubkey: input.userPubkey,
        userNpub: input.userNpub,
        message: input.message,
        history: input.history,
        webhook: {
          url: input.webhookUrl,
          token: input.webhookToken,
          authHeader: "x-chat-wapp-token",
        },
      },
    },
  };
}

export async function startChatPipeline(input: PipelineStartInput, authorization?: string): Promise<PipelineStartResult> {
  return startPreparedChatPipeline(buildPipelineTriggerRequest(input), authorization);
}

export async function startPreparedChatPipeline(trigger: PipelineTriggerRequest, authorization?: string): Promise<PipelineStartResult> {
  return startAutopilotHttpPipeline(trigger, authorization);
}

async function startAutopilotHttpPipeline(trigger: PipelineTriggerRequest, authorization?: string): Promise<PipelineStartResult> {
  const res = await fetch(trigger.url, {
    method: trigger.method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(trigger.body),
  });
  const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof payload.error === "string" ? payload.error : res.statusText;
    throw new Error(`Autopilot trigger failed (${res.status}): ${detail}`);
  }
  const run = payload.run && typeof payload.run === "object" ? payload.run as Record<string, unknown> : {};
  return {
    mode: "autopilot-http",
    runId: String(run.id ?? payload.runId ?? crypto.randomUUID()),
    status: "running",
  };
}
