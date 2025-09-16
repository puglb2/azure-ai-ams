const fs = require("fs");
const path = require("path");

function readFallback() {
  try {
    const p = path.join(__dirname, "../_data/providers_100.txt");
    const t = fs.readFileSync(p, "utf8");
    return t.split(/\n/).map(l => l.trim()).filter(Boolean).map((line, idx) => {
      // expected simple CSV: id,name,specialty,insurances,location
      const [id,name,specialty,ins,location] = line.split("|");
      return { id: id || `prov_${idx}`, name, specialty, insurances: (ins||"").split(","), location };
    });
  } catch { return []; }
}

async function fetchEMR(queryParams){
  const base = ((process.env.EMR_BASE_URL||"")+"").trim().replace(/\/+$/,"");
  const key  = ((process.env.EMR_API_KEY||"")+"").trim();
  if (!base || !key) return null;
  const url = new URL(base + "/providers");
  for (const [k,v] of Object.entries(queryParams||{})) if (v) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString(), { headers:{ "Authorization": `Bearer ${key}` } });
  if (!r.ok) return null;
  return await r.json().catch(()=> null);
}

module.exports = async function (context, req){
  try{
    const q = {
      insurance: (req.query.insurance||"").trim(),
      specialty: (req.query.specialty||"").trim(),
      location: (req.query.location||"").trim()
    };

    const emr = await fetchEMR(q);
    if (emr && Array.isArray(emr)) {
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ source:"emr", count: emr.length, items: emr } };
      return;
    }

    const items = readFallback().filter(p => {
      if (q.insurance && !(p.insurances||[]).some(x => x.toLowerCase().includes(q.insurance.toLowerCase()))) return false;
      if (q.specialty && !(p.specialty||"").toLowerCase().includes(q.specialty.toLowerCase())) return false;
      if (q.location && !(p.location||"").toLowerCase().includes(q.location.toLowerCase())) return false;
      return true;
    });

    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ source:"fallback", count: items.length, items } };
  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
