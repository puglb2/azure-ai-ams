// api/chat/index.js
const fs = require("fs");
const path = require("path");

// ---------------------------- Cold-start caches ----------------------------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";
let PROVIDERS = [], SLOTS = [];
let DEBUG_PATHS = { provPath: "", provExists: false, slotPath: "", slotExists: false };

function readIfExists(p){ try{ return fs.readFileSync(p,"utf8"); } catch{ return ""; } }
function exists(p){ try{ return fs.existsSync(p); } catch { return false; } }

// Resolve data dir for common deploy layouts:
//   A) /home/site/wwwroot/api/_data
//   B) /home/site/wwwroot/_data
function resolveDataPath(){
  const fromApi = path.join(__dirname, "../_data");
  const fromRoot = path.join(__dirname, "../../_data");
  if (exists(fromApi)) return fromApi;
  if (exists(fromRoot)) return fromRoot;
  return fromApi; // fallback
}

function initConfig(){
  if (SYS_PROMPT) return; // cold start only

  const cfgDir  = path.join(__dirname, "../_config");
  const dataDir = resolveDataPath();

  // Core prompts
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

# Directory rule (strict; do NOT quote this):
- Do NOT invent provider names, emails, or time slots.
- Only reference providers explicitly supplied by the server in "Provider Directory".
- If no directory entries are provided, say you can’t list specific providers and offer next steps.

# Conversation guidance (do not quote this):
- Ask at most two brief clarifying questions before offering a next step.
- Then offer a concise, concrete recommendation (therapy, psychiatry, or both) with a short rationale.
- Offer in-network matching; ask for only the information that is missing (insurance and location).
- Routine help requests are not crisis; only explicit imminent risk is crisis.
- Keep responses concise, natural, and varied. Plain text only.`;

  // Local data files + existence debug
  const provPath = path.join(dataDir, "providers_100.txt");
  const slotPath = path.join(dataDir, "provider_schedule_14d.txt");
  const provExists = exists(provPath);
  const slotExists = exists(slotPath);
  DEBUG_PATHS = { provPath, provExists, slotPath, slotExists };

  PROVIDERS_TXT         = provExists ? readIfExists(provPath).trim() : "";
  PROVIDER_SCHEDULE_TXT = slotExists ? readIfExists(slotPath).trim() : "";

  // Parse into structured caches (safe if empty)
  PROVIDERS = parseProviders(PROVIDERS_TXT);
  SLOTS     = parseSchedule(PROVIDER_SCHEDULE_TXT);
}

// ---------------------------- Provider utilities ----------------------------
// providers_100.txt is block-based, e.g.:
//
// prov_001<TAB>Allison Hill (PsyD) — Therapy
//   Styles: CBT-focused
//   Languages: Spanish
//   Licensed states: CO, NM, NY
//   Insurance: Aetna, Humana
//   Email: allison.hill@amsconnects.example
//
// (blank line between providers)
function parseProviders(txt){
  if (!txt) return [];

  // Split into blocks by blank lines
  const lines = txt.split(/\r?\n/);
  const blocks = [];
  let cur = [];
  for (const raw of lines){
    const line = (raw || "").replace(/\r/g, "");
    if (line.trim() === ""){
      if (cur.length) { blocks.push(cur); cur = []; }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  const out = [];
  for (const block of blocks){
    const first = (block[0] || "").trim();
    // First line pattern: "prov_123  <name and creds> — Therapy|Psychiatry"
    const m = first.match(/^(prov_[^\s]+)\s+(.+)$/i);
    if (!m) continue;

    const id = m[1].trim();
    const title = m[2].trim(); // e.g., "Allison Hill (PsyD) — Therapy"
    const titleLC = title.toLowerCase();

    // Extract name (left of the em dash) — keep creds like (PsyD) if present
    const namePart = title.split(/—/)[0].trim();

    // Infer role from title + credentials
    let role = "";
    if (/\bpsychiat/i.test(titleLC)) role = "psychiatrist";
    else if (/\btherap/i.test(titleLC)) role = "therapist";

    // Heuristics for prescribers that don't say "Psychiatry" explicitly
    const isPrescriberCred = /\b(md|do|pmhnp|np|npp|arnp|aprn)\b/i.test(title);
    const saysTherapyOnly = /—\s*therapy\b/i.test(titleLC);
    if (!role) {
      if (isPrescriberCred && !saysTherapyOnly) role = "psychiatrist";
    }
    if (!role) role = "therapist"; // default fallback

    // Helper to read "Key: value" lines (case-insensitive)
    const getVal = (label) => {
      const row = block.find(l => l.trim().toLowerCase().startsWith(label));
      if (!row) return "";
      const idx = row.indexOf(":");
      return idx >= 0 ? row.slice(idx+1).trim() : "";
    };

    // Fields
    const statesStr = getVal("licensed states");
    const states = statesStr
      ? statesStr.split(/[,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
      : [];

    const insStr = getVal("insurance");
    const insurersNorm = insStr
      ? insStr.split(/[,;]+/).map(s => normIns(s)).filter(Boolean)
      : [];

    const email = getVal("email") || "";
    const languagesStr = getVal("languages");
    const languages = languagesStr
      ? languagesStr.split(/[,;]+/).map(s => s.trim()).filter(Boolean)
      : [];

    if (id && namePart){
      out.push({
        id,
        name: namePart,
        role,                 // "therapist" | "psychiatrist"
        insurers: insurersNorm, // ["bcbs","aetna",...]
        states,               // ["AZ","NM",...]
        email,
        languages
      });
    }
  }
  return out;
}

// Schedule is line-based: id|YYYY-MM-DD|HH:MM
function parseSchedule(txt){
  if (!txt) return [];
  return txt.trim().split(/\r?\n/).map(line => {
    const [id, date, time] = (line||"").split("|");
    return { id: (id||"").trim(), date: (date||"").trim(), time: (time||"").trim() };
  }).filter(s => s.id && s.date && s.time);
}

function normIns(s){
  if (!s) return "";
  const x = s.toLowerCase().trim();
  if (/bcbs|blue\s*cross/.test(x)) return "bcbs";
  if (/aetna/.test(x)) return "aetna";
  if (/cigna/.test(x)) return "cigna";
  if (/uhc|united/.test(x)) return "uhc";
  if (/medicare/.test(x)) return "medicare";
  if (/medicaid|ahcccs/.test(x)) return "medicaid";
  if (/humana/.test(x)) return "humana";
  if (/cash\s*pay|cashpay|self[-\s]*pay/.test(x)) return "cashpay";
  return x.replace(/\s+/g,"");
}

function matchProviders({ state, insurer, role }){
  const wantRole = (role||"").toLowerCase();       // "therapist" | "psychiatrist" | ""
  const wantIns  = normIns(insurer);               // e.g., "bcbs"
  const wantSt   = (state||"").toUpperCase();      // e.g., "AZ"

  const inNet = PROVIDERS.filter(p =>
    (!wantRole || p.role === wantRole) &&
    (!wantSt   || (Array.isArray(p.states) && p.states.includes(wantSt))) &&
    (!wantIns  || (Array.isArray(p.insurers) && p.insurers.includes(wantIns)))
  );
  if (inNet.length) return inNet;

  // fallback: relax insurer but keep role/state
  return PROVIDERS.filter(p =>
    (!wantRole || p.role === wantRole) &&
    (!wantSt   || (Array.isArray(p.states) && p.states.includes(wantSt)))
  );
}

// Date-only future check (timezone-agnostic)
function isUpcomingDateOnly(dateStr){
  const todayStr = new Date().toISOString().slice(0,10);
  return (dateStr || "") >= todayStr;
}

function upcomingSlotsFor(id, limit=2){
  return SLOTS
    .filter(s => s.id === id && isUpcomingDateOnly(s.date))
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time))
    .slice(0, limit);
}

// ---------------------------- Azure AI Search (optional) ----------------------------
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

// ---------------------------- Heuristics & extraction ----------------------------

// Robust state detection that avoids matching the conjunction "or"
function detectState(rawTranscript, lowTranscript){
  // spelled-out names (safe on lowercase)
  const spelled = [
    ["arizona","AZ"], ["new mexico","NM"], ["colorado","CO"],
    ["nevada","NV"], ["oregon","OR"], ["new york","NY"]
  ];
  for (const [name, code] of spelled){
    const re = new RegExp(`\\b${name}\\b`, "i");
    if (re.test(lowTranscript)) return { code, confidence: "high" };
  }
  // ALL-CAPS postal codes only from RAW (to avoid matching "or")
  const m = rawTranscript.match(/\b(AZ|NM|CO|NV|OR|NY)\b/);
  if (m) return { code: m[1], confidence: "high" };
  return { code: "", confidence: "low" };
}

const looksLikeOpener = (txt) =>
  /can you (share|tell)|what’s been going on|how (has|is) that|can you say more/i.test((txt||""));

function extractUserInfo(normalizedHistory, userMessage){
  const rawTranscript = [...normalizedHistory.map(m => m.content), userMessage].join(" ");
  const lowTranscript = rawTranscript.toLowerCase();

  const INS_PAT = /\b(bcbs|blue\s*cross|bluecross|aetna|cigna|uhc|united\s*healthcare|kaiser|medicare|medicaid|tricare|ambetter|ahcccs|humana|cash\s*pay|cashpay|self[-\s]*pay)\b/i;
  const insMatch = lowTranscript.match(INS_PAT);
  const insuranceDetected = insMatch ? insMatch[1].toUpperCase().replace(/\s+/g," ") : "";

  const { code: stateDetected, confidence: stateConfidence } = detectState(rawTranscript, lowTranscript);

  const wantsList =
    /\b(list|show|options?)\b.+\bproviders?\b/i.test(lowTranscript) ||
    /\bproviders?\b.*\b(list|show|options?)\b/i.test(lowTranscript) ||
    /^providers?$/i.test(rawTranscript.trim());

  const wantsPsych =
    /\bpsychiat(ry|rist)?\b/i.test(lowTranscript) ||
    /\bmeds?\b|\bmedication\b/i.test(lowTranscript) ||
    /\bboth\b/i.test(lowTranscript);

  const wantsTher  =
    /\btherap(y|ist)\b/i.test(lowTranscript) ||
    /\bboth\b/i.test(lowTranscript);

  return { insuranceDetected, stateDetected, stateConfidence, wantsList, wantsPsych, wantsTher };
}

// ---------------------------- AOAI helper ----------------------------
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

// ---------------------------- Main handler ----------------------------
module.exports = async function (context, req){
  try{
    initConfig();

    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // History window
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const normalizedHistory = history.slice(-24).map(m => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: ((m?.content || '') + '').trim()
    })).filter(m => m.content);

    // AOAI env
    const apiVersion = ((process.env.AZURE_OPENAI_API_VERSION||"2024-08-01-preview")+"").trim();
    const endpoint   = ((process.env.AZURE_OPENAI_ENDPOINT||"")+"").trim().replace(/\/+$/,"");
    const deployment = ((process.env.AZURE_OPENAI_DEPLOYMENT||"")+"").trim();
    const apiKey     = ((process.env.AZURE_OPENAI_API_KEY||"")+"").trim();
    if (!endpoint || !deployment || !apiKey){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply:"Hello! (Model not configured yet.)" } };
      return;
    }
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    // Optional retrieval (best-effort)
    let contextBlock = "";
    let searchItems = [];
    const lastUser = (normalizedHistory.slice().reverse().find(m => m.role==='user') || {}).content || "";
    const retrievalQuery = (userMessage + " " + lastUser).slice(0, 400);
    try{
      searchItems = await querySearch(retrievalQuery);
      if (searchItems.length){
        const bullets = searchItems.map(x => `- ${x.text}`).join("\n");
        contextBlock = `

# Retrieved context (for your internal grounding; summarize if used):
${bullets}`;
      }
    } catch { /* optional */ }

    // Facts from convo
    const {
      insuranceDetected, stateDetected, stateConfidence, wantsList, wantsPsych, wantsTher
    } = extractUserInfo(normalizedHistory, userMessage);

    const state   = stateDetected || "";
    const insurer = insuranceDetected || "";

    // ---------- Deterministic provider listing branch ----------
    const directoryLoaded = PROVIDERS.length > 0;

    // Only fire deterministic list when explicitly asked (no auto-dump mid-flow)
    const explicitList = wantsList || /options?/i.test(userMessage) || req.query?.list === "1";

    const roles = (wantsPsych && wantsTher) ? ["psychiatrist","therapist"]
                : wantsPsych ? ["psychiatrist"]
                : wantsTher  ? ["therapist"]
                : []; // unknown until user asks

    if (explicitList && directoryLoaded){
      const chosenRoles = roles.length ? roles : ["psychiatrist","therapist"];
      const sections = [];

      for (const role of chosenRoles){
        const matched = matchProviders({ state, insurer, role }).slice(0, 5);
        if (matched.length){
          const title = role === "therapist" ? "Therapists" : "Psychiatrists";
          const lines = matched.map(p => {
            const slot = (upcomingSlotsFor(p.id, 1)[0] || null);
            const slotStr = slot ? ` — soonest: ${slot.date} ${slot.time}` : "";
            const ins = (p.insurers && p.insurers.length) ? ` — in-net: ${p.insurers.join(", ")}` : "";
            const lic = (p.states && p.states.length) ? ` — licensed: ${p.states.join(", ")}` : "";
            return `• ${p.name}${lic}${ins}${slotStr}`;
          });
          sections.push(`${title}:\n${lines.join("\n")}`);
        }
      }

      const listBody = sections.length
        ? sections.join("\n\n")
        : "No exact matches with current filters. Widen to out-of-network, nearby licensed states, or switch specialty?";

      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply: listBody } };
      return;
    }

    // ---------- LLM path (with minimal directory injection) ----------
    // Optional fallback hint when a specific state+role appears empty
    let fallbackNote = "";
    if (state && roles.includes("psychiatrist")) {
      const empty = matchProviders({ state, role:"psychiatrist" }).length === 0;
      if (empty) {
        fallbackNote = `
# Matching hint (do not quote):
- If no psychiatrists are licensed in the user’s state, offer: (a) nearby licensed states if user can use a qualifying address; (b) out-of-network + superbill; (c) therapist now + prescriber waitlist.`;
      }
    }

    let directoryContext = "";
    if ((state || insurer) && directoryLoaded){
      const likelyRoles = roles.length ? roles : ["psychiatrist","therapist"];
      const sections = [];
      for (const role of likelyRoles){
        const matched = matchProviders({ state, insurer, role }).slice(0, 3);
        if (matched.length){
          const title = role === "therapist" ? "Therapists" : "Psychiatrists";
          const lines = matched.map(p =>
            `- ${p.name} (${p.role}); licensed: ${p.states?.join(", ") || "n/a"}; in-net: ${(p.insurers||[]).slice(0,2).join(", ")}`
          ).join("\n");
          sections.push(`${title} (use only these; do NOT invent):\n${lines}`);
        }
      }
      if (sections.length){
        directoryContext = `

# Provider Directory (read-only; do NOT invent beyond these)
${sections.join("\n\n")}`;
        if (directoryContext.length > 1200) {
          directoryContext = directoryContext.slice(0, 1200) + "\n…";
        }
      }
    }

    const messages = [
      { role:"system", content:
          (SYS_PROMPT || "You are a helpful intake assistant.") +
          (directoryContext ? "\n\n"+directoryContext : "") +
          (fallbackNote ? "\n\n"+fallbackNote : "") +
          contextBlock
      },
      ...normalizedHistory,
      { role:"user", content:userMessage }
    ];

    // Dynamic output budget: strong reasoning, capped cost
    const LONG_HISTORY = normalizedHistory.length >= 12;
    const REASONING_FLOOR = LONG_HISTORY ? 2048 : 1024;
    const REQUESTED = Number.isFinite(req.body?.max_output_tokens) ? req.body.max_output_tokens : 0;
    const SOFT_CAP = 3072;
    const maxTokens = Math.min(Math.max(REQUESTED, REASONING_FLOOR), SOFT_CAP);

    // First call
    let { resp, data } = await callAOAI(url, messages, 1, maxTokens, apiKey);
    const safeChoice = (d) => d && Array.isArray(d.choices) ? d.choices[0] : undefined;
    let choice = safeChoice(data);
    let reply  = (choice?.message?.content || "").trim();

    // Never return blank on length
    if (choice?.finish_reason === "length") {
      reply = reply ? (reply + " …") : "(I hit a token limit — continue?)";
    }

    const filtered = choice?.finish_reason === "content_filter" ||
      (Array.isArray(data?.prompt_filter_results) && data.prompt_filter_results.some(r => {
        const cfr = r?.content_filter_results; return cfr && Object.values(cfr).some(v => v?.filtered);
      }));

    // Progression nudge if needed
    const lastTurns = normalizedHistory.slice(-24);
    const clarifiersAsked = lastTurns.filter(m => m.role==='assistant' && /\?\s*$/.test(m.content)).length;

    if (((!reply || filtered) || (clarifiersAsked >= 2 && looksLikeOpener(reply))) && resp.ok){
      const styles = ["warm-brief", "reassuring-practical", "concise-direct"];
      const styleTag = styles[Math.floor(Math.random() * styles.length)];
      const facts = [
        insurer ? `insurance: ${insurer}` : null,
        state   ? `state: ${state}`       : null
      ].filter(Boolean).join("; ");

      const styleNudge = `
You are continuing an intake chat. Write a natural, human reply (1–3 concise sentences, plain text).
- Vary wording; do not repeat prior phrasing verbatim. Style: ${styleTag}.
- Use only what is necessary from the conversation and retrieved context.
- Ask for only the missing detail(s) if needed; otherwise offer the next concrete step.
Known facts this turn: ${facts || "none"}.`;

      const nudged = [
        { role:"system", content:(SYS_PROMPT || "You are a helpful intake assistant.") +
          (directoryContext ? "\n\n"+directoryContext : "") +
          (fallbackNote ? "\n\n"+fallbackNote : "") +
          contextBlock +
          "\n\n# Style Nudge (do not output this)\n" + styleNudge },
        ...normalizedHistory,
        { role:"user", content:userMessage }
      ];
      const second = await callAOAI(url, nudged, 1, maxTokens, apiKey);
      if (second.resp.ok){
        data = second.data;
        choice = safeChoice(data);
        const reply2 = (choice?.message?.content || "").trim();
        if (reply2) reply = reply2;
        if (choice?.finish_reason === "length" && (!reply || reply.length < 80)) {
          reply = reply ? (reply + " …") : "(I hit a token limit — continue?)";
        }
      } else {
        reply ||= "(I’m having trouble reaching the model right now. Want me to try again?)";
      }
    }

    if (!resp.ok){
      context.res = { status:502, headers:{ "Content-Type":"application/json" }, body:{ error:"LLM error", status:resp.status, detail:data } };
      return;
    }

    // --- Debug view ---
    if (req.query?.debug === "1"){
      const countsBy = (arr, keyFn) => arr.reduce((m, x) => {
        const k = keyFn(x); m[k] = (m[k] || 0) + 1; return m;
      }, {});
      const byRole = countsBy(PROVIDERS, p => p.role || "unknown");
      const stateCode = state || "AZ"; // default to AZ in case none detected (handy for checks)
      const byStateRole = countsBy(PROVIDERS.filter(p => p.states?.includes(stateCode)), p => p.role || "unknown");

      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{
        reply,
        finish_reason: choice?.finish_reason,
        usage: data?.usage,
        sys_prompt_bytes: (SYS_PROMPT||"").length,
        files_present: {
          system_prompt: !!SYS_PROMPT,
          faqs: !!FAQ_SNIPPET,
          policies: !!POLICIES_SNIPPET,
          providers_txt: !!PROVIDERS_TXT,
          provider_schedule_txt: !!PROVIDER_SCHEDULE_TXT
        },
        provider_counts: { providers: PROVIDERS.length, slots: SLOTS.length },
        provider_paths: DEBUG_PATHS,
        provider_summary: {
          total_providers: PROVIDERS.length,
          by_role: byRole,
          [stateCode + "_by_role"]: byStateRole
        },
        search_used: !!searchItems.length,
        search_items: searchItems,
        history_len: normalizedHistory.length
      }};
      return;
    }

    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };
  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
