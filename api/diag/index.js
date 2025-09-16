const fs = require("fs");
const path = require("path");

module.exports = async function (context, req){
  try{
    const apiVersion = ((process.env.AZURE_OPENAI_API_VERSION||"")+"").trim();
    const endpoint   = ((process.env.AZURE_OPENAI_ENDPOINT||"")+"").trim();
    const deployment = ((process.env.AZURE_OPENAI_DEPLOYMENT||"")+"").trim();
    const search = {
      endpoint: ((process.env.AZURE_SEARCH_ENDPOINT||"")+"").trim(),
      index: ((process.env.AZURE_SEARCH_INDEX||"")+"").trim(),
      semantic: ((process.env.AZURE_SEARCH_SEMANTIC_CONFIG||"")+"").trim()
    };
    const emr = {
      base: ((process.env.EMR_BASE_URL||"")+"").trim(),
      hasKey: !!((process.env.EMR_API_KEY||"")+"").trim()
    };
    const cfgDir = path.join(__dirname, "../_config");
    const files = {
      system_prompt: fs.existsSync(path.join(cfgDir,"system_prompt.txt")),
      faqs: fs.existsSync(path.join(cfgDir,"faqs.txt")),
      policies: fs.existsSync(path.join(cfgDir,"policies.txt"))
    };
    context.res = { status:200, headers:{ "Content-Type":"application/json" }, body:{
      aoai: { endpoint: !!endpoint, deployment: !!deployment, apiVersion },
      search: { configured: !!(search.endpoint && search.index), ...search, masked:true },
      emr: { configured: !!emr.base, apiKey: emr.hasKey },
      files
    }};
  } catch(e){
    context.res = { status:500, headers:{ "Content-Type":"application/json" }, body:{ error:String(e) } };
  }
};
