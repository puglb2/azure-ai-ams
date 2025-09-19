// api/chat/index.js
const fs = require("fs");
const path = require("path");

// ---------- config: how many slots to SHOW by default ----------
const SHOW_SLOTS_DEFAULT = 3;     // shortlist snippets
const SHOW_SLOTS_PROVIDER = 6;    // when a specific provider is mentioned or "later/3pm" asked

// ---------- load & cache instruction + data files ----------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";

let PROVIDERS = [];      // [{id,name,role,states[],insurers[],raw, is_prescriber}]
let SLOTS = [];          // [{id,date,time}]
let NAME_INDEX = null;   // token -> Set<prov_id>

function readIfExists(p){ try{ return fs.readFileSync(p,"utf8"); } catch{ return ""; } }

function initConfig(){
  if (SYS_PROMPT) return; // only on cold start

  const cfgDir  = path.join(__dirname, "../_config");
  const dataDir = path.join(__dirname, "../_data");

  // Core instruction files
  SYS_PROMPT       = readIfExists(path.join(cfgDir, "system_prompt.txt")).trim();
  FAQ_SNIPPET      = readIfExists(path.join(cfgDir, "faqs.txt")).trim();
  POLICIES_SNIPPET = readIfExists(path.join(cfgDir, "policies.txt")).trim();

  // Provider directory files (raw)
  PROVIDERS_TXT         = readIfExists(path.join(dataDir, "providers_100.txt")).trim();
  PROVIDER_SCHEDULE_TXT = readIfExists(path.join(dataDir, "provider_schedule_14d.txt")).trim();

  // Merge FAQ and Policy snippets into system prompt
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

  // Parse providers + schedule into structured caches
  PROVIDERS = parseProvidersFreeform(PROVIDERS_TXT);
  SLOTS     = parseSlots(PROVIDER_SCHEDULE_TXT);
  NAME_INDEX = buildProviderNameIndex(PROVIDERS);
}

// ---------- provider parsing + matching (FREEFORM FORMAT) ----------
function inferRoleFromHeader(headerLine){
  // headerLine example: "Allison Hill (PsyD) — Therapy"
  const roleTag = (headerLine.split("—")[1] || "").trim().toLowerCase(); // therapy|psychiatry|both
  const hasPrescriberCred = /\b(md|do|pmhnp)\b/i.test(headerLine);
  if (/psychiatry/.test(roleTag) && hasPrescriberCred) return { role: "psychiatrist", is_prescriber: true };
  if (/psychiatry/.test(roleTag) && !hasPrescriberCred) return { role: "therapist", is_prescriber: false }; // safeguard
  if (/both/.test(roleTag) && hasPrescriberCred) return { role: "psychiatrist", is_prescriber: true };
  if (/both/.test(roleTag)) return { role: "therapist", is_prescriber: false };
  return { role: "therapist", is_prescriber: false };
}

function normalizeIns(ins){
  if (!ins) return "";
  const s = ins.toLowerCase().replace(/\s+/g,"");
  if (/(bcbs|bluecross|bluecrossblueshield)/.test(s)) return "bcbs";
  if (/unitedhealthcare|uhc/.test(s)) return "uhc";
  if (/cashpay|cash/.test(s)) return "cashpay";
  return s;
}

function parseProvidersFreeform(txt){
  if (!txt) return [];
  const blocks = txt.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const out = [];
  for (const b of blocks){
    const lines = b.split(/\r?\n/);
    const first = lines[0] || "";
    const m = first.match(/^(prov_\d+)\s+(.+)$/i);
    if (!m) continue;
    const id = m[1];
    const header = (m[2] || "").trim(); // "<Name> — <Tag>"
    const name = (header.split("—")[0] || "").trim();

    const { role, is_prescriber } = inferRoleFromHeader(header);

    const statesLine   = (b.match(/Licensed states:\s*([^\n]+)/i)?.[1] || "").trim();
    const insurersLine = (b.match(/Insurance:\s*([^\n]+)/i)?.[1] || "").trim();

    const states = statesLine.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
    const insurers = insurersLine.split(",").map(s=>normalizeIns(s)).filter(Boolean);

    out.push({ id, name, role, is_prescriber, states, insurers, raw: b });
  }
  return out;
}

function parseSlots(txt){
  if (!txt) return [];
  return txt.trim().split(/\r?\n/).map(line => {
    const [id, date, time] = (line||"").split("|");
    return { id, date, time };
  }).filter(s => s.id && s.date && s.time);
}

// ---------- slot helpers (SHOW few, READ all) ----------
function soonestSlotsFor(id, limit=SHOW_SLOTS_DEFAULT){
  return SLOTS
    .filter(s => s.id === id)
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time))
    .slice(0, limit);
}

function upcomingSlotsFor(id, fromDate=""){
  const fromKey = (fromDate || "0000-00-00") + "00:00";
  return SLOTS
    .filter(s => s.id === id)
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time))
    .filter(s => (s.date+s.time) >= fromKey);
}

// exact time across days (e.g., “3pm”)
function findSlotsAtTime(id, hhmm="15:00", fromDate=""){
  const fromKey = (fromDate || "0000-00-00") + hhmm;
  return SLOTS
    .filter(s => s.id === id && s.time === hhmm)
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time))
    .filter(s => (s.date+s.time) >= fromKey);
}

// closest future alternatives if exact time not available
function nearestNextSlots(id, afterDateTimeKey, limit=SHOW_SLOTS_PROVIDER){
  return SLOTS
    .filter(s => s.id === id && (s.date+s.time) > afterDateTimeKey)
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time))
    .slice(0, limit);
}

// ---------- matching ----------
function matchProviders({ state, insurer, role }){
  const wantRole = (role||"").toLowerCase();   // "therapist" | "psychiatrist" | ""
  const wantIns  = (insurer||"").toLowerCase();
  const wantSt   = (state||"").toUpperCase();

  let list = PROVIDERS.filter(p =>
    (!wantRole || (p.role === wantRole || (wantRole==="psychiatrist" && p.is_prescriber))) &&
    (!wantSt   || p.states.includes(wantSt)) &&
    (!wantIns  || (p.insurers||[]).includes(wantIns))
  );

  // If none, relax insurer but keep role/state
  if (!list.length && (wantRole || wantSt)) {
    list = PROVIDERS.filter(p =>
      (!wantRole || (p.role === wantRole || (wantRole==="psychiatrist" && p.is_prescriber))) &&
      (!wantSt   || p.states.includes(wantSt))
    );
  }
  return list;
}

// ---------- provider name index & detection ----------
function buildProviderNameIndex(list){
  const idx = new Map();
  for (const p of list){
    const parts = (p.name || "").toLowerCase().split(/\s+/).filter(Boolean);
    const uniq = new Set(parts);
    for (const t of uniq){
      if (!idx.has(t)) idx.set(t, new Set());
      idx.get(t).add(p.id);
    }
    const last = parts[parts.length - 1];
    if (last) {
      if (!idx.has(last)) idx.set(last, new Set());
      idx.get(last).add(p.id);
    }
  }
  return idx;
}

function detectProviderMention(userText, nameIndex){
  const toks = (userText||"").toLowerCase().match(/[a-z]+/g) || [];
  const tallies = new Map();
  for (const t of toks){
    const set = nameIndex.get(t);
    if (!set) continue;
    for (const id of set){
      tallies.set(id, (tallies.get(id)||0) + 1);
    }
  }
  let best = "", score = 0;
  for (const [id, s] of tallies.entries()){
    if (s > score){ best = id; score = s; }
  }
  return best; // "" if none
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

// ---------- state detection + intent gating ----------
const US_STATES = {
  AL:"AL","Alabama":"AL", AK:"AK","Alaska":"AK", AZ:"AZ","Arizona":"AZ", AR:"AR","Arkansas":"AR",
  CA:"CA","California":"CA", CO:"CO","Colorado":"CO", CT:"CT","Connecticut":"CT",
  DE:"DE","Delaware":"DE", FL:"FL","Florida":"FL", GA:"GA","Georgia":"GA",
  HI:"HI","Hawaii":"HI", ID:"ID","Idaho":"ID", IL:"IL","Illinois":"IL",
  IN:"IN","Indiana":"IN", IA:"IA","Iowa":"IA", KS:"KS","Kansas":"KS",
  KY:"KY","Kentucky":"KY", LA:"LA","Louisiana":"LA", ME:"ME","Maine":"ME",
  MD:"MD","Maryland":"MD", MA:"MA","Massachusetts":"MA", MI:"MI","Michigan":"MI",
  MN:"MN","Minnesota":"MN", MS:"MS","Mississippi":"MS", MO:"MO","Missouri":"MO",
  MT:"MT","Montana":"MT", NE:"NE","Nebraska":"NE", NV:"NV","Nevada":"NV",
  NH:"NH","New Hampshire":"NH", NJ:"NJ","New Jersey":"NJ", NM:"NM","New Mexico":"NM",
  NY:"NY","New York":"NY", NC:"NC","North Carolina":"NC", ND:"ND","North Dakota":"ND",
  OH:"OH","Ohio":"OH", OK:"OK","Oklahoma":"OK", OR:"OR","Oregon":"OR",
  PA:"PA","Pennsylvania":"PA", RI:"RI","Rhode Island":"RI",
  SC:"SC","South Carolina":"SC", SD:"SD","South Dakota":"SD",
  TN:"TN","Tennessee":"TN", TX:"TX","Texas":"TX", UT:"UT","Utah":"UT",
  VT:"VT","Vermont":"VT", VA:"VA","Virginia":"VA",
  WA:"WA","Washington":"WA", WV:"WV","West Virginia":"WV",
  WI:"WI","Wisconsin":"WI", WY:"WY","Wyoming":"WY",
  DC:"DC","District of Columbia":"DC"
};

function normalizeStateToken(tok=""){
  if (US_STATES.hasOwnProperty(tok)) return US_STATES[tok];
  const hit = Object.keys(US_STATES).find(k => k.toLowerCase() === tok.toLowerCase());
  return hit ? US_STATES[hit] : "";
}

function detectStatesIn(text=""){
  const multi = [
    "new hampshire","new jersey","new mexico","new york",
    "north carolina","north dakota","rhode island","south carolina","south dakota",
    "west virginia","district of columbia"
  ];
  const found = new Set();
  const toks = (text.match(/[A-Za-z]{2,}/g) || []);
  for (const t of toks){
    const code = normalizeStateToken(t);
    if (code) found.add(code);
  }
  const l = text.toLowerCase();
  for (const phrase of multi){
    if (l.includes(phrase)) {
      const title = phrase.replace(/\b\w/g, m=>m.toUpperCase());
      found.add(normalizeStateToken(title));
    }
  }
  return [...found];
}

function extractUserInfo(normalizedHistory, userMessage){
  const historyText = normalizedHistory.map(m => m.content).join(" ");
  const transcriptWindow = (historyText + " " + userMessage).toLowerCase();

  // insurer (common variants)
  const INS_PAT = /\b(bcbs|blue\s*cross|bluecross|aetna|cigna|uhc|united\s*healthcare|kaiser|medicare|medicaid|ahcccs|tricare|humana|cash\s*pay|cashpay)\b/i;
  const insMatch = transcriptWindow.match(INS_PAT);
  const insuranceDetected = insMatch ? insMatch[1].toUpperCase().replace(/\s+/g," ") : "";

  // states: latest mention wins; allow negation like "don't want AZ"
  const historyStates = detectStatesIn(historyText);
  const userStates    = detectStatesIn(userMessage);
  const negAZ = /\b(don'?t|do not|no)\s+(want|use|choose).*\baz\b/i.test(userMessage);

  let stateDetected = "";
  if (userStates.length) stateDetected = userStates[userStates.length - 1];
  else if (historyStates.length) stateDetected = historyStates[historyStates.length - 1];
  if (negAZ && stateDetected === "AZ") stateDetected = "";

  // Intent: wants a list / options / suggestions now
  const wantsList = /\b(list|show|options?|suggest(ions?)?)\b.*\bproviders?\b/i.test(userMessage) ||
                    /\bwho (do|does) you have\b/i.test(userMessage);

  return { insuranceDetected, stateDetected, wantsList };
}

// detect “opener-ish” responses so we can nudge progress
const looksLikeOpener = (txt) =>
  /can you (share|tell)|what’s been going on|how (has|is) that|can you say more/i.test((txt||""));

// ---------- provider/time intent helpers ----------
function parseTimeRequest(text){
  // matches: 3pm, 3 pm, 3:00 pm, 15:00
  const m = (text||"").toLowerCase().match(/\b(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? m[2] : "00";
  const ampm = m[3];
  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  if (hh >= 0 && hh <= 23){
    const HH = String(hh).padStart(2,"0");
    return `${HH}:${mm}`;
  }
  return null;
}

function mentionsLater(text){
  return /\b(later|another day|next week|after|evening)\b/i.test(text||"");
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

// ---------- main handler ----------
module.exports = async function (context, req){
  try{
    initConfig();

    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // history from client (keep last N turns)
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

    // ---- Retrieval via Azure AI Search (optional grounding) ----
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

    // ---- Provider directory gating ----
    const { insuranceDetected, stateDetected, wantsList } =
      extractUserInfo(normalizedHistory, userMessage);

    const insurer = (insuranceDetected || "").toLowerCase();
    const state   = stateDetected || "";

    const haveEnoughToMatch  = !!state;       // require state to narrow safely
    const userExplicitlyAsked = !!wantsList;  // “list/options/suggest providers”
    const shouldShowDirectory = userExplicitlyAsked || haveEnoughToMatch;

    // ---- (NEW) provider/time targeting based on current user turn ----
    const mentionedId = detectProviderMention(userMessage, NAME_INDEX);
    const hhmmReq     = parseTimeRequest(userMessage);
    const wantsLater  = mentionsLater(userMessage);

    // ---- Build provider directory context ONLY if allowed (shortlists) ----
    let directoryContext = "";
    if (shouldShowDirectory && PROVIDERS.length){
      const roles = ["psychiatrist","therapist"];
      const sections = [];
      for (const role of roles){
        const matched = matchProviders({ state, insurer, role }).slice(0, 6);
        if (matched.length){
          const lines = matched.map(p => {
            const slotStr = soonestSlotsFor(p.id, SHOW_SLOTS_DEFAULT)
              .map(s => `${s.date} ${s.time}`).join(", ");
            const ins   = (p.insurers||[]).join(", ") || "cashpay";
            const stStr = p.states?.join(", ") || "";
            return `- ${p.name} (${role}) — licensed: ${stStr} — in-net: ${ins}${slotStr?` — soonest: ${slotStr}`:""}`;
          }).join("\n");
          const title = role === "therapist" ? "Therapists" : "Psychiatrists";
          sections.push(`${title} (state=${state || "unspecified"}${insurer?`, insurer=${insurer}`:""}):\n${lines}`);
        }
      }
      if (sections.length){
        directoryContext = `

# Provider Directory (use only entries listed here; do not invent)
${sections.join("\n\n")}`;
      }
    }

    // ---- (NEW) Provider-specific compact availability when named or time asked ----
    let providerAvailabilityContext = "";
    if (mentionedId){
      const prov = PROVIDERS.find(p => p.id === mentionedId);
      if (prov){
        let lines = [];
        if (hhmmReq){
          const exact = findSlotsAtTime(mentionedId, hhmmReq);
          if (exact.length){
            lines = exact.slice(0, SHOW_SLOTS_PROVIDER).map(s => `- ${s.date} ${s.time}`);
          } else {
            // no exact match at that time → nearest future options
            const afterKey = "0000-00-00" + hhmmReq;
            const near = nearestNextSlots(mentionedId, afterKey, SHOW_SLOTS_PROVIDER);
            lines = near.map(s => `- ${s.date} ${s.time}`);
          }
        } else if (wantsLater){
          lines = upcomingSlotsFor(mentionedId).slice(0, SHOW_SLOTS_PROVIDER)
            .map(s => `- ${s.date} ${s.time}`);
        } else {
          // user picked provider but no time constraints → show a little more than shortlist
          lines = soonestSlotsFor(mentionedId, SHOW_SLOTS_PROVIDER)
            .map(s => `- ${s.date} ${s.time}`);
        }

        if (lines.length){
          providerAvailabilityContext = `
# Availability (exact; do not invent)
Provider: ${prov.name} (${prov.role})
Slots (next 14 days):
${lines.join("\n")}`.trim();
        }
      }
    }

    // ---- Build messages
    const messages = [
      { role:"system", content:
          (SYS_PROMPT || "You are a helpful intake assistant.") +
          (directoryContext ? "\n\n" + directoryContext : "") +
          (providerAvailabilityContext ? "\n\n" + providerAvailabilityContext : "") +
          contextBlock
      },
      ...normalizedHistory,
      { role:"user", content:userMessage }
    ];

    // ---- Output token budget (keep reasoning strong)
    const requestedMax = Number.isFinite(req.body?.max_output_tokens) ? req.body.max_output_tokens : 0;
    const maxTokens = Math.max(requestedMax || 0, 2048);

    // ---- First call
    let { resp, data } = await callAOAI(url, messages, 1, maxTokens, apiKey);
    const choice = data?.choices?.[0];
    let reply  = (choice?.message?.content || "").trim();

    // Never show a blank if we hit the cap
    if (choice?.finish_reason === "length") {
      reply = reply ? (reply + " …") : "(I hit a token limit — continue?)";
    }

    const filtered = choice?.finish_reason === "content_filter" ||
      (Array.isArray(data?.prompt_filter_results) && data.prompt_filter_results.some(r => {
        const cfr = r?.content_filter_results; return cfr && Object.values(cfr).some(v => v?.filtered);
      }));

    // progression checks
    const lastTurns = normalizedHistory.slice(-24);
    const clarifiersAsked = lastTurns.filter(m => m.role==='assistant' && /\?\s*$/.test(m.content)).length;

    // --- If empty/filtered OR still an opener after 2 clarifiers: one more model-led nudge
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
          (directoryContext ? "\n\n" + directoryContext : "") +
          (providerAvailabilityContext ? "\n\n" + providerAvailabilityContext : "") +
          contextBlock +
          "\n\n# Style Nudge (do not output this)\n" + styleNudge },
        ...normalizedHistory,
        { role:"user", content:userMessage }
      ];
      const second = await callAOAI(url, nudged, 1, maxTokens, apiKey);
      if (second.resp.ok){
        const c2 = second.data?.choices?.[0];
        const reply2 = (c2?.message?.content || "").trim();
        if (reply2) reply = reply2;
        if (c2?.finish_reason === "length" && (!reply || reply.length < 80)) {
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

    // optional debug
    if (req.query?.debug === "1"){
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
        provider_paths: {
          provPath: path.join(__dirname, "../_data/providers_100.txt"),
          provExists: !!PROVIDERS_TXT,
          slotPath: path.join(__dirname, "../_data/provider_schedule_14d.txt"),
          slotExists: !!PROVIDER_SCHEDULE_TXT
        },
        selected_state: state,
        selected_insurer: insurer,
        mentioned_provider_id: mentionedId,
        time_requested: hhmmReq,
        wants_later: wantsLater,
        search_used: !!searchItems.length,
        search_items: searchItems,
        history_len: normalizedHistory.length
      }};
      return;
    }

    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };
  } catch(e){
    // Keep it JSON (avoid HTML/hex 500)
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
