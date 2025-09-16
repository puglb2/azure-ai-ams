const fs = require("fs");
const path = require("path");

function readFallback(prov){
  try {
    const p = path.join(__dirname, "../_data/provider_schedule_14d.txt");
    const t = fs.readFileSync(p, "utf8");
    const all = t.split(/\n/).map(l=>l.trim()).filter(Boolean).map(line=>{
      // CSV: prov_id|yyyy-mm-dd|HH:MM
      const [id,date,time] = line.split("|");
      return { id, date, time };
    });
    return prov ? all.filter(x => x.id === prov) : all;
  } catch { return []; }
}

async function fetchEMR(prov){
  const base = ((process.env.EMR_BASE_URL||"")+"").trim().replace(/\/+$/,"");
  const key  = ((process.env.EMR_API_KEY||"")+"").trim();
  if (!base || !key) return null;
  const url = new URL(base + "/schedule");
  if (prov) url.searchParams.set("prov", prov);
  const r = await fetch(url.toString(), { headers:{ "Authorization": `Bearer ${key}` } });
  if (!r.ok) return null;
  return await r.json().catch(()=> null);
}

module.exports = async function (context, req){
  try{
    const prov = (req.query.prov||"").trim();

    const emr = await fetchEMR(prov);
    if (emr && Array.isArray(emr)){
      context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ source:"emr", count:emr.length, items:emr } };
      return;
    }

    const items = readFallback(prov);
    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{ source:"fallback", count:items.length, items } };
  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:"server error", detail:String(e) } };
  }
};
