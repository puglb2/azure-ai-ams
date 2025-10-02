function extractCredentialsFromName(name){
  // Pull trailing "(LPC)" etc. if present; keeps original name as-is
  const m = (name||"").match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : "";
}

function roleToCareType(role){
  const r = (role||"").toLowerCase();
  if (r.includes("therap")) return "therapy";
  if (r.includes("psychiat")) return "psychiatry";
  if (r.includes("both")) return "both";
  return "not specified";
}

function formatSlotHuman(dateStr, timeStr){
  // Input: "YYYY-MM-DD", "HH:MM"
  // Output: "9:00 AM, Thursday, 10/03/2025"
  // (No timezone conversion; treated as local-ish)
  const [y, m, d] = dateStr.split("-").map(n => parseInt(n, 10));
  const [hh, mm] = timeStr.split(":").map(n => parseInt(n, 10));
  const jsDate = new Date(y, m - 1, d, hh, mm, 0, 0); // local

  const weekday = jsDate.toLocaleDateString("en-US", { weekday: "long" }); // e.g., Thursday

  // Time: 12-hour
  let hour12 = hh % 12;
  if (hour12 === 0) hour12 = 12;
  const ampm = hh >= 12 ? "PM" : "AM";
  const minutes = String(mm).padStart(2, "0");

  const time = `${hour12}:${minutes} ${ampm}`;
  const mdY = `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
  return `${time}, ${weekday}, ${mdY}`;
}

function firstNSlotsForProvider(id, n = 10){
  const arr = SLOTS_BY_ID.get(id) || [];
  // arr items look like "YYYY-MM-DD HH:MM"
  return arr.slice(0, n).map(s => {
    const [datePart, timePart] = s.split(" ");
    return { date: datePart, time: timePart, label: formatSlotHuman(datePart, timePart) };
  });
}
Replace your existing providerCard(p) with this version (drops the “Soonest in model” idea and prints 10 slots inline):

js
Copy code
function providerCard(p) {
  const creds = extractCredentialsFromName(p.name);
  const careType = roleToCareType(p.role);
  const statesStr = p.licensed_states?.length ? p.licensed_states.join(", ") : "Not specified";

  // Payment: always start with Cash (if not already there)
  let payment = "";
  if (p.insurers_raw || (p.insurers && p.insurers.length)) {
    const insurersList = p.insurers?.length ? p.insurers.join(", ") : p.insurers_raw;
    payment = /cash/i.test(insurersList) ? insurersList : `Cash, ${insurersList}`;
  } else {
    payment = "Cash";
  }

  const langsStr = p.languages?.length ? p.languages.join(", ") : "English";
  const lived = p.lived_experience?.trim() ? p.lived_experience : "Not specified";

  // Pull first 10 upcoming slots (formatted)
  const slots = firstNSlotsForProvider(p.id, 10);

  const lines = [];
  lines.push(`Name: ${p.name}`);
  lines.push(`Care Type: ${careType}${creds ? ` (title [${creds}])` : ""}`);
  lines.push(`Personal Experiences: ${lived}`);
  lines.push(`States: ${statesStr}`);
  lines.push(`Payment Types: ${payment}`);
  lines.push(`languages: ${langsStr}`);
  lines.push(`Soonest Appointment Slots:`);

  if (slots.length) {
    for (const s of slots) {
      lines.push(`[_] ${s.label}`);
    }
  } else {
    lines.push(`[_] No openings listed in the next 2 weeks`);
  }

  // Join with single newlines; no bullets; each field its own line
  return lines.join("\n");
}
That’s it. Everything else (loading files, scoring, filtering, debug payload, etc.) stays the same. This will render each provider as a multi-line card and include exactly up to 10 soonest slots in the format:

yaml
Copy code
Name: Brandon Puglisi
Care Type: therapy (title [LPC])
Personal Experiences: Insomnia, Grief, Eating Disorder
States: AZ
Payment Types: Cash, BCBS, UHC
languages: English
Soonest Appointment Slots:
[_] 9:00 AM, Thursday, 10/03/2025
[_] 10:40 AM, Thursday, 10/03/2025
...
If you want me to paste a full file with these two edits already merged into your last working version, say the word and I’ll drop it in one block.







You said:
full file please, and the [_] are supposed to be check boxes


ChatGPT said:
Got it — here’s a full api/chat/index.js that keeps your data loading/filtering exactly the same, but changes formatting only to render multiline provider cards with 10 soonest appointment slots and real checkbox glyphs (☐). Your ?debug=1 endpoint stays intact.

js
Copy code
// api/chat/index.js
const fs = require("fs");
const path = require("path");

// Tunables
const MAX_HISTORY_TURNS = 34;
const DEFAULT_TEMP = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 2048; // floor; client can request more
const MAX_PROVIDERS_LINES_DEBUG_PREVIEW = 5; // only for ?debug=1 payload brevity

// Filtering / context sizing
const PROVIDER_CONTEXT_CHAR_BUDGET = 12000;      // ~12k chars for providers/cards
const SCHEDULE_CONTEXT_CHAR_BUDGET = 6000;       // ~6k chars for schedule
const PROVIDER_HARD_CAP = 300;                   // absolute max providers emitted
const SCHEDULE_LINES_HARD_CAP = 600;             // absolute max schedule rows
const HINT_WEIGHT_BONUS = 4;                     // score bonus for matches
const SECONDARY_WEIGHT_BONUS = 2;                // softer match bonus

// Lazy-loaded globals
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";
let PROVIDERS = []; // structured providers
let SLOTS = [];     // structured slots

// --- Response Style (format-only)
const STYLE_GUIDE = `
## Response style
- Talk like a steady, real person—not a survey or therapist form.
- Keep sentences short and clear, like texting a friend who trusts you.
- Avoid repeating the user’s exact words. Paraphrase lightly.
- Cut filler like “Thanks for sharing” unless it’s needed once in a while.
- Ask one simple question at a time.
- Use natural transitions like “Alright,” “Got it,” “Okay, next,” etc.

## Conversation flow rules
- If the user just says something brief like “hi”, “hello”, or similar, do NOT respond with “Got it” or jump into assessment questions.
- Instead, warmly acknowledge the greeting (e.g. “Hey there!”) and follow it with an inviting, open-ended question like:
  “What’s been going on lately?” or “How have you been feeling?”
- Avoid generic filler phrases like “Got it” when the user hasn’t actually shared information yet.
- If the user engages with you on a personal level (e.g., “How’s your day going?”), respond naturally and briefly to keep the interaction warm and human (e.g., “It’s going good, thanks for asking! What's been on your mind lately?”). Keep it friendly, but smoothly steer the conversation back to the intake flow so you stay on track and on brand.

## Provider output format (multiline cards)
When listing providers, use this exact layout (each field on its own line, no bullets, no code blocks):

Name: {Full Name}
Care Type: {therapy/psychiatry/both} (title [{CREDENTIALS}])
Personal Experiences: {Lived Experience CSV or "Not specified"}
States: {AZ, CA, ...}
Payment Types: {Cash, BCBS, UHC, ...}
languages: {English, Spanish, ...}
Soonest Appointment Slots:
☐ {9:00 AM, Thursday, 10/03/2025}
☐ {10:40 AM, Thursday, 10/03/2025}
... up to 10 items
`.trim();

// Utils
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

  // Append style/formatting guidance (formatting only; does not affect data calls)
  SYS_PROMPT += `

# Output & Tone Guide (format-only)
${STYLE_GUIDE}
`;

  // Raw data
  PROVIDERS_TXT         = readIfExists(path.join(dataDir, "providers_100.txt"));
  PROVIDER_SCHEDULE_TXT = readIfExists(path.join(dataDir, "provider_schedule_14d.txt"));

  // Parse
  PROVIDERS = parseProviders(PROVIDERS_TXT);
  SLOTS     = parseSchedule(PROVIDER_SCHEDULE_TXT);
}

// Robust Parsing (no keyword triggers)

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

// ---- Helpers strictly for formatting (no change to data logic)

function extractCredentialsFromName(name){
  const m = (name||"").match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : "";
}

function roleToCareType(role){
  const r = (role||"").toLowerCase();
  if (r.includes("therap")) return "therapy";
  if (r.includes("psychiat")) return "psychiatry";
  if (r.includes("both")) return "both";
  return "not specified";
}

function formatSlotHuman(dateStr, timeStr){
  // Input: "YYYY-MM-DD", "HH:MM" -> "9:00 AM, Thursday, 10/03/2025"
  const [y, m, d] = dateStr.split("-").map(n => parseInt(n, 10));
  const [hh, mm] = timeStr.split(":").map(n => parseInt(n, 10));
  const jsDate = new Date(y, m - 1, d, hh, mm, 0, 0); // local
  const weekday = jsDate.toLocaleDateString("en-US", { weekday: "long" }); // e.g., Thursday
  let hour12 = hh % 12; if (hour12 === 0) hour12 = 12;
  const ampm = hh >= 12 ? "PM" : "AM";
  const minutes = String(mm).padStart(2, "0");
  const time = `${hour12}:${minutes} ${ampm}`;
  const mdY = `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
  return `${time}, ${weekday}, ${mdY}`;
}

let SLOTS_BY_ID = new Map();
function indexSlots(){
  SLOTS_BY_ID = new Map();
  for (const s of SLOTS){
    if (!SLOTS_BY_ID.has(s.id)) SLOTS_BY_ID.set(s.id, []);
    SLOTS_BY_ID.get(s.id).push(`${s.date} ${s.time}`);
  }
}

function firstNSlotsForProvider(id, n = 10){
  const arr = SLOTS_BY_ID.get(id) || [];
  return arr.slice(0, n).map(s => {
    const [datePart, timePart] = s.split(" ");
    return { date: datePart, time: timePart, label: formatSlotHuman(datePart, timePart) };
  });
}

// Hints extraction (semantic-ish, no rigid keywords)
function extractHintsFromHistory(history, latestUserMessage){
  const allText = (history.map(h => h.content).join(" ") + " " + (latestUserMessage||"")).toLowerCase();

  // State (two-letter) heuristic
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

// Filtering & context building
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

  // Availability boost if any slots exist
  if (SLOTS_BY_ID.has(p.id)) score += SECONDARY_WEIGHT_BONUS;

  return score;
}

// ---- Provider card (multiline with 10 slots & checkbox glyphs)
function providerCard(p) {
  const creds = extractCredentialsFromName(p.name);
  const careType = roleToCareType(p.role);
  const statesStr = p.licensed_states?.length ? p.licensed_states.join(", ") : "Not specified";

  // Payment: always list Cash first if not already present
  let payment = "";
  if (p.insurers_raw || (p.insurers && p.insurers.length)) {
    const insurersList = p.insurers?.length ? p.insurers.join(", ") : p.insurers_raw;
    payment = /cash/i.test(insurersList) ? insurersList : `Cash, ${insurersList}`;
  } else {
    payment = "Cash";
  }

  const langsStr = p.languages?.length ? p.languages.join(", ") : "English";
  const lived = p.lived_experience?.trim() ? p.lived_experience : "Not specified";

  // First 10 upcoming slots
  const slots = firstNSlotsForProvider(p.id, 10);

  const lines = [];
  lines.push(`Name: ${p.name}`);
  lines.push(`Care Type: ${careType}${creds ? ` (title [${creds}])` : ""}`);
  lines.push(`Personal Experiences: ${lived}`);
  lines.push(`States: ${statesStr}`);
  lines.push(`Payment Types: ${payment}`);
  lines.push(`languages: ${langsStr}`);
  lines.push(`Soonest Appointment Slots:`);

  if (slots.length) {
    for (const s of slots) {
      lines.push(`☐ ${s.label}`);
    }
  } else {
    lines.push(`☐ No openings listed in the next 2 weeks`);
  }

  return lines.join("\n");
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

  // Ordered providers
  const ordered = scored.map(x => x.p);

  const cardBlocks = [];
  const chosenIds = [];
  let used = 0;

  for (const p of ordered){
    const card = providerCard(p); // multiline
    const next = used + card.length + 1;
    if (next > PROVIDER_CONTEXT_CHAR_BUDGET || cardBlocks.length >= PROVIDER_HARD_CAP) break;
    cardBlocks.push(card);
    chosenIds.push(p.id);
    used = next;
  }

  // Build availability (only for providers we actually included)
  const schedLines = scheduleIndexLinesFor(chosenIds);

  const visibleDirectory = `
# Provider Cards (use ONLY entries here; do not invent)
${cardBlocks.join("\n\n")}`.trim();

  const hiddenSchedule = schedLines.length ? `
# Availability Index (for your internal reasoning; DO NOT quote verbatim)
# Format: provider_id: YYYY-MM-DD HH:MM, YYYY-MM-DD HH:MM, ...
${schedLines.join("\n")}`.trim() : "";

  return `${visibleDirectory}\n\n${hiddenSchedule}`.trim();
}

// Azure OpenAI call
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

// Main HTTP handler
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

    // Build filtered dataset context
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

      // show some filtered sample too (first few lines of the visible context)
      const filteredFirstLines = directoryContext
        .split("\n")
        .slice(0, MAX_PROVIDERS_LINES_DEBUG_PREVIEW * 6); // grab a handful of lines to see a card

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
          provider_paths: {
            provPath, provExists: fs.existsSync(provPath),
            slotPath, slotExists: fs.existsSync(slotPath)
          },
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
