// api/chat/index.js
const fs = require("fs");
const path = require("path");

// ------------------ Tunables ------------------
const MAX_HISTORY_TURNS = 24;
const DEFAULT_TEMP = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 2048;
const MAX_PROVIDERS_LINES_DEBUG_PREVIEW = 5;

// ------------------ Globals -------------------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";

// Reloaded each request (so data edits are live)
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";
let PROVIDERS = [];
let SLOTS = [];

// ------------------ Utils ---------------------
function readIfExists(p){ try{ return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function normalizeText(s){
  return (s || "")
    .replace(/^\uFEFF/, "")        // strip BOM at start
    .replace(/\r\n/g, "\n")        // CRLF -> LF
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F]/g, "") // strip zero-widths & LRM/RLM
    .replace(/\u00A0/g, " ")       // NBSP -> space
    .trim();
}

// ------------------ Init ----------------------
function initConfig(){
  const cfgDir  = path.join(__dirname, "../_config");
  const dataDir = path.join(__dirname, "../_data");

  if (!SYS_PROMPT){
    const sys = readIfExists(path.join(cfgDir, "system_prompt.txt"));
    const faq = readIfExists(path.join(cfgDir, "faqs.txt"));
    const pol = readIfExists(path.join(cfgDir, "policies.txt"));
    SYS_PROMPT       = normalizeText(sys);
    FAQ_SNIPPET      = normalizeText(faq);
    POLICIES_SNIPPET = normalizeText(pol);
    if (FAQ_SNIPPET){
      SYS_PROMPT += `

# FAQ (summarize when relevant)
${FAQ_SNIPPET}`.trim();
    }
    if (POLICIES_SNIPPET){
      SYS_PROMPT += `

# Policy notes (adhere to these)
${POLICIES_SNIPPET}`.trim();
    }
  }

  const provFile = process.env.PROVIDERS_FILE || "providers_100.txt";
  const slotFile = process.env.SCHEDULE_FILE  || "provider_schedule_14d.txt";
  const provPath = path.join(dataDir, provFile);
  const slotPath = path.join(dataDir, slotFile);

  PROVIDERS_TXT         = normalizeText(readIfExists(provPath));
  PROVIDER_SCHEDULE_TXT = normalizeText(readIfExists(slotPath));

  PROVIDERS = parseProviders(PROVIDERS_TXT);
  SLOTS     = parseSchedule(PROVIDER_SCHEDULE_TXT);
}

// ------------------ Parsing -------------------
function parseProviders(raw){
  const out = [];
  if (!raw) return out;

  const lines = normalizeText(raw).split("\n");
  let cur = [];

  const isProvHeader = (line) => {
    const clean = line.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F]/g, "");
    return /^\s*prov_\d{3,}\b/i.test(clean);
  };

  function flush(){
    if (!cur.length) return;
    const block = cur.join("\n");
    const rec = parseOneProvider(block);
    if (rec) out.push(rec);
    cur = [];
  }

  for (const rawLine of lines){
    const line = rawLine.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F]/g, "").replace(/\t/g, " ");
    if (isProvHeader(line)){
      flush();
      cur.push(line.trim());
    } else {
      // keep line (including blanks) inside current block
      cur.push((line || "").trim());
    }
  }
  flush();
  return out;
}

function parseOneProvider(block){
  // clean again defensively
  block = block.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F]/g, "");
  const lines = block.split("\n").map(l => l.replace(/\t/g," ").trim());

  // first non-blank is header
  const header = (lines.find(l => l.length) || "");
  if (!header) return null;

  // accept -, – or — between name and role
  const hdr =
    header.match(/^(\s*prov_\d{3,})\s+(.+?)\s*[-–—]\s*(.+)$/i) ||
    header.match(/^(\s*prov_\d{3,})\s+(.+)$/i);
  if (!hdr) return null;

  const id   = hdr[1].trim();
  const name = (hdr[2] || "").trim();
  const roleRaw = ((hdr[3] || "").trim().toLowerCase());

  let role = "provider";
  if (roleRaw.includes("psychiat")) role = "psychiatrist";
  else if (roleRaw.includes("therap")) role = "therapist";
  else if (roleRaw.includes("both")) role = "both";

  let styles = "", lived = "", languages = "", licensedStates = "", insurersLine = "", email = "";

  for (let i = 1; i < lines.length; i++){
    const l = lines[i] || "";
    const lower = l.toLowerCase();
    if (lower.startsWith("styles:"))                styles = l.split(":").slice(1).join(":").trim();
    else if (lower.startsWith("lived experience:")) lived = l.split(":").slice(1).join(":").trim();
    else if (lower.startsWith("languages:") || lower.startsWith("language:")) languages = l.split(":").slice(1).join(":").trim();
    else if (lower.startsWith("licensed states:"))  licensedStates = l.split(":").slice(1).join(":").trim();
    else if (lower.startsWith("insurance:"))        insurersLine = l.split(":").slice(1).join(":").trim();
    else if (lower.startsWith("email:"))            email = l.split(":").slice(1).join(":").trim();
    else {
      // tolerate minor drift
      if (!licensedStates && lower.includes("licensed states")) licensedStates = l.split(":").slice(1).join(":").trim();
      if (!insurersLine && lower.includes("insurance"))         insurersLine   = l.split(":").slice(1).join(":").trim();
    }
  }

  const insurers = insurersLine ? insurersLine.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [];
  const states   = licensedStates ? licensedStates.split(/[,;]+/).map(s => s.trim()).filter(Boolean).map(s => s.length===2? s.toUpperCase() : s) : [];
  const langs    = languages ? languages.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [];

  return {
    id, name, role, styles,
    lived_experience: lived,
    languages: langs,
    licensed_states: states,
    insurers_raw: insurersLine,
    insurers,
    email
  };
}
function parseSchedule(txt){
  // Expected: prov_039|2025-09-22|09:00
  if (!txt) return [];
  const items = txt.trim().split(/\r?\n/).map(line => {
    const parts = line.split("|").map(p => p.trim());
    if (parts.length < 3) return null;
    const [id, date, time] = parts;
    if (!/^prov_\d+/i.test(id)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (!/^\d{2}:\d{2}$/.test(time)) return null;
    return { id, date, time, dt: `${date} ${time}` };
  }).filter(Boolean);

  items.sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  return items;
}

// ------------------ Context Builder ----------
function buildDatasetContext(){
  // Providers (visible to model)
  const providerLines = PROVIDERS.map(p => {
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
  });

  // Availability (index only)
  const scheduleMap = new Map();
  for (const s of SLOTS){
    if (!scheduleMap.has(s.id)) scheduleMap.set(s.id, []);
    scheduleMap.get(s.id).push(`${s.date} ${s.time}`);
  }
  const scheduleLines = [];
  for (const [pid, arr] of scheduleMap.entries()){
    scheduleLines.push(`${pid}: ${arr.join(", ")}`);
  }

  const visibleDirectory = `
# Provider Directory (use ONLY entries here; do not invent)
# Format per line: id | name | role | states=... | insurers=... | langs=... | styles=... | lived=... | email=...
${providerLines.join("\n")}`.trim();

  const hiddenSchedule = scheduleLines.length ? `
# Availability Index (for your internal reasoning; DO NOT quote verbatim)
# Format: provider_id: YYYY-MM-DD HH:MM, YYYY-MM-DD HH:MM, ...
${scheduleLines.join("\n")}`.trim() : "";

  // Strong nudge so the model actually uses the directory
  const usagePolicy = `
# Directory Use Policy (must follow)
- You MUST pick providers ONLY from "Provider Directory" above.
- If the user indicates "meds", "medication management", or "psychiatry", prefer role=psychiatrist (or "both").
- Apply user constraints: state/license, cash pay vs insurance (match "Cash Pay" case-insensitively), language.
- If matches exist, present 1–3 best options with id, name, role, licensed states, languages, pay/insurance, and email.
- If no matches exist, say so plainly and offer to escalate to care coordination.
- Do NOT invent providers or details not present in the directory.`.trim();

  return `${visibleDirectory}\n\n${hiddenSchedule}\n\n${usagePolicy}`.trim();
}

// ------------------ AOAI ---------------------
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

// ------------------ Handler ------------------
module.exports = async function (context, req){
  try{
    initConfig();

    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // Recent history only
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const normalizedHistory = history.slice(-MAX_HISTORY_TURNS).map(m => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: ((m?.content || "") + "").trim()
    })).filter(m => m.content);

    // AOAI env
    const apiVersion = ((process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview")+"").trim();
    const endpoint   = ((process.env.AZURE_OPENAI_ENDPOINT || "")+"").trim().replace(/\/+$/,"");
    const deployment = ((process.env.AZURE_OPENAI_DEPLOYMENT || "")+"").trim();
    const apiKey     = ((process.env.AZURE_OPENAI_API_KEY || "")+"").trim();

    if (!endpoint || !deployment || !apiKey){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply:"Hello! (Model not configured yet.)" } };
      return;
    }

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    // Build dataset context
    const directoryContext = buildDatasetContext();

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
    let choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    let reply  = (choice?.message?.content || "").trim();

    if (choice?.finish_reason === "length") {
      reply = reply ? (reply + " …") : "(I hit a token limit — continue?)";
    }

    if (!resp.ok){
      context.res = {
        status:502,
        headers:{ "Content-Type":"application/json" },
        body:{ error:"LLM error", status:resp.status, detail:data }
      };
      return;
    }

    // Debug view
    if (req.query?.debug === "1"){
      const directoryPreview = PROVIDERS.slice(0, MAX_PROVIDERS_LINES_DEBUG_PREVIEW).map(p =>
        [p.id, p.name, p.role, (p.licensed_states||[]).join(","), (p.insurers||[]).join(","), (p.languages||[]).join(","), p.email].join(" | ")
      );

      // Heuristic sanity (no fast-path response; just info)
      const last = userMessage.toLowerCase();
      const stateMatch = (last.match(/\b([A-Z]{2})\b/g) || []).filter(s => /^[A-Z]{2}$/.test(s));
      const wantsMeds = /\b(meds?|medication|psychiatr(y|ist|ic)|med\s*management)\b/i.test(userMessage);
      const wantsCash = /cash\s*pay|cash-pay|cashpay|cash only/i.test(userMessage);
      const filtered = PROVIDERS.filter(p => {
        const stateOk = !stateMatch.length || (p.licensed_states||[]).some(s => stateMatch.includes(s));
        const roleOk  = !wantsMeds || (p.role === "psychiatrist" || p.role === "both");
        const cashOk  = !wantsCash || ( (p.insurers_raw || p.insurers.join(",")).toLowerCase().includes("cash") );
        return stateOk && roleOk && cashOk;
      }).map(p => `${p.id} ${p.name} (${p.role})`);

      context.res = {
        status:200,
        headers:{ "Content-Type":"application/json" },
        body:{
          reply,
          finish_reason: choice?.finish_reason,
          usage: data?.usage,
          files_present: {
            system_prompt: !!SYS_PROMPT,
            faqs: !!FAQ_SNIPPET,
            policies: !!POLICIES_SNIPPET,
            providers_txt: !!PROVIDERS_TXT,
            provider_schedule_txt: !!PROVIDER_SCHEDULE_TXT
          },
          provider_counts: { providers: PROVIDERS.length, slots: SLOTS.length },
          directory_preview: directoryPreview,
          history_len: normalizedHistory.length,
          sanity_filters_for_last_message: filtered.slice(0, 10) // for quick eyeballing
        }
      };
      return;
    }

    // Normal response
    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ reply } };

  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
