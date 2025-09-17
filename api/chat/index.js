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

# FAQ (summarize when answering)
${FAQ_SNIPPET}`.trim();
  }
  if (POLICIES_SNIPPET) {
    SYS_PROMPT += `

# Policy notes (adhere to these)
${POLICIES_SNIPPET}`.trim();
  }

  SYS_PROMPT += `

# Conversation flow:
- Ask at most 2 brief clarifying questions.
- Then provide a concise recommendation (therapy, psychiatry, or both) with 1–2 sentence rationale.
- Offer to match to an in-network provider; ask for insurance + location if missing.
- Routine help requests are not crisis; only explicit self-harm or immediate danger is crisis.
- Output must be plain text (no tools), keep it concise.`;
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

// crude “opener” detection to stop endless “tell me more”
const looksLikeOpener = (txt) =>
  /can you (share|tell)|what’s been going on|how (has|is) that/i.test((txt||""));

// extract user-provided insurance/city/zip from recent messages
function extractUserInfo(normalizedHistory, userMessage){
  const transcriptWindow = [...normalizedHistory.map(m => m.content), userMessage].join(" ").toLowerCase();

  // insurance
  const INS_PAT = /\b(bcbs|blue\s*cross|bluecross|aetna|cigna|uhc|united\s*healthcare|kaiser|medicare|medicaid|tricare|ambetter)\b/i;
  const insMatch = transcriptWindow.match(INS_PAT);
  const insuranceDetected = insMatch ? insMatch[1].toUpperCase().replace(/\s+/g," ") : "";

  // zip / city
  const ZIP_PAT = /\b\d{5}\b/;
  const CITY_PAT = /\b(phoenix|scottsdale|tempe|mesa|chandler|glendale|tucson|flagstaff|yuma|peoria|gilbert)\b/i; // add more as needed
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

    // history from client 
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

# Retrieved context (use to ground your answer; summarize concisely):
${bullets}`;
    }

    // ---- Build messages
    const messages = [
      { role:"system", content:(SYS_PROMPT || "You are a helpful intake assistant.") + contextBlock },
      ...normalizedHistory,
      { role:"user", content:userMessage }
    ];

    // ---- First try
    let { resp, data } = await callAOAI(url, messages, 1, 384, apiKey);
    let choice = data?.choices?.[0];
    let reply  = (choice?.message?.content || "").trim();

    const filtered = choice?.finish_reason === "content_filter" ||
      (Array.isArray(data?.prompt_filter_results) && data.prompt_filter_results.some(r => {
        const cfr = r?.content_filter_results; return cfr && Object.values(cfr).some(v => v?.filtered);
      }));

    // progression checks
    const lastTurns = normalizedHistory.slice(-6);
    const clarifiersAsked = lastTurns.filter(m => m.role==='assistant' && /\?\s*$/.test(m.content)).length;

    // ---- Retry if empty/filtered or still an opener after 2 clarifiers
    if (((!reply || filtered) || (clarifiersAsked >= 2 && looksLikeOpener(reply))) && resp.ok){
      const nudged = [
        { role:"system", content:(SYS_PROMPT || "You are a helpful intake assistant.") + `
- Always respond in plain text (no tools), 1–2 sentences unless asked for detail.
- If you already asked 2 clarifiers, provide a brief recommendation (therapy, psychiatry, or both) with 1–2 sentence rationale, and offer an in-network match.` + contextBlock },
        ...normalizedHistory,
        { role:"user", content:userMessage }
      ];
      const second = await callAOAI(url, nudged, 1, 256, apiKey);
      resp = second.resp; data = second.data; choice = data?.choices?.[0];
      reply = (choice?.message?.content || "").trim() || reply;
    }

    // --- Smarter fallback that uses detected info instead of re-asking
    const { insuranceDetected, zipDetected, cityDetected } = extractUserInfo(normalizedHistory, userMessage);
    const hasLocation  = !!(zipDetected || cityDetected);
    const hasInsurance = !!insuranceDetected;

    if (!reply || (clarifiersAsked >= 2 && looksLikeOpener(reply))) {
      if (hasInsurance && hasLocation) {
        const locStr = cityDetected ? cityDetected : (zipDetected ? `ZIP ${zipDetected}` : "your area");
        reply = `Great — I have your insurance (${insuranceDetected}) and location (${locStr}). I recommend starting with therapy and adding psychiatry if symptoms persist. I can pull in-network options now. Do you prefer a therapist, psychiatrist, or both?`;
      } else if (hasInsurance && !hasLocation) {
        reply = `Thanks for sharing your insurance (${insuranceDetected}). What city or ZIP should I use to find in-network providers?`;
      } else if (!hasInsurance && hasLocation) {
        const locStr = cityDetected ? cityDetected : (zipDetected ? `ZIP ${zipDetected}` : "your area");
        reply = `Got it — I’ll search around ${locStr}. What insurance plan should I check for in-network providers (e.g., BCBS, Aetna, Cigna, UHC)?`;
      } else {
        reply = "Based on what you’ve shared, I recommend starting with therapy and considering psychiatry if symptoms persist or affect daily life. I can match you with an in-network provider—what’s your insurance and preferred city or ZIP?";
      }
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
        history_len: normalizedHistory.length,
        detected: { insuranceDetected, zipDetected, cityDetected }
      }};
      return;
    }

    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };
  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
