# Buyer-Intent Prompt Generation

## The Goal

The prompts sent to LLM providers need to simulate the queries that real buyers would type into an AI assistant when researching products in the company's category. If Acme Corp sells CRM software, the prompts should be the kinds of questions a sales manager would ask an AI before purchasing a CRM.

These prompts need to be:
- **Realistic**: Phrased the way a real human would ask, not like a keyword list
- **Varied**: Covering different stages of the buying journey
- **Contextual**: Tailored to the company's specific industry, products, and use cases
- **Balanced**: Mix of branded ("compare Acme to competitors") and unbranded ("best CRM for SMBs") queries

---

## The Two-Step Generation Process

Prompt generation is Step 2 in the pipeline, and it depends on Step 1 (company context).

### Step 1: Build Company Context

Before generating prompts, the system builds a rich profile of the company using an LLM:

```typescript
// prompt.service.ts
const context = await buildCompanyContext({
  companyName,
  website,
  description,
  competitors,
});
```

The LLM is asked to return:
```json
{
  "industry": "CRM Software",
  "products": ["Sales CRM", "Marketing Hub", "Service Hub"],
  "services": ["Implementation", "Training", "24/7 Support"],
  "audience": ["SMBs", "Enterprise sales teams", "B2B companies"],
  "useCases": ["Lead tracking", "Pipeline management", "Deal forecasting"],
  "keywords": ["crm software", "sales pipeline", "contact management", "b2b crm"]
}
```

This context is what makes the prompts specific rather than generic. Without it, you'd get prompts like "What is the best software?" With it, you get "What is the best CRM for tracking B2B sales pipelines?"

### Step 2: Generate Category Prompts

```typescript
const promptCount = await generateAndStorePrompts(analysisId, companyName, context);
```

The LLM is given the company context and asked to generate `PROMPTS_PER_CATEGORY` prompts for each category in `PROMPT_CATEGORIES`.

The generation prompt:
```
You are a buyer-intent prompt generator for AI visibility analysis.

Company: "Acme Corp"
Industry: CRM Software
Products: Sales CRM, Marketing Hub
Audience: SMBs, Enterprise sales teams
Use cases: Lead tracking, Pipeline management
Competitors: Rival Inc, OtherCo

Generate {PROMPTS_PER_CATEGORY} search prompts for each category below.
Prompts should be phrased naturally, as a buyer would type into an AI assistant.
Mix branded (mentioning Acme) and unbranded queries.

Categories:
- Comparison: Prompts asking to compare this company with alternatives
- Buying: Prompts from someone ready to purchase
- Pricing: Prompts about cost and value
- Reviews: Prompts seeking opinions and feedback
- Features: Prompts about specific capabilities
- Alternatives: Prompts explicitly looking for alternatives

Return JSON array:
[{ "category": "Comparison", "prompt": "..." }, ...]
```

---

## What "Dynamic" Means Here

These prompts are not static templates. They're generated fresh for each analysis using the company's specific context. Two different CRM companies would generate different prompts:

**Acme Corp** (focused on SMBs, has a free tier):
```
"What's the best free CRM for a 10-person sales team?"
"Compare Acme Corp vs HubSpot for small business pipeline management"
"Is Acme Corp worth it for a bootstrapped startup?"
```

**EnterpriseForce** (focused on large enterprise, complex pricing):
```
"What CRM integrates best with SAP for Fortune 500 companies?"
"Compare EnterpriseForce vs Salesforce for global sales operations"
"What's the TCO of EnterpriseForce vs Microsoft Dynamics?"
```

The keywords, use cases, and audience segments from the context shape the specific language used.

---

## Category Design

The six default categories are designed to cover the full buying journey:

| Category | Stage | Example prompt |
|---|---|---|
| Comparison | Evaluation | "Acme Corp vs Rival Inc — which is better for B2B sales?" |
| Buying | Decision | "Is Acme Corp worth buying for a 50-person team?" |
| Pricing | Decision | "How much does Acme Corp cost compared to alternatives?" |
| Reviews | Research | "What do users say about Acme Corp's customer support?" |
| Features | Research | "Does Acme Corp support automated pipeline stages?" |
| Alternatives | Awareness | "What are the best alternatives to Acme Corp?" |

The **Alternatives** category is deliberately adversarial — it's a query where the company might not even be mentioned (the user is looking for alternatives *to* them). A high mention rate on Alternatives queries is a strong signal: it means AI assistants recommend the company even when the user is trying to move away from it.

---

## Prompt Count and Configuration

```bash
PROMPTS_PER_CATEGORY=2           # default
PROMPT_CATEGORIES="Comparison,Buying,Pricing,Reviews,Features,Alternatives"  # default
```

Default: 6 categories × 2 prompts = **12 prompts per analysis**.

At 12 prompts × 4 providers = 48 search calls. This is a deliberate balance:
- Enough prompts to get statistically meaningful results
- Few enough to complete in under 90 seconds
- Cheap enough to keep per-analysis costs manageable ($0.03–0.08 for search calls)

You can increase `PROMPTS_PER_CATEGORY` to 3 or 4 for higher statistical confidence, or add more categories for broader coverage. The cost and time scale linearly.

---

## User Control: None (By Design)

Users do not write or edit the prompts. They only provide company information. This is intentional:

1. **Consistency**: If users could write their own prompts, results wouldn't be comparable across companies. The ranking and benchmarking only makes sense if all companies are evaluated against similar query types.

2. **Elimination of bias**: Users would naturally write prompts where their company looks good. The system generates unbiased queries that reflect what real buyers actually ask.

3. **Reducing friction**: Users don't have to think about what to ask. They just describe their company.

The tradeoff is that the generated prompts might not perfectly match the specific niche of every company. A user who knows their buyers ask very specific questions (e.g., "What MLM software integrates with Shopify?") can't add that prompt directly. This is a known limitation.

---

## Where Prompts Are Stored

After generation, each prompt is stored as a `Prompt` row:

```sql
Prompt {
  id         -- cuid
  analysisId -- FK to AnalysisJob
  category   -- "Comparison"
  prompt     -- "Compare Acme Corp vs Rival Inc for enterprise sales teams"
  createdAt
}
```

These are visible to users in the dashboard (private mode only) in the expandable "Raw Responses" section, showing the exact text that was sent to each provider and the response received.

---

## Robustness: What if Generation Fails?

If `generateAndStorePrompts()` throws, the error propagates and the job fails (unlike brand resolution, which is soft-fail). Prompt generation is not soft-fail because without prompts, there's nothing to search for — the entire analysis is meaningless.

If the LLM returns malformed JSON or fewer prompts than expected, the parser logs what it got and stores whatever prompts are valid. A check after storage:

```typescript
const prompts = await prisma.prompt.findMany({ where: { analysisId } });
if (prompts.length === 0) {
  throw new Error("No prompts were generated");
}
```

This turns a silent failure (LLM returned empty array) into an explicit job failure with a clear error message.
