// api/chat/index.js
const fs = require("fs");
const path = require("path");

// ---- Lightweight knobs ------------------------------------------------------
const MAX_HISTORY_TURNS = 24;
const DEFAULT_TEMP = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 2048; // floor; client can request more
const MAX_PROVIDERS_LINES_DEBUG_PREVIEW = 5;

// ---- Lazy-loaded instruction globals (cache once) ---------------------------
let SYS_PROMPT = "", FAQ_SNIPPET = "", POLICIES_SNIPPET = "";

// ---- Data (reload each request) --------------------------------------------
let PROVIDERS_TXT = "", PROVIDER_SCHEDULE_TXT = "";
let PROVIDERS = []; // structured providers
let SLOTS = [];     // structured slots

// ----------------------------------------------------------------------------
// Helpers
function readIfExists(p){ try{ return fs.readFileSync(p, "utf8"); } catch { return ""; } }

function normalizeText(s) {
  return (s || "")
    .replace(/^\uFEFF/, "")      // strip BOM
    .replace(/\r\n/g, "\n")      // CRLF -> LF
    .replace(/\u00A0/g, " ")     // NBSP -> space
    .trim();
}

// ----------------------------------------------------------------------------
// Init config
function initConfig(){
  const cfgDir  = path.join(__dirname, "../_config");
  const dataDir = path.join(__dirname, "../_data");

  // Load instruction files ONCE (safe to cache)
  if (!SYS_PROMPT) {
    const sys = readIfExists(path.join(cfgDir, "system_prompt.txt"));
    const faq = readIfExists(path.join(cfgDir, "faqs.txt"));
    const pol = readIfExists(path.join(cfgDir, "policies.txt"));

    SYS_PROMPT       = normalizeText(sys);
    FAQ_SNIPPET      = normalizeText(faq);
    POLICIES_SNIPPET = normalizeText(pol);

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
  }

  // Always reload data files so edits take effect without a restart
  const provFile = process.env.PROVIDERS_FILE || "providers_100.txt";
  const slotFile = process.env.SCHEDULE_FILE  || "provider_schedule_14d.txt";

  const provPath = path.join(dataDir, provFile);
  const slotPath = path.join(dataDir, slotFile);

  PROVIDERS_TXT         = normalizeText(readIfExists(provPath));
  PROVIDER_SCHEDULE_TXT = normalizeText(readIfExists(slotPath));

  PROVIDERS = parseProviders(PROVIDERS_TXT);
  SLOTS     = parseSchedule(PROVIDER_SCHEDULE_TXT);
}

// ----------------------------------------------------------------------------
// Parsing (tolerant; no brittle keyword triggers)

function parseProviders(raw){
  if (!raw || !raw.trim()) return [];

  // Split on *visually blank* lines (allow spaces/tabs)
  const blocks = raw.split(/\r?\n[ \t]*\r?\n+/).map(b => b.trim()).filter(Boolean);
  const out = [];

  for (const block of blocks){
    const lines = block
      .split(/\r?\n/)
      .map(l => normalizeText(l.replace(/\t/g, " ")))
      .filter(Boolean);
    if (!lines.length) continue;

    const header = lines[0];

    // Accept hyphen, en-dash, or em-dash
    // e.g. "prov_001  Name (PsyD) — Therapy"
    const headerMatch =
      header.match(/^(\S+)\s+(.+?)\s*[-–—]\s*(.+)$/) ||
      header.match(/^(\S+)\s+(.+)$/);

    if (!headerMatch) continue;

    const id   = (headerMatch[1] || "").trim();
    const name = (headerMatch[2] || "").trim();
    let roleRaw = ((headerMatch[3] || "").trim().toLowerCase());

    // Fallback: if no third capture, try splitting by any dash
    if (!roleRaw) {
      const parts = header.split(/[-–—]/);
      if (parts.length >= 2) roleRaw = (parts[parts.length - 1] || "").trim().toLowerCase();
    }

    // Light role map (kept human, not strict)
    let role = "provider";
    if (roleRaw.includes("psychiat")) role = "psychiatrist";
    else if (roleRaw.includes("therap")) role = "therapist";
    else if (roleRaw.includes("both")) role = "both";

    let styles = "", lived = "", languages = "", licensedStates = "", insurersLine = "", email = "";

    for (let i=1;i<lines.length;i++){
      const l = lines[i];
      const lower = l.toLowerCase();
      if (lower.startsWith("styles:"))                styles = l.split(":").slice(1).join(":").trim();
      else if (lower.startsWith("lived experience:")) lived = l.split(":").slice(1).join(":").trim();
      else if (lower.startsWith("languages:") || lower.startsWith("language:")) languages = l.split(":").slice(1).join(":").trim();
      else if (lower.startsWith("licensed states:"))  licensedStates = l.split(":").slice(1).join(":").trim();
      else if (lower.startsWith("insurance:"))        insurersLine = l.split(":").slice(1).join(":").trim();
      else if (lower.startsWith("email:"))            email = l.split(":").slice(1).join(":").trim();
      else {
        // tolerate minor drift (e.g., missing colon alignment)
        if (!licensedStates && lower.includes("licensed states"))  licensedStates = l.split(":").slice(1).join(":").trim();
        if (!insurersLine   && lower.includes("insurance"))        insurersLine   = l.split(":").slice(1).join(":").trim();
      }
    }

    // Keep raw values; do not normalize into controlled vocab (the model infers)
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
  // Expected: prov_039|2025-09-22|09:00
  if (!txt || !txt.trim()) return [];
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

// ----------------------------------------------------------------------------
// Dataset context sent to the model (providers are visible; availability is index-only)
function buildDatasetContext(){
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

  // Availability index per provider (kept succinct)
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

  return `${visibleDirectory}\n\n${hiddenSchedule}`.trim();
}

// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Main HTTP handler
module.exports = async function (context, req){
  try{
    initConfig();

    const userMessage = (req.body?.message || "").toString().trim();
    if (!userMessage){
      context.res = { status:400, headers:{ "Content-Type":"application/json" }, body:{ error:"message required" } };
      return;
    }

    // Keep recent turns only
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

    // Debug payload
    if (req.query?.debug === "1"){
      // Quick structured previews and sanity counters
      const directoryPreview = PROVIDERS.slice(0, MAX_PROVIDERS_LINES_DEBUG_PREVIEW).map(p =>
        [p.id, p.name, p.role, (p.licensed_states||[]).join(","), (p.insurers||[]).join(","), (p.languages||[]).join(","), p.email].join(" | ")
      );

      // Example sanity: AZ + psychiatrist + Cash Pay (case-insensitive contains)
      const azCashPsych = PROVIDERS.filter(p =>
        (p.role === "psychiatrist" || p.role === "both") &&
        (p.licensed_states || []).includes("AZ") &&
        (p.insurers_raw || p.insurers.join(",")).toLowerCase().includes("cash")
      ).map(p => `${p.id} ${p.name}`);

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
          sanity_checks: {
            az_cash_psychiatry_count: azCashPsych.length,
            az_cash_psychiatry_list: azCashPsych
          }
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
