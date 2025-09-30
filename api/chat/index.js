// api/chat/index.js
const fs = require("fs");
const path = require("path");

// -------------------------------
// Tunables
// -------------------------------
const MAX_HISTORY_TURNS = 24;
const DEFAULT_TEMP = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 2048; // floor; client can request more
const MAX_PROVIDERS_LINES_DEBUG_PREVIEW = 5; // only for ?debug=1 payload brevity

// Filtering / context sizing
const PROVIDER_CONTEXT_CHAR_BUDGET = 12000;      // ~12k chars for providers
const SCHEDULE_CONTEXT_CHAR_BUDGET = 6000;       // ~6k chars for schedule
const PROVIDER_HARD_CAP = 300;                   // absolute max lines emitted
const SCHEDULE_LINES_HARD_CAP = 600;             // absolute max schedule rows
const HINT_WEIGHT_BONUS = 4;                     // score bonus for matches
const SECONDARY_WEIGHT_BONUS = 2;                // softer match bonus

// -------------------------------
// Lazy-loaded globals
// -------------------------------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";
let PROVIDERS = []; // structured providers
let SLOTS = [];     // structured slots

// -------------------------------
// Utils
// -------------------------------
function readIfExists(p){ try{ return fs.readFileSync(p, "utf8"); } catch { return ""; } }
const norm = s => (s||"").toString().trim();

function initConfig(){
  if (SYS_PROMPT) return; // cold-start only

  const cfgDir  = path.join(__dirname, "../_config");
  const dataDir = path.join(__dirname, "../_data");

  // Instruction files
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

  // Raw data
  PROVIDERS_TXT         = readIfExists(path.join(dataDir, "providers_100.txt"));
  PROVIDER_SCHEDULE_TXT = readIfExists(path.join(dataDir, "provider_schedule_14d.txt"));

  // Parse
  PROVIDERS = parseProviders(PROVIDERS_TXT);
  SLOTS     = parseSchedule(PROVIDER_SCHEDULE_TXT);
}

// -------------------------------
// Robust Parsing (no keyword triggers)
// -------------------------------
function splitBlocksLoose(raw){
  // tolerate windows/mac/unix newlines and extra spaces/tabs
  // split on 1+ completely blank lines
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\uFEFF/g, "")         // BOM if any
    .split(/\n[ \t]*\n+/)
    .map(b => b.trim())
    .filter(Boolean);
}

function parseProviders(raw){
  if (!raw || !raw.trim()) return [];

  // Normalize newlines and invisibles
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\uFEFF/g, "")
    .replace(/\t/g, " ")
    .replace(/\u200B/g, "")
    .split("\n");

  const blocks = [];
  let cur = [];

  // Build blocks by header lines that start with prov_###
  for (const lineRaw of lines){
    const line = (lineRaw || "").trim();
    if (!line) { 
      // keep empty lines inside a block as soft separators
      cur.push("");
      continue;
    }
    if (/^prov_\d+\b/i.test(line)) {
      // start of a new provider
      if (cur.length) blocks.push(cur);
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  const out = [];

  for (const arr of blocks){
    if (!arr.length) continue;

    // Header (normalize all dash variants to "-")
    const header = arr[0].replace(/[–—−]/g, "-").trim();
    // Match "prov_001  Name (Creds) - Role" OR "prov_001  Name (Creds)"
    const m = header.match(/^(\S+)\s+(.+?)\s*-\s*(.+)$/) || header.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;

    const id = (m[1] || "").trim();
    const name = (m[2] || "").trim();
    const roleRaw = (m[3] || "").trim().toLowerCase();

    let role = "provider";
    if (roleRaw.includes("psychiat")) role = "psychiatrist";
    else if (roleRaw.includes("therap")) role = "therapist";
    else if (roleRaw.includes("both")) role = "both";

    let styles = "", lived = "", languages = "", licensedStates = "", insurersLine = "", email = "";

    for (let i = 1; i < arr.length; i++){
      const l = (arr[i] || "").trim();
      if (!l) continue;
      const lower = l.toLowerCase();

      // Extract after first ":" if present; otherwise try forgiving fallbacks
      const afterColon = l.includes(":") ? l.split(":").slice(1).join(":").trim() : "";

      if (lower.startsWith("styles:"))                          styles = afterColon || styles;
      else if (lower.startsWith("lived experience:"))           lived = afterColon || lived;
      else if (lower.startsWith("languages:") || lower.startsWith("language:")) languages = afterColon || languages;
      else if (lower.startsWith("licensed states:"))            licensedStates = afterColon || licensedStates;
      else if (lower.startsWith("insurance:"))                  insurersLine = afterColon || insurersLine;
      else if (lower.startsWith("email:"))                      email = afterColon || email;
      else {
        // Tolerate drift like "Insurance - ..." or spacing differences
        if (!insurersLine && /insurance/i.test(l)) {
          insurersLine = afterColon || l.replace(/.*insurance\s*[:\-]\s*/i, "").trim();
        }
        if (!licensedStates && /licensed\s*states/i.test(l)) {
          licensedStates = afterColon || l.replace(/.*licensed\s*states\s*[:\-]\s*/i, "").trim();
        }
        if (!languages && /languages?/i.test(l)) {
          languages = afterColon || l.replace(/.*languages?\s*[:\-]\s*/i, "").trim();
        }
      }
    }

    const insurers = insurersLine
      ? insurersLine.split(/[,;]+/).map(s => s.trim()).filter(Boolean)
      : [];

    const states = licensedStates
      ? licensedStates.split(/[,;]+/).map(s => s.trim()).filter(Boolean).map(s => s.length===2 ? s.toUpperCase() : s)
      : [];

    const langs = languages
      ? languages.split(/[,;]+/).map(s => s.trim()).filter(Boolean)
      : [];

    out.push({
      id, name, role, styles,
      lived_experience: lived,
      languages: langs,
      licensed_states: states,
      insurers_raw: insurersLine,
      insurers,
      email
    });
  }

  return out;
}

function parseSchedule(txt){
  // Expected per line: prov_039|2025-09-22|09:00
  if (!txt || !txt.trim()) return [];
  const items = txt
    .replace(/\r\n/g,"\n")
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split("|").map(p => p.trim());
      if (parts.length < 3) return null;
      const [id, date, time] = parts;
      if (!/^prov_\d+/i.test(id)) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      if (!/^\d{2}:\d{2}$/.test(time)) return null;
      return { id, date, time, dt: `${date} ${time}` };
    })
    .filter(Boolean);

  items.sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  return items;
}

// -------------------------------
// Hints extraction (semantic-ish, no rigid keywords)
// -------------------------------
function extractHintsFromHistory(history, latestUserMessage){
  const allText = (history.map(h => h.content).join(" ") + " " + (latestUserMessage||"")).toLowerCase();

  // State (two-letter) heuristic
  // prefers explicit " az " but also allows "arizona"
  const STATE_ABBRS = ["al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy"];
  let state = "";
  for (const abbr of STATE_ABBRS){
    if (new RegExp(`\\b${abbr}\\b`).test(allText)) { state = abbr.toUpperCase(); break; }
  }
  if (!state){
    const STATE_NAMES = {
      arizona:"AZ", california:"CA", colorado:"CO", texas:"TX", utah:"UT", oregon:"OR", washington:"WA", nevada:"NV",
      newyork:"NY","new york":"NY", newmexico:"NM","new mexico":"NM", florida:"FL", georgia:"GA", idaho:"ID", illinois:"IL",
      indiana:"IN", iowa:"IA", kansas:"KS", kentucky:"KY", louisiana:"LA", maine:"ME", maryland:"MD", massachusetts:"MA",
      michigan:"MI", minnesota:"MN", mississippi:"MS", missouri:"MO", montana:"MT", nebraska:"NE", "new hampshire":"NH",
      newhampshire:"NH", newjersey:"NJ","new jersey":"NJ", northcarolina:"NC","north carolina":"NC",
      northdakota:"ND","north dakota":"ND", ohio:"OH", oklahoma:"OK", pennsylvania:"PA", rhodeisland:"RI","rhode island":"RI",
      southcarolina:"SC","south carolina":"SC", southdakota:"SD","south dakota":"SD", tennessee:"TN", virginia:"VA",
      vermont:"VT", westvirginia:"WV","west virginia":"WV", wisconsin:"WI", wyoming:"WY", alabama:"AL", alaska:"AK",
      connecticut:"CT", delaware:"DE", hawaii:"HI"
    };
    for (const [name, abbr] of Object.entries(STATE_NAMES)){
      if (allText.includes(name)) { state = abbr; break; }
    }
  }

  // Payment vs insurance feel
  const wantsCash = /\bcash\b|\bself[- ]?pay\b|\bout[- ]?of[- ]?pocket\b/.test(allText);
  const planMatch = allText.match(/\b(aetna|bcbs|blue\s?cross|blue\s?shield|cigna|humana|united\s?health|uhc|medicare|medicaid)\b/i);
  const plan = planMatch ? planMatch[1].toLowerCase() : "";

  // Modality preference feeling
  const prefersPsych  = /\bpsych(iatry|iatrist| med(ication)?|med management)\b/.test(allText);
  const prefersTherap = /\btherap(y|ist)\b/.test(allText);
  const prefersBoth   = /both\b|combo|combined/.test(allText);

  // Language/gender cues (soft)
  const wantsFemale = /\bfemale|woman|women|she\/her\b/i.test(allText);
  const wantsMale   = /\bmale|man|men|he\/him\b/i.test(allText);
  const langMatch   = allText.match(/\b(english|spanish|mandarin|hindi|arabic|french|portuguese|german|asl)\b/i);
  const language    = (langMatch?.[1] || "").toLowerCase() || "english";

  return { state, wantsCash, plan, prefersPsych, prefersTherap, prefersBoth, wantsFemale, wantsMale, language };
}

// -------------------------------
// Filtering & context building
// -------------------------------
function scoreProvider(p, hints){
  let score = 0;

  // State
  if (hints.state && p.licensed_states?.includes(hints.state)) score += HINT_WEIGHT_BONUS;

  // Payment / insurance feel
  const insLow = (p.insurers_raw || p.insurers?.join(",") || "").toLowerCase();
  if (hints.wantsCash && insLow.includes("cash")) score += HINT_WEIGHT_BONUS;
  if (hints.plan && insLow.includes(hints.plan)) score += SECONDARY_WEIGHT_BONUS;

  // Modality
  if (hints.prefersBoth && p.role === "both") score += HINT_WEIGHT_BONUS;
  if (hints.prefersPsych && p.role === "psychiatrist") score += HINT_WEIGHT_BONUS;
  if (hints.prefersTherap && p.role === "therapist") score += HINT_WEIGHT_BONUS;

  // Language
  const langsLow = (p.languages||[]).map(x=>x.toLowerCase());
  if (hints.language && langsLow.includes(hints.language)) score += SECONDARY_WEIGHT_BONUS;

  // Gentle preference nudge if name suggests gender (not reliable, so very soft)
  if (hints.wantsFemale && /(\bmd\b|\bpmhnp\b|\bpsyd\b|\bphd\b|\blpc\b|\blmft\b|\blcsw\b)/i.test(p.name)) score += 0; // neutral
  if (hints.wantsMale   && /(\bmd\b|\bpmhnp\b|\bpsyd\b|\bphd\b|\blpc\b|\blmft\b|\blcsw\b)/i.test(p.name)) score += 0; // neutral

  // Availability boost if any slots exist
  if (SLOTS_BY_ID.has(p.id)) score += SECONDARY_WEIGHT_BONUS;

  return score;
}

function providerLine(p){
  const parts = [
    p.id,
    p.name,
    p.role || "provider",
    p.licensed_states?.length ? `states=${p.licensed_states.join(",")}` : null,
    p.insurers?.length ? `insurers=${p.insurers.join(",")}` : (p.insurers_raw ? `insurers=${p.insurers_raw}` : null),
    p.languages?.length ? `langs=${p.languages.join(",")}` : null,
    p.styles ? `styles=${p.styles}` : null,
    p.lived_experience ? `lived=${p.lived_experience}` : null,
    p.email ? `email=${p.email}` : null
  ].filter(Boolean);
  return parts.join(" | ");
}

function scheduleIndexLinesFor(ids){
  // Build compact index only for chosen provider ids
  const lines = [];
  let usedChars = 0;
  let usedRows = 0;

  for (const id of ids){
    const arr = SLOTS_BY_ID.get(id);
    if (!arr || !arr.length) continue;
    const line = `${id}: ${arr.join(", ")}`;
    const nextChars = usedChars + line.length + 1;
    if (nextChars > SCHEDULE_CONTEXT_CHAR_BUDGET || usedRows >= SCHEDULE_LINES_HARD_CAP) break;
    lines.push(line);
    usedChars = nextChars;
    usedRows++;
  }
  return lines;
}

function buildDatasetContextFiltered(hints){
  // Score & select
  const scored = PROVIDERS.map(p => ({ p, s: scoreProvider(p, hints) }));
  scored.sort((a,b) => b.s - a.s);

  // If everything scored 0 (no hints), keep first N but still cap by chars
  const ordered = scored.map(x => x.p);

  const lines = [];
  let used = 0;
  for (const p of ordered){
    const line = providerLine(p);
    const next = used + line.length + 1;
    if (next > PROVIDER_CONTEXT_CHAR_BUDGET || lines.length >= PROVIDER_HARD_CAP) break;
    lines.push(line);
    used = next;
  }

  // Build availability (only for providers we actually included)
  const chosenIds = new Set(lines.map(l => l.split(" | ")[0]));
  const schedLines = scheduleIndexLinesFor(chosenIds);

  const visibleDirectory = `
# Provider Directory (use ONLY entries here; do not invent)
# Format per line: id | name | role | states=... | insurers=... | langs=... | styles=... | lived=... | email=...
${lines.join("\n")}`.trim();

  const hiddenSchedule = schedLines.length ? `
# Availability Index (for your internal reasoning; DO NOT quote verbatim)
# Format: provider_id: YYYY-MM-DD HH:MM, YYYY-MM-DD HH:MM, ...
${schedLines.join("\n")}`.trim() : "";

  return `${visibleDirectory}\n\n${hiddenSchedule}`.trim();
}

// Build a quick index of slots by provider id for scoring/compaction
let SLOTS_BY_ID = new Map();
function indexSlots(){
  SLOTS_BY_ID = new Map();
  for (const s of SLOTS){
    if (!SLOTS_BY_ID.has(s.id)) SLOTS_BY_ID.set(s.id, []);
    SLOTS_BY_ID.get(s.id).push(`${s.date} ${s.time}`);
  }
}

// -------------------------------
// Azure OpenAI call
// -------------------------------
async function callAOAI(url, messages, temperature, maxTokens, apiKey){
  const resp = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "api-key": apiKey },
    body: JSON.stringify({
      messages,
      temperature,
      max_completion_tokens: maxTokens
    })
  });
  const ct = resp.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await resp.json() : { text: await resp.text() };
  return { resp, data };
}

// -------------------------------
// Main HTTP handler
// -------------------------------
module.exports = async function (context, req){
  try{
    initConfig();
    indexSlots();

    const userMessage = norm(req.body?.message);
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // Keep only last N turns and trim content (UI already limits)
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const normalizedHistory = history
      .slice(-MAX_HISTORY_TURNS)
      .map(m => ({ role: m?.role === "assistant" ? "assistant" : "user", content: norm(m?.content) }))
      .filter(m => m.content);

    // AOAI env
    const apiVersion = norm(process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview");
    const endpoint   = norm(process.env.AZURE_OPENAI_ENDPOINT || "");
    const deployment = norm(process.env.AZURE_OPENAI_DEPLOYMENT || "");
    const apiKey     = norm(process.env.AZURE_OPENAI_API_KEY || "");

    if (!endpoint || !deployment || !apiKey){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply:"Hello! (Model not configured yet.)" } };
      return;
    }

    const url = `${endpoint.replace(/\/+$/,"")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    // ---------------------------
    // Build filtered dataset context
    // ---------------------------
    const hints = extractHintsFromHistory(normalizedHistory, userMessage);
    const directoryContext = buildDatasetContextFiltered(hints);

    // Compose messages
    const systemContent =
      (SYS_PROMPT || "You are a helpful behavioral health intake assistant.") +
      "\n\n" + directoryContext;

    const messages = [
      { role:"system", content: systemContent },
      ...normalizedHistory,
      { role:"user", content: userMessage }
    ];

    // Token budget
    const requestedMax = Number.isFinite(req.body?.max_output_tokens) ? req.body.max_output_tokens : 0;
    const maxTokens = Math.max(requestedMax, DEFAULT_MAX_COMPLETION_TOKENS);

    // Call model
    let { resp, data } = await callAOAI(url, messages, DEFAULT_TEMP, maxTokens, apiKey);
    if (!resp.ok){
      context.res = {
        status: resp.status,
        headers:{ "Content-Type":"application/json" },
        body:{ error:"LLM error", status:resp.status, detail:data }
      };
      return;
    }

    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    let reply = norm(choice?.message?.content);

    if (choice?.finish_reason === "length") {
      reply = reply ? (reply + " …") : "(I hit a token limit — continue?)";
    }

    // Debug payload
    if (req.query?.debug === "1"){
      const dataDir = path.join(__dirname, "../_data");
      const provPath = path.join(dataDir, "providers_100.txt");
      const slotPath = path.join(dataDir, "provider_schedule_14d.txt");

      // tiny preview for sanity (first few provider lines as actually parsed)
      const directoryPreview = PROVIDERS.slice(0, MAX_PROVIDERS_LINES_DEBUG_PREVIEW).map(p =>
        [p.id, p.name, p.role, (p.licensed_states||[]).join(","), (p.insurers||[]).join(","), (p.languages||[]).join(","), p.email].join(" | ")
      );

      // show some filtered sample too
      const filteredFirstLines = directoryContext
        .split("\n")
        .filter(l => l.startsWith("prov_"))
        .slice(0, MAX_PROVIDERS_LINES_DEBUG_PREVIEW);

      context.res = {
        status:200,
        headers:{ "Content-Type":"application/json" },
        body:{
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
          directory_preview: directoryPreview,
          filtered_preview: filteredFirstLines,
          history_len: normalizedHistory.length,
          hints
        }
      };
      return;
    }

    // Normal response
    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };

  } catch(e){
    // JSON-only error (no HTML/hex)
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
