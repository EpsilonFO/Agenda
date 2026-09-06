/**
 * Tests de la couche LLM : ce qui reste APRÈS providall, c'est-à-dire la
 * traduction propre à l'agenda — outils au dialecte OpenAI, rôles, paliers
 * d'effort. Les protocoles eux-mêmes (Anthropic, chat-completions), les
 * retries et les erreurs typées sont testés dans providall.
 *
 * Aucune requête réelle : `fetch` et `env` sont injectés, et on inspecte le
 * corps qui serait parti — `build()`/`parse()` restent ceux des vrais
 * adaptateurs.
 */

import { describe, expect, it } from "vitest";
import { chatReply, fakeFetch, testEnv, toolCall } from "providall/testing";
import {
  MissingKeyError,
  chatEffort,
  deliberationEffort,
  llmChat,
  retouchEffort,
  textOf,
  type LlmMessage,
  type LlmToolDef,
} from "./llm";

const TOOL: LlmToolDef = {
  type: "function",
  function: {
    name: "list_events",
    description: "Liste les événements",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const CONVERSATION: LlmMessage[] = [
  { role: "system", content: "Tu es Josiane." },
  { role: "user", content: "Mon planning ?" },
];

/** Env OpenAI : le seul fournisseur du registre qui porte `reasoning_effort`. */
const OPENAI = { OPENAI_API_KEY: "sk-test", LLM_MODEL: "gpt-terra" };

describe("llmChat", () => {
  it("aplatit les outils et transmet tool_choice", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    await llmChat({
      messages: CONVERSATION,
      tools: [TOOL],
      toolChoice: "auto",
      fetch: faux.fetch,
      env: testEnv(),
    });

    const body = faux.bodies[0] as any;
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "list_events",
          description: "Liste les événements",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
  });

  it("sort le message système du fil de conversation", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    await llmChat({ messages: CONVERSATION, fetch: faux.fetch, env: testEnv() });

    const messages = (faux.bodies[0] as any).messages;
    expect(messages[0]).toEqual({ role: "system", content: "Tu es Josiane." });
    expect(messages.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(messages[1].content).toBe("Mon planning ?");
  });

  it("renvoie les appels d'outils au format pivot", async () => {
    const faux = fakeFetch([
      chatReply("", { toolCalls: [toolCall("list_events", {})] }),
    ]);
    const message = await llmChat({
      messages: CONVERSATION,
      tools: [TOOL],
      fetch: faux.fetch,
      env: testEnv(),
    });

    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls![0].function.name).toBe("list_events");
    expect(message.tool_calls![0].id).toBeTruthy();
  });

  it("résout le modèle par rôle : LLM_MODEL_PLANNER l'emporte sur LLM_MODEL", async () => {
    const faux = fakeFetch([chatReply("ok"), chatReply("ok")]);
    const env = testEnv({ LLM_MODEL_PLANNER: "gpt-terra", OPENAI_API_KEY: "sk-test" });

    await llmChat({ role: "planner", messages: CONVERSATION, fetch: faux.fetch, env });
    await llmChat({ role: "small", messages: CONVERSATION, fetch: faux.fetch, env });

    expect((faux.bodies[0] as any).model).toBe("gpt-5.6-terra");
    // Rôle sans variable dédiée : on retombe sur LLM_MODEL.
    expect((faux.bodies[1] as any).model).toBe("deepseek-v4-flash");
  });

  it("un modèle explicite l'emporte sur le rôle", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    await llmChat({
      role: "planner",
      model: "gpt-terra",
      messages: CONVERSATION,
      fetch: faux.fetch,
      env: testEnv({ LLM_MODEL_PLANNER: "ds-pro", OPENAI_API_KEY: "sk-test" }),
    });
    expect((faux.bodies[0] as any).model).toBe("gpt-5.6-terra");
  });

  it("active le mode JSON", async () => {
    const faux = fakeFetch([chatReply('{"ok":true}')]);
    const message = await llmChat({
      messages: CONVERSATION,
      json: true,
      fetch: faux.fetch,
      env: testEnv(),
    });

    expect((faux.bodies[0] as any).response_format).toEqual({ type: "json_object" });
    expect(textOf(message)).toBe('{"ok":true}');
  });

  it("applique l'effort de délibération par défaut, ramené à l'échelle du fournisseur", async () => {
    const faux = fakeFetch([chatReply("ok"), chatReply("ok")]);

    // Défaut : xhigh — hors échelle OpenAI (none|low|medium|high) → high.
    await llmChat({ messages: CONVERSATION, fetch: faux.fetch, env: OPENAI });
    expect((faux.bodies[0] as any).reasoning_effort).toBe("high");

    // L'appelant décide : la boucle de chat passe chatEffort().
    await llmChat({
      messages: CONVERSATION,
      effort: chatEffort(OPENAI),
      fetch: faux.fetch,
      env: OPENAI,
    });
    expect((faux.bodies[1] as any).reasoning_effort).toBe("medium");
  });

  it("nomme la variable à renseigner quand la clé manque", async () => {
    await expect(
      llmChat({ messages: CONVERSATION, env: { LLM_MODEL: "gpt-terra" } })
    ).rejects.toThrow(MissingKeyError);
    await expect(
      llmChat({ messages: CONVERSATION, env: { LLM_MODEL: "gpt-terra" } })
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("paliers d'effort", () => {
  it("a un défaut par palier : délibérer coûte cher, bavarder non", () => {
    expect(deliberationEffort({})).toBe("xhigh");
    expect(retouchEffort({})).toBe("high");
    expect(chatEffort({})).toBe("medium");
  });

  it("se surcharge par variable d'environnement", () => {
    expect(deliberationEffort({ LLM_EFFORT: "low" })).toBe("low");
    expect(chatEffort({ LLM_EFFORT_CHAT: "none" })).toBe("none");
    expect(retouchEffort({ LLM_EFFORT_RETOUCH: "max" })).toBe("max");
  });

  it("ignore une valeur invalide plutôt que de la transmettre", () => {
    expect(chatEffort({ LLM_EFFORT_CHAT: "beaucoup" })).toBe("medium");
  });
});

describe("textOf", () => {
  it("rend le texte, quelle que soit la forme du contenu", () => {
    expect(textOf({ role: "assistant", content: "bonjour" })).toBe("bonjour");
    expect(
      textOf({
        role: "assistant",
        content: [
          { type: "text", text: "bon" },
          { type: "text", text: "jour" },
        ],
      })
    ).toBe("bonjour");
    expect(textOf({ role: "assistant", content: null })).toBe("");
    expect(textOf(undefined)).toBe("");
  });
});
