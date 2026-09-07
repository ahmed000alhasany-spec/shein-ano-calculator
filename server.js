const express = require("express");
const path = require("path");
const { URL } = require("url");

const app = express();
app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname,"public")));

const cache = new Map();

function extractUrl(input){
  const m = String(input||"").match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[)\],،]+$/,"") : "";
}
function allowed(url){
  try{
    const h = new URL(url).hostname.toLowerCase();
    return h === "onelink.shein.com" || h.endsWith(".shein.com") || h === "shein.com";
  }catch{return false}
}
function num(v){
  if(v==null) return null;
  if(typeof v==="object"){
    for(const k of ["amount","value","usd","priceAmount","salePrice","retailPrice"]){
      const n=num(v[k]); if(n!=null) return n;
    }
    return null;
  }
  const s=String(v).replace(/,/g,"").replace(/[^\d.]/g,"");
  const n=Number(s); return Number.isFinite(n)&&n>0&&n<100000?n:null;
}
function pick(o, keys){
  for(const k of keys) if(o && o[k]!=null && o[k]!=="") return o[k];
}
function normalizeProduct(o){
  if(!o || typeof o!=="object" || Array.isArray(o)) return null;
  const name=pick(o,["goods_name","goodsName","productName","product_name","name","title"]);
  const price=pick(o,["salePrice","sale_price","retailPrice","retail_price","price","unitPrice","amount"]);
  let usd=num(price);
  if(!usd && o.priceInfo) usd=num(o.priceInfo.salePrice)||num(o.priceInfo.retailPrice);
  if(!name || !usd) return null;
  let img=pick(o,["goods_img","goodsImg","productImage","product_image","image","img","thumbnail"]);
  if(img && typeof img==="object") img=pick(img,["url","src","original","medium"]);
  if(typeof img==="string" && img.startsWith("//")) img="https:"+img;
  let qty=num(pick(o,["qty","quantity","goods_num","count"]))||1;
  const variant=pick(o,["sku_name","skuName","variant","size","color"]);
  const id=String(pick(o,["goods_id","goodsId","productId","product_id","id","sku"])||"");
  return {id,name:String(name).trim(),usd:Number(usd),qty:Math.max(1,Math.round(qty)),img:typeof img==="string"?img:"",variant:variant?String(variant):""};
}
function walk(x,out,seen,depth=0){
  if(depth>16 || x==null) return;
  if(Array.isArray(x)){for(const v of x) walk(v,out,seen,depth+1); return}
  if(typeof x!=="object") return;
  const p=normalizeProduct(x);
  if(p){
    const key=(p.id||p.name)+"|"+p.usd+"|"+p.variant;
    if(!seen.has(key)){seen.add(key);out.push(p)}
  }
  for(const v of Object.values(x)) walk(v,out,seen,depth+1);
}
function parseJsonCandidates(html){
  const out=[];
  const patterns=[
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/gi,
    /window\.gbRawData\s*=\s*({[\s\S]*?});/gi
  ];
  for(const re of patterns){
    let m; while((m=re.exec(html))){
      try{out.push(JSON.parse(m[1]))}catch{}
    }
  }
  return out;
}
async function fetchHtml(url){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),18000);
  try{
    const r=await fetch(url,{redirect:"follow",signal:controller.signal,headers:{
      "user-agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "accept-language":"ar-AE,ar;q=0.9,en;q=0.8",
      "accept":"text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    }});
    if(!r.ok) throw new Error("SHEIN رجّع خطأ "+r.status);
    return {html:await r.text(),url:r.url};
  }finally{clearTimeout(timer)}
}
function fallbackProducts(html){
  const out=[],seen=new Set();
  const nameRe=/"(?:goods_name|goodsName|productName|product_name|name)"\s*:\s*"([^"]{2,180})"/g;
  let m;
  while((m=nameRe.exec(html))){
    const slice=html.slice(Math.max(0,m.index-800),Math.min(html.length,m.index+2200));
    const pm=slice.match(/"(?:salePrice|sale_price|retailPrice|retail_price|price)"\s*:\s*(?:"([^"]+)"|([0-9.]+))/);
    if(!pm) continue;
    const usd=num(pm[1]||pm[2]); if(!usd) continue;
    const im=slice.match(/"(?:goods_img|goodsImg|productImage|product_image|image|img)"\s*:\s*"([^"]+)"/);
    const name=m[1].replace(/\\u0026/g,"&").replace(/\\"/g,'"');
    const key=name+"|"+usd; if(seen.has(key)) continue; seen.add(key);
    let img=im?im[1].replace(/\\\//g,"/"):""; if(img.startsWith("//")) img="https:"+img;
    out.push({name,usd,qty:1,img,variant:""});
  }
  return out;
}

app.post("/api/cart", async (req,res)=>{
  try{
    const url=extractUrl(req.body?.input);
    if(!url || !allowed(url)) return res.status(400).json({error:"الصقي رابط مشاركة SHEIN الصحيح."});
    const key=url;
    const old=cache.get(key);
    if(old && Date.now()-old.time<30*60*1000) return res.json(old.data);

    const {html,url:finalUrl}=await fetchHtml(url);
    const products=[], seen=new Set();
    for(const obj of parseJsonCandidates(html)) walk(obj,products,seen);
    if(!products.length) for(const p of fallbackProducts(html)){const k=p.name+"|"+p.usd;if(!seen.has(k)){seen.add(k);products.push(p)}}

    // فلترة قيم غير منطقية وتقليل التكرار
    const clean=products.filter(p=>p.usd>0.05 && p.usd<5000).slice(0,200);
    if(!clean.length){
      return res.status(422).json({
        error:"وصلنا للرابط لكن SHEIN ما أرسل بيانات المنتجات بشكل قابل للقراءة. جرّبي رابط المشاركة من داخل السلة مباشرة، وإذا استمرت المشكلة نحتاج نفعّل متصفح سيرفر للقراءة."
      });
    }
    const data={url:finalUrl,products:clean};
    cache.set(key,{time:Date.now(),data});
    res.json(data);
  }catch(e){
    console.error(e);
    res.status(500).json({error:"تعذر قراءة رابط SHEIN حالياً. جرّبي الرابط مرة ثانية."});
  }
});

app.get("/health",(req,res)=>res.json({ok:true}));
const port=process.env.PORT||3000;
app.listen(port,()=>console.log("SHEIN Ano running on",port));
