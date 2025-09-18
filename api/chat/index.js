// api/chat/index.js
const fs = require("fs");
const path = require("path");

// ---------- load & cache instruction files ----------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";

function readIfExists(p){ try{ return fs.readFileSync(p,"utf8"); } catch{ return ""; } }
function initConfig(){
  if (SYS_PROMPT) return; // only on cold start
  const cfgDir = path.join(__dirname, "../_config");
  SYS_PROMPT       = readIfExists(path.join(cfgDir, "system_prompt.txt")).trim();
  FAQ_SNIPPET      = readIfExists(path.join(cfgDir, "faqs.txt")).trim();
  POLICIES_SNIPPET = readIfExists(path.join(cfgDir, "policies.txt")).trim();

  if (FAQ_SNIPPET) {
    SYS_PROMPT += `

# FAQ (summarize when relevant)
${FAQ_SNIPPET}`.trim();
  }
  if (POLICIES_SNIPPET) {
    SYS_PROMPT += `

# Policy notes (adhere to these)
${POLICIES_SNIPPET}`.trim();
  }

  SYS_PROMPT += `

# Conversation guidance (do not quote this):
- Ask at most two brief clarifying questions before offering a next step.
- Then offer a concise, concrete recommendation (therapy, psychiatry, or both) with a short rationale.
- Offer in-network matching; ask for only the information that is missing (insurance and location).
- Routine help requests are not crisis; only explicit imminent risk is crisis.
- Keep responses concise, natural, and varied. Plain text only.`;
}

// ---------- AOAI helper ----------
async function callAOAI(url, messages, temperature, maxTokens, apiKey){
  const resp = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "api-key": apiKey },
    body: JSON.stringify({ messages, temperature, max_completion_tokens: maxTokens })
  });
  const ct = resp.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await resp.json() : { text: await resp.text() };
  return { resp, data };
}

// ---------- Azure AI Search (optional grounding) ----------
async function querySearch(q){
  const endpoint = ((process.env.AZURE_SEARCH_ENDPOINT||"")+"").trim().replace(/\/+$/,"");
  const key      = ((process.env.AZURE_SEARCH_KEY||"")+"").trim();
  const index    = ((process.env.AZURE_SEARCH_INDEX||"")+"").trim();
  const semantic = ((process.env.AZURE_SEARCH_SEMANTIC_CONFIG||"")+"").trim();
  if (!endpoint || !key || !index || !q) return [];

  const url = `${endpoint}/indexes/${encodeURIComponent(index)}/docs/search?api-version=2023-11-01`;
  const body = {
    search: q,
    top: 5,
    queryType: "semantic",
    semanticConfiguration: semantic || undefined,
    queryLanguage: "en-us",
    speller: "lexicon",
    captions: "extractive",
    answers: "extractive|count-3"
  };
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "api-key": key },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(()=> ({}));
  if (!r.ok) return [];
  const items = (data.value||[]).map(doc => ({
    text: (doc["@search.captions"]?.[0]?.text) || doc.content || doc.text || "",
    source: doc.source || doc.url || doc.type || "",
    score: doc["@search.score"]
  })).filter(x => x.text && x.text.trim());
  return items.slice(0,3);
}

// detect “opener-ish” responses so we can nudge progress
const looksLikeOpener = (txt) =>
  /can you (share|tell)|what’s been going on|how (has|is) that|can you say more/i.test((txt||""));

// extract user-provided insurance/city/zip from recent messages (for facts, not templating)
function extractUserInfo(normalizedHistory, userMessage){
  const transcriptWindow = [...normalizedHistory.map(m => m.content), userMessage].join(" ").toLowerCase();

  const INS_PAT = /\b(bcbs|blue\s*cross|bluecross|aetna|cigna|uhc|united\s*healthcare|kaiser|medicare|medicaid|tricare|ambetter)\b/i;
  const insMatch = transcriptWindow.match(INS_PAT);
  const insuranceDetected = insMatch ? insMatch[1].toUpperCase().replace(/\s+/g," ") : "";

  const ZIP_PAT = /\b\d{5}\b/;
  const CITY_PAT = /\b(phoenix|scottsdale|tempe|mesa|chandler|glendale|tucson|flagstaff|yuma|peoria|gilbert)\b/i; // extend as needed
  const zipDetected = (transcriptWindow.match(ZIP_PAT) || [])[0] || "";
  const cityDetected = (transcriptWindow.match(CITY_PAT) || [])[0] || "";

  return { insuranceDetected, zipDetected, cityDetected };
}

module.exports = async function (context, req){
  try{
    initConfig();

    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // history from client (window size unchanged except what you set)
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const normalizedHistory = history.slice(-24).map(m => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: ((m?.content || '') + '').trim()
    })).filter(m => m.content);

    // env vars for AOAI
    const apiVersion = ((process.env.AZURE_OPENAI_API_VERSION||"2024-08-01-preview")+"").trim();
    const endpoint   = ((process.env.AZURE_OPENAI_ENDPOINT||"")+"").trim().replace(/\/+$/,"");
    const deployment = ((process.env.AZURE_OPENAI_DEPLOYMENT||"")+"").trim();
    const apiKey     = ((process.env.AZURE_OPENAI_API_KEY||"")+"").trim();
    if (!endpoint || !deployment || !apiKey){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply:"Hello! (Model not configured yet.)" } };
      return;
    }
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    // ---- Retrieval via Azure AI Search (always-on to improve specificity) ----
    let contextBlock = "";
    let searchItems = [];
    const lastUser = (normalizedHistory.slice().reverse().find(m => m.role==='user') || {}).content || "";
    const retrievalQuery = (userMessage + " " + lastUser).slice(0, 400);
    searchItems = await querySearch(retrievalQuery);
    if (searchItems.length){
      const bullets = searchItems.map(x => `- ${x.text}`).join("\n");
      contextBlock = `

# Retrieved context (for your internal grounding; summarize if used):
${bullets}`;
    }

    // ---- Build messages
    const messages = [
      { role:"system", content:(SYS_PROMPT || "You are a helpful intake assistant.") + contextBlock },
      ...normalizedHistory,
      { role:"user", content:userMessage }
    ];

    // ---- First try
    let { resp, data } = await callAOAI(url, messages, 1, 768, apiKey);
    let choice = data?.choices?.[0];
    let reply  = (choice?.message?.content || "").trim();

    const filtered = choice?.finish_reason === "content_filter" ||
      (Array.isArray(data?.prompt_filter_results) && data.prompt_filter_results.some(r => {
        const cfr = r?.content_filter_results; return cfr && Object.values(cfr).some(v => v?.filtered);
      }));

    // progression checks
    const lastTurns = normalizedHistory.slice(-24);
    const clarifiersAsked = lastTurns.filter(m => m.role==='assistant' && /\?\s*$/.test(m.content)).length;

    // --- If empty/filtered OR still an opener after 2 clarifiers: one more LLM nudge (no canned text)
    if (((!reply || filtered) || (clarifiersAsked >= 2 && looksLikeOpener(reply))) && resp.ok){
      const { insuranceDetected, zipDetected, cityDetected } = extractUserInfo(normalizedHistory, userMessage);
      const hasLocation  = !!(zipDetected || cityDetected);
      const hasInsurance = !!insuranceDetected;
      const locStr = cityDetected ? cityDetected : (zipDetected ? `ZIP ${zipDetected}` : "");

      // Neutral, model-led style nudge (not a template)
      const styles = ["warm-brief", "reassuring-practical", "concise-direct"];
      const styleTag = styles[Math.floor(Math.random() * styles.length)];
      const facts = [
        hasInsurance ? `insurance: ${insuranceDetected}` : null,
        hasLocation ? `location: ${locStr || "unspecified"}` : null
      ].filter(Boolean).join("; ");

      const styleNudge = `
You are continuing an intake chat. Write a natural, human reply (1–3 concise sentences, plain text).
- Vary wording; do not repeat prior phrasing verbatim. Style: ${styleTag}.
- Use only what is necessary from the conversation and retrieved context.
- If some details are already known, acknowledge them briefly.
- Ask for only the missing detail(s) if needed; otherwise offer the next concrete step.
Known facts this turn: ${facts || "none"}.`;

      const nudged = [
        { role:"system", content:(SYS_PROMPT || "You are a helpful intake assistant.") + contextBlock + "\n\n# Style Nudge (do not output this)\n" + styleNudge },
        ...normalizedHistory,
        { role:"user", content:userMessage }
      ];
      const second = await callAOAI(url, nudged, 1, 768, apiKey);
      resp = second.resp; data = second.data; choice = data?.choices?.[0];
      const reply2 = (choice?.message?.content || "").trim();
      if (resp.ok && reply2) reply = reply2;
    }

    if (!resp.ok){
      context.res = { status:502, headers:{ "Content-Type":"application/json" }, body:{ error:"LLM error", status:resp.status, detail:data } };
      return;
    }
    // optional debug
    if (req.query?.debug === "1"){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{
        reply, finish_reason: choice?.finish_reason, usage: data?.usage,
        sys_prompt_bytes: (SYS_PROMPT||"").length,
        files_present: { system_prompt: !!SYS_PROMPT, faqs: !!FAQ_SNIPPET, policies: !!POLICIES_SNIPPET },
        search_used: !!searchItems.length, search_items: searchItems,
        history_len: normalizedHistory.length
      }};
      return;
    }

    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };
  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
