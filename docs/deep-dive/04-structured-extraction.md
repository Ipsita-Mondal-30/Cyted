# Turning Free-Text LLM Responses into Structured Data

## The Problem

Each LLM provider returns a different format, style, and length of response. A search query like "Best CRM for small teams" might return:

**OpenAI**: A bulleted list with Salesforce, HubSpot, and Acme Corp described in paragraphs.  
**Gemini**: A structured comparison table with features and pricing.  
**Claude**: A flowing essay with citations embedded as markdown links.  
**Groq**: A short direct answer with three ranked options.

None of these are machine-readable. To calculate mention rates, share of voice, sentiment, and rankings, you need a consistent structured object from every response.

---

## The Two-Pass Architecture

The system uses a **second LLM call** to extract structure from each raw response. This is Step 4 of the pipeline.

```
Raw response (free text)
        │
        ▼
completePreferringGemini(extractionSystemPrompt, extractionUserPrompt)
        │
        ▼
Structured JSON
{
  mentionedBrands: [],
  mentionedProducts: [],
  citations: [],
  ranking: null | number,
  sentiment: "Positive" | "Neutral" | "Negative",
  reasoning: string
}
```

This is cheaper and more reliable than trying to constrain the original search response to a machine-readable format. The search response benefits from being unconstrained — you want the LLM to respond naturally to the query (like a real user's search would be answered). The extraction pass is a separate, focused task.

---

## The Extraction Prompt Design

The system prompt sets strict expectations:

```
You are a brand visibility extraction assistant. 
Your job is to analyze AI-generated responses and extract structured brand mention data.

You MUST return ONLY valid JSON with exactly these fields:
{
  "mentionedBrands": string[],     // all brand names mentioned, exact as written
  "mentionedProducts": string[],   // specific product names mentioned
  "citations": string[],           // URLs cited as sources
  "ranking": number | null,        // 1-based position of TARGET_COMPANY in any ranked list
  "sentiment": "Positive" | "Neutral" | "Negative",  // toward TARGET_COMPANY only
  "reasoning": string              // brief explanation of your extraction decisions
}
```

The user prompt provides context:

```
Target company: "{companyName}"
Known competitors: {competitors.join(", ")}

AI response to analyze:
---
{rawResponse}
---

Extract brand visibility data. If the target company is not mentioned, 
return empty mentionedBrands (or list only competitor brands mentioned).
For ranking: look for explicit ordered lists (1., #1, "best", "top choice" 
implies ranking 1). If the company is mentioned but not ranked, ranking is null.
```

---

## Why This Works Reliably

### 1. Task Decomposition

The extraction task is much simpler than the search task. You're not asking the LLM to reason about the world — you're asking it to read a short text and fill in a form. LLMs are extremely reliable at this.

### 2. Known Vocabulary

The target company name and competitor names are provided in the prompt. The LLM doesn't need to guess who "Acme" refers to — it's told explicitly. This makes brand matching precise.

### 3. Explicit Schema

Providing the exact JSON structure required reduces hallucination. The LLM has no ambiguity about what fields to return or what types they should be.

### 4. Reasoning Field

The `reasoning` field is a "chain-of-thought" that makes the extraction auditable. If a ranking or sentiment seems wrong, you can inspect the reasoning to understand why the LLM made that call. It also improves accuracy — LLMs reason better when they write their thinking before giving a conclusion.

---

## Parsing and Error Handling

LLMs occasionally return malformed JSON — extra text, markdown code fences, trailing commas. The parser handles this:

```typescript
function parseExtractedJson(text: string) {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Find the outermost JSON object
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found");

  const jsonStr = stripped.slice(start, end + 1);
  return JSON.parse(jsonStr);
}
```

If parsing fails after this normalization:
- The `ExtractedResult` row is not created for this response
- The response is effectively treated as "no brand mention data"
- The job continues — a parse failure on one response doesn't fail the step

---

## What Happens With Disagreement Between Providers

This is covered in depth in `05-provider-disagreement.md`, but the short version: the system doesn't try to reconcile disagreements at extraction time. Each `ExtractedResult` row is the extraction from one `Response` (which came from one `provider × prompt` pair). The metrics are computed over the aggregate, not a consensus.

If OpenAI says `sentiment: "Positive"` and Claude says `sentiment: "Negative"` for the same prompt:
- Both extractions are stored
- The positive sentiment rate is computed as `(positive extractions) / (total extractions)` 
- Both data points count. The contradiction is visible if you inspect the raw response table on the dashboard.

---

## The Provider Used for Extraction

Extraction always uses `completePreferringGemini()` — the non-search, structured-completion path. The preference order is:

```
Gemini → Groq → OpenAI → Claude
```

Gemini is preferred because it:
- Has a large context window (fits long search responses)
- Is fast (flash model)
- Is cheap (extraction costs are significant at scale — 48 calls per analysis)
- Returns clean JSON reliably

Groq's `llama-3.3-70b-versatile` is the fallback — it uses the complete model, not the compound search model, to avoid 413 errors on large payloads.

---

## Cost Implication

Extraction doubles the LLM call count for the analysis. For 48 search responses, you make 48 additional extraction calls. These are not stored as `Response` rows (they're not the primary search — they're a processing step), so they don't appear in the admin cost dashboard.

This is noted explicitly in the codebase:

```typescript
// admin-usage.ts
// NOTE: extraction and recommendation LLM calls are not stored as Response rows.
// Actual spend is higher than what's reported here.
```

In practice, extraction calls are small (input: the raw response + prompt, output: ~200 tokens of JSON) so the per-call cost is much lower than the search calls.

---

## Why Not Use Structured Output / Function Calling?

Modern LLMs support structured output (OpenAI's `response_format: { type: "json_object" }`) and function calling. Why not use those for extraction?

The extraction pass **does** use plain text completion by design:

1. **Cross-provider compatibility**: Structured output is implemented differently across OpenAI, Gemini, Claude, and Groq. Using plain text + a parsing layer is a single code path that works everywhere.

2. **The reasoning field**: Structured output schemas tend to produce less natural reasoning text. The free-form reasoning field is useful for debugging.

3. **The primary search must be free-text**: The search call (Step 3) cannot use structured output because you want the AI to respond naturally to the buyer query, as it would for a real user — not as a form-filler.

The two-pass approach cleanly separates these concerns.
