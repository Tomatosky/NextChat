import { jest } from "@jest/globals";

import { DeepSeekApi } from "../app/client/platforms/deepseek";
import {
  DEFAULT_MODELS,
  REQUEST_TIMEOUT_MS_FOR_THINKING,
  ServiceProvider,
} from "../app/constant";
import { useAccessStore, useChatStore } from "../app/store";
import { DEFAULT_CONFIG } from "../app/store/config";
import {
  getInputTokenBudgetByModel,
  getMaxOutputTokensByModel,
  getTimeoutMSByModel,
} from "../app/utils";
import {
  collectModels,
  getModelProvider,
  isModelNotavailableInServer,
  migrateLegacyDeepSeekModelConfig,
} from "../app/utils/model";

const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 393_216;
const DEEPSEEK_V4_CONTEXT_WINDOW = 1_000_000;

type DeepSeekV4Config = {
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  enable_thinking: boolean;
  max_tokens: number;
  temperature: number;
  top_p: number;
  presence_penalty: number;
  frequency_penalty: number;
};

async function captureRequestPayload(config: DeepSeekV4Config) {
  const session = useChatStore.getState().currentSession();
  Object.assign(session.mask.modelConfig, config, {
    providerName: ServiceProvider.DeepSeek,
  });
  useAccessStore.setState({
    useCustomConfig: false,
    deepseekApiKey: "test-key",
  });

  const fetchMock = jest.fn<typeof window.fetch>();
  fetchMock.mockResolvedValue({
    json: async () => ({ choices: [{ message: { content: "ok" } }] }),
  } as Response);
  window.fetch = fetchMock;

  const api = new DeepSeekApi();
  await api.chat({
    messages: [{ role: "user", content: "hello" }],
    config: {
      ...config,
      providerName: ServiceProvider.DeepSeek,
      stream: false,
    },
    onUpdate: jest.fn(),
    onFinish: jest.fn(),
    onError: (error) => {
      throw error;
    },
  });

  const chatRequest = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith("/chat/completions"),
  );
  expect(chatRequest).toBeDefined();
  const [url, request] = chatRequest!;
  return {
    url: String(url),
    headers: new Headers(request?.headers),
    payload: JSON.parse(request?.body as string) as Record<string, unknown>,
  };
}

describe("DeepSeek V4 models", () => {
  test("registers the current text models under the DeepSeek provider", () => {
    const modelNames = DEFAULT_MODELS.filter(
      (model) => model.provider.providerName === ServiceProvider.DeepSeek,
    ).map((model) => model.name);

    expect(modelNames).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  test("keeps a qualified custom V4 model on the DeepSeek provider", () => {
    const customModelName = "deepseek-v4-preview";
    const [model, provider] = getModelProvider(
      `${customModelName}@${ServiceProvider.DeepSeek}`,
    );
    const models = collectModels(
      DEFAULT_MODELS,
      `-all,+${customModelName}@${ServiceProvider.DeepSeek}`,
    );
    const customModel = models.find((candidate) => candidate.name === model);

    expect(provider).toBe(ServiceProvider.DeepSeek);
    expect(customModel).toMatchObject({
      name: customModelName,
      available: true,
      provider: {
        id: "deepseek",
        providerName: ServiceProvider.DeepSeek,
      },
    });
    expect(
      isModelNotavailableInServer(
        `-all,+${customModelName}@${ServiceProvider.DeepSeek}`,
        customModelName,
        ServiceProvider.DeepSeek,
      ),
    ).toBe(false);
  });

  test.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
    "%s reserves output tokens within the one-million-token context window",
    (model) => {
      expect(getTimeoutMSByModel(model)).toBe(REQUEST_TIMEOUT_MS_FOR_THINKING);
      expect(getInputTokenBudgetByModel(model, 4_000, 4_000)).toBe(
        DEEPSEEK_V4_CONTEXT_WINDOW - 4_000,
      );
      expect(getMaxOutputTokensByModel(model, 512_000)).toBe(
        DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
      );
    },
  );

  test("keeps the fallback context window for non-V4 models", () => {
    expect(getInputTokenBudgetByModel("deepseek-chat", 64_000, 4_000)).toBe(
      64_000,
    );
  });

  test.each([
    ["deepseek-chat", "deepseek-v4-flash", false],
    ["deepseek-coder", "deepseek-v4-flash", false],
    ["deepseek-reasoner", "deepseek-v4-pro", true],
  ])("migrates %s to %s", (legacyModel, currentModel, enableThinking) => {
    const modelConfig = {
      model: legacyModel,
      providerName: ServiceProvider.DeepSeek,
      enable_thinking: false,
    };

    migrateLegacyDeepSeekModelConfig(modelConfig);

    expect(modelConfig).toMatchObject({
      model: currentModel,
      providerName: ServiceProvider.DeepSeek,
      enable_thinking: enableThinking,
    });
  });

  test("migrates an explicitly configured legacy summary model", () => {
    const modelConfig = {
      model: "gpt-4o-mini",
      providerName: ServiceProvider.OpenAI,
      compressModel: "deepseek-reasoner",
      compressProviderName: ServiceProvider.DeepSeek,
    };

    migrateLegacyDeepSeekModelConfig(modelConfig);

    expect(modelConfig.compressModel).toBe("deepseek-v4-pro");
    expect(modelConfig.compressProviderName).toBe(ServiceProvider.DeepSeek);
  });

  test("excludes history that would consume the reserved V4 output budget", async () => {
    const store = useChatStore.getState();
    const session = store.currentSession();
    const originalMessages = session.messages;
    const originalContext = session.mask.context;
    const originalMemoryPrompt = session.memoryPrompt;
    const originalModelConfig = { ...session.mask.modelConfig };
    const oversizedHistory = {
      role: "user" as const,
      content: "a".repeat(2_500_000),
      id: "oversized-history",
      date: "",
    };

    try {
      session.messages = [oversizedHistory];
      session.mask.context = [];
      session.memoryPrompt = "";
      Object.assign(session.mask.modelConfig, {
        model: "deepseek-v4-pro",
        providerName: ServiceProvider.DeepSeek,
        max_tokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
        historyMessageCount: 10,
        sendMemory: false,
      });

      const messages = await store.getMessagesWithMemory({
        role: "user",
        content: "current input",
        id: "current-input",
        date: "",
      });

      expect(messages).not.toContain(oversizedHistory);
    } finally {
      session.messages = originalMessages;
      session.mask.context = originalContext;
      session.memoryPrompt = originalMemoryPrompt;
      Object.assign(session.mask.modelConfig, originalModelConfig);
    }
  });
});

describe("DeepSeek V4 text request", () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  test("keeps thinking disabled by default", () => {
    expect(DEFAULT_CONFIG.modelConfig.enable_thinking).toBe(false);
  });

  test("sends the enabled thinking configuration and clamps maximum output", async () => {
    const { url, headers, payload } = await captureRequestPayload({
      model: "deepseek-v4-flash",
      enable_thinking: true,
      max_tokens: 512_000,
      temperature: 0.4,
      top_p: 0.8,
      presence_penalty: 1,
      frequency_penalty: 1,
    });

    expect(url).toBe("/api/deepseek/chat/completions");
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    expect(payload).toMatchObject({
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
    });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
    expect(payload).not.toHaveProperty("presence_penalty");
    expect(payload).not.toHaveProperty("frequency_penalty");
  });

  test("sends disabled thinking without reasoning effort and clamps the minimum output", async () => {
    const { payload } = await captureRequestPayload({
      model: "deepseek-v4-pro",
      enable_thinking: false,
      max_tokens: 0,
      temperature: 0.5,
      top_p: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
    });

    expect(payload).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      max_tokens: 1,
      temperature: 0.5,
      top_p: 1,
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("presence_penalty");
    expect(payload).not.toHaveProperty("frequency_penalty");
  });
});
