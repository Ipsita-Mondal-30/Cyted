# AI Providers

The system supports four LLM providers: OpenAI, Gemini, Claude, and Groq. Each is used for two distinct roles: **search** (live web-augmented queries) and **complete** (structured JSON generation for context, extraction, recommendations).

---

## Provider Interface

All providers implement `LlmProvider` from `src/lib/providers/types.ts`:

```typescript
interface LlmProvider {
  name: ProviderName;   // "openai" | "gemini" | "claude" | "groq"
  model: string;        // exact model string, e.g. "gpt-4o"
  search(prompt: string): Promise<ProviderSearchResult>;
  complete(system: string, user: string): Promise<string>;
}

type ProviderSearchResult = {
  rawResponse: string;
  latencyMs: number;
  model: string;
  provider: ProviderName;
};
```

`search()` is used for Step 3 (provider search) — it sends the buyer-intent prompt to the model with web search enabled and returns the full text response.

`complete()` is used for Steps 0, 1, 2, 4, 6 — structured JSON generation tasks where live web data is not needed (or actively undesirable).

---

## Provider Implementations

### OpenAI

**File**: `src/lib/providers/openai.ts`  
**Default model**: `gpt-4o`  
**SDK**: `openai` npm package

Uses the **Responses API** (`client.responses.create()`), not the older Chat Completions API. This API natively supports tool use including `web_search_preview`.

```typescript
// search — with live web data
client.responses.create({
  model: "gpt-4o",
  tools: [{ type: "web_search_preview" }],
  input: prompt
})

// complete — no web search, structured JSON
client.responses.create({
  model: "gpt-4o",
  instructions: system,
  input: user
})
```

Response text is extracted from `output[]` items of type `"message"` → `content[]` of type `"output_text"`.

---

### Gemini

**File**: `src/lib/providers/gemini.ts`  
**Default model**: `gemini-2.0-flash`  
**SDK**: `@google/genai`

Uses **Google Search Grounding** for the `search()` call — real-time web results are injected into the model's context by Google's infrastructure.

```typescript
// search — with grounding
client.models.generateContent({
  model: "gemini-2.0-flash",
  contents: [{ role: "user", parts: [{ text: prompt }] }],
  config: {
    tools: [{ googleSearch: {} }]
  }
})

// complete — no grounding, clean JSON generation
client.models.generateContent({
  model: "gemini-2.0-flash",
  contents: [
    { role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }
  ]
})
```

Response text is extracted from `response.candidates[0].content.parts[0].text`.

Gemini is the **preferred provider** for all non-search LLM tasks (`completePreferringGemini()` tries Gemini first). It is also required for prompt generation and company context building (`requireGemini()` / `getPromptLlm()`).

---

### Claude (Anthropic)

**File**: `src/lib/providers/claude.ts`  
**Default model**: `claude-sonnet-4-20250514`  
**SDK**: `@anthropic-ai/sdk`

Uses Anthropic's `web_search_20250305` tool for live web access during search calls.

```typescript
// search — with web search tool
client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 8096,
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  messages: [{ role: "user", content: prompt }]
})

// complete — no tools
client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  system: systemPrompt,
  messages: [{ role: "user", content: userPrompt }]
})
```

Response text is extracted from `response.content[]` items of type `"text"` only — tool-use blocks (`web_search_tool_use`, `web_search_tool_result`) are filtered out.

---

### Groq

**File**: `src/lib/providers/groq.ts`  
**Search model**: `groq/compound` (default)  
**Complete model**: `llama-3.3-70b-versatile` (default)  
**SDK**: `openai` npm package (Groq uses an OpenAI-compatible API)

Groq is unique in using **two different models**: the compound model (`groq/compound`) has built-in web search capability and is used for `search()`. The lighter `llama-3.3-70b-versatile` is used for `complete()` to avoid 413 payload errors on large extraction prompts.

```typescript
// Points the OpenAI SDK at Groq's endpoint
const client = new OpenAI({
  apiKey: groqApiKey,
  baseURL: "https://api.groq.com/openai/v1"
});

// search — compound model with web search
client.chat.completions.create({
  model: "groq/compound",
  messages: [{ role: "user", content: truncate(prompt, 4000) }]
})

// complete — lighter model, no web search
client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [
    { role: "system", content: system },
    { role: "user", content: truncate(user, 24000) }
  ]
})
```

**Hard limits enforced by the Groq provider**:
- Search prompts are hard-truncated to **4,000 characters** before sending
- Complete inputs are hard-truncated to **24,000 characters**
- If the compound model returns a 413 (payload too large), it falls back to `llama-3.3-70b-versatile` for the search call

---

## Provider Manager

**File**: `src/lib/providers/provider-manager.ts`

The provider manager is the single point of control for all provider access. Callers never import a specific provider directly.

### `getEnabledProviders()`

Builds the list of active providers by checking two conditions for each:
1. The API key env var is set (non-empty)
2. The admin toggle in `SystemConfig.enabledProviders` is `true` (or absent)

```
API key set?  →  Yes
Admin toggle? →  Yes (or not set, defaults to true)
              =  Provider is ACTIVE
```

Called fresh on every job — no caching — so admin changes take effect immediately for the next queued job.

Throws if no providers are active: `"No LLM providers enabled. Set an API key and enable the provider in /admin."`

### `getPromptLlm()` / `requireGemini()`

Returns the best available provider for structured JSON generation tasks. Preference order:

```
Gemini → Groq → OpenAI → Claude
```

Logs a warning if falling back to a non-Gemini provider (Gemini is strongly preferred for prompt/context work due to output quality and cost).

### `completePreferringGemini(system, user)`

Used by all service modules for non-search LLM calls (context building, extraction, recommendations). Tries providers in preference order and falls back on any error:

```
1. Try Gemini.complete(system, user)
     → success: return result
     → failure: log warning, try next

2. Try Groq.complete(system, user)
     → success: return result
     → failure: log warning, try next

3. Try OpenAI.complete(system, user)
     → ...

4. Try Claude.complete(system, user)
     → success: return result
     → failure: throw (all providers failed)
```

Returns `{ text, provider, model }` so callers can log which provider actually handled the request.

---

## Provider Usage by Pipeline Step

| Step | Function | Provider used |
|---|---|---|
| 0 — Brand Resolution | `completePreferringGemini()` | Gemini → Groq → OpenAI → Claude |
| 1 — Company Context | `completePreferringGemini()` | Gemini → Groq → OpenAI → Claude |
| 2 — Prompt Generation | `completePreferringGemini()` | Gemini → Groq → OpenAI → Claude |
| 3 — Provider Search | `provider.search()` × all enabled | All enabled providers in parallel |
| 4 — Extraction | `completePreferringGemini()` | Gemini → Groq → OpenAI → Claude |
| 5 — Metrics | (no LLM — pure computation) | — |
| 6 — Recommendations | `completePreferringGemini()` | Gemini → Groq → OpenAI → Claude |

Steps 0–2, 4, 6 use a single provider (best available). Step 3 fans out to all enabled providers simultaneously. Step 5 makes no LLM calls.

---

## Enabling / Disabling Providers

A provider is active when **both** of these are true:
1. Its API key env var is set: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `GROQ_API_KEY`
2. Its toggle in the admin panel (`/admin`) is on — stored in `SystemConfig.enabledProviders`

If a provider key is missing from the environment, the toggle has no effect — the provider will never activate regardless of the admin setting.

Providers can be toggled live via `PUT /api/admin/providers`. Changes take effect for the next job that starts processing (already-running jobs use the providers they started with).

---

## Adding a New Provider

1. Create `src/lib/providers/yourprovider.ts` implementing `LlmProvider`
2. Export a `createYourProvider(apiKey, model)` factory function
3. Add the provider name to the `ProviderName` union in `types.ts`
4. Register it in `getEnabledProviders()` in `provider-manager.ts` with the appropriate env key check
5. Add it to the `preference` order in `completePreferringGemini()` if it should be used for structured tasks
6. Add the API key env var to `config.ts` (Zod schema + `AppConfig` type + `getConfig()` mapping)
7. Add pricing data to `src/lib/ai-pricing.ts` so usage costs are tracked in the admin panel

---

## Retry Behavior

All provider calls are wrapped in `withRetries()` from `src/lib/utils/retry.ts`:

```
Attempt 1 → fail → wait 1s
Attempt 2 → fail → wait 2s
Attempt 3 → fail → wait 4s (MAX_RETRIES default: 2 = 3 total attempts)
                 → throw
```

The backoff doubles each time, capped at 8 seconds. For search calls, a failed response after all retries results in a `Response` row with `error` set (not a job failure). For `complete()` calls in structural steps (context, extraction, recommendations), failure propagates up to the job-level retry.
