const express = require("express");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const RATE = 1320;
const AED_PER_USD = 3.6725;

let browserPromise = null;
const cache = new Map();

function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  return browserPromise;
}

function extractUrl(input) {
  const m = String(input || "").match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[)\],،]+$/, "") : "";
}

function allowed(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "onelink.shein.com" || h === "shein.com" || h.endsWith(".shein.com");
  } catch {
    return false;
  }
}

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    for (const k of ["amount","value","salePrice","sale_price","retailPrice","retail_price","price","unitPrice","unit_price"]) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        const n = toNum(v[k]);
        if (n != null) return n;
      }
    }
    return null;
  }
  const s = String(v).replace(/,/g, "").replace(/[^\d.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

function normImage(v) {
  if (!v) return "";
  if (typeof v === "object") v = pick(v, ["url","src","original","medium","large"]);
  if (typeof v !== "string") return "";
  v = v.replace(/\\\//g, "/");
  if (v.startsWith("//")) v = "https:" + v;
  return v;
}

function normalizeCandidate(obj, context = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const name = pick(obj, [
    "goods_name","goodsName","product_name","productName",
    "product_title","productTitle","name","title"
  ]);

  const qtyRaw = pick(obj, [
    "quantity","qty","goods_num","goodsNum","count","num"
  ]);

  const qty = toNum(qtyRaw);

  let priceRaw = pick(obj, [
    "salePrice","sale_price","retailPrice","retail_price",
    "unitPrice","unit_price","price","mallPrice","amount"
  ]);

  let price = toNum(priceRaw);

  if (!price) {
    for (const k of ["priceInfo","price_info","salePrice","retailPrice","price"]) {
      if (obj[k] && typeof obj[k] === "object") {
        price = toNum(obj[k]);
        if (price) break;
      }
    }
  }

  if (!name || !price) return null;

  let img = pick(obj, [
    "goods_img","goodsImg","productImage","product_image",
    "mainImage","main_image","image","img","thumbnail"
  ]);

  const id = String(pick(obj, [
    "goods_id","goodsId","product_id","productId",
    "sku","sku_code","id"
  ]) || "");

  const variant = clean(
    [
      pick(obj, ["sku_name","skuName","variant"]),
      pick(obj, ["size"]),
      pick(obj, ["color"])
    ].filter(Boolean).join(" / ")
  );

  const lc = context.toLowerCase();
  const cartish =
    /cart|bag|checkout|goodslist|goods_list|cartlist|cart_list|shopping/i.test(lc) ||
    qty != null;

  return {
    id,
    name: clean(name),
    qty: Math.max(1, Math.round(qty || 1)),
    price,
    img: normImage(img),
    variant,
    cartish
  };
}

function walk(value, pathStr, found, depth = 0) {
  if (depth > 18 || value == null) return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${pathStr}[${i}]`, found, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const c = normalizeCandidate(value, pathStr);
  if (c) found.push({ ...c, sourcePath: pathStr });

  for (const [k, v] of Object.entries(value)) {
    walk(v, `${pathStr}.${k}`, found, depth + 1);
  }
}

function score(c) {
  let s = 0;
  const p = (c.sourcePath || "").toLowerCase();

  if (c.cartish) s += 5;
  if (/cart|bag|checkout/.test(p)) s += 8;
  if (/goodslist|goods_list|cartlist|cart_list|items|products/.test(p)) s += 4;
  if (c.qty >= 1 && c.qty <= 50) s += 3;
  if (c.img) s += 2;
  if (c.id) s += 2;

  const n = c.name.toLowerCase();
  if (/coupon|discount|shipping|subtotal|total|recommend|you may also like|خصم|شحن|المجموع|موصى/.test(n)) s -= 10;

  return s;
}

function dedupeCandidates(arr) {
  const best = new Map();

  for (const c of arr) {
    if (!c.name || !c.price || c.price <= 0 || c.price > 5000) continue;

    const key = c.id || `${c.name}|${c.price}|${c.variant}`;

    const prev = best.get(key);
    if (!prev || score(c) > score(prev)) best.set(key, c);
  }

  return [...best.values()].sort((a,b) => score(b) - score(a));
}

function priceToUsd(price, currencyHint) {
  // UAE store: if currency is AED or unknown from UAE page, convert AED -> USD.
  if (currencyHint === "USD") return price;
  return price / AED_PER_USD;
}

async function scrape(startUrl) {
  const b = await browser();

  const context = await b.newContext({
    locale: "ar-AE",
    timezoneId: "Asia/Dubai",
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
      "Mobile/15E148 Safari/604.1",
    extraHTTPHeaders: {
      "Accept-Language": "ar-AE,ar;q=0.9,en;q=0.8"
    }
  });

  const page = await context.newPage();
  const networkCandidates = [];
  const seenResponseUrls = new Set();

  page.on("response", async (resp) => {
    try {
      const req = resp.request();
      const type = req.resourceType();
      if (!["xhr","fetch"].includes(type)) return;

      const url = resp.url();
      const lower = url.toLowerCase();

      if (!/(cart|bag|checkout|goods|product|share|api)/.test(lower)) return;
      if (seenResponseUrls.has(url)) return;
      seenResponseUrls.add(url);

      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;

      const data = await resp.json().catch(() => null);
      if (!data) return;

      const tmp = [];
      walk(data, `response:${url}`, tmp);
      networkCandidates.push(...tmp);
    } catch {}
  });

  try {
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 35000
    });

    await page.waitForTimeout(9000);

    // Let lazy-loaded cart data settle but avoid scrolling to recommendation sections.
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 500));
      window.scrollBy(0, 500);
      await new Promise(r => setTimeout(r, 700));
      window.scrollTo(0, 0);
    }).catch(() => {});

    await page.waitForTimeout(2500);

    // Pull state blobs from the page too.
    const stateObjects = await page.evaluate(() => {
      const out = [];
      const names = [
        "__NEXT_DATA__",
        "__INITIAL_STATE__",
        "gbRawData",
        "__NUXT__",
        "__APOLLO_STATE__"
      ];

      for (const n of names) {
        try {
          if (window[n]) out.push({ name:n, value:window[n] });
        } catch {}
      }

      for (const s of document.scripts) {
        try {
          const t = (s.textContent || "").trim();
          if (!t) continue;

          if (s.type === "application/json" || s.type === "application/ld+json") {
            out.push({ name:"script-json", value:JSON.parse(t) });
          }
        } catch {}
      }

      return out;
    }).catch(() => []);

    const stateCandidates = [];
    for (const x of stateObjects) {
      walk(x.value, `page:${x.name}`, stateCandidates);
    }

    // DOM fallback: focus on blocks with quantity controls and a single product image.
    const domProducts = await page.evaluate(() => {
      const txt = el => (el?.innerText || "").replace(/\s+/g, " ").trim();

      function getImg(el) {
        const i = el?.querySelector("img");
        return i?.currentSrc || i?.src || i?.getAttribute("data-src") || "";
      }

      function hasQty(el) {
        const buttons = [...el.querySelectorAll("button")].map(b => txt(b));
        const hasP = buttons.some(x => x.includes("+"));
        const hasM = buttons.some(x => x.includes("-") || x.includes("−"));
        return hasP && hasM;
      }

      function money(text) {
        const t = text.replace(/,/g, "");
        let m = t.match(/(?:AED|د\.?\s*إ|دإ)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
        if (m) return Number(m[1]);

        m = t.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:AED|د\.?\s*إ|دإ)/i);
        if (m) return Number(m[1]);

        return null;
      }

      const qNodes = [...document.querySelectorAll("body *")].filter(hasQty);
      const cards = [];

      for (const q of qNodes) {
        let el = q;
        for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
          const text = txt(el);
          const img = getImg(el);
          const price = money(text);

          if (
            img &&
            price &&
            text.length >= 10 &&
            text.length <= 1000 &&
            el.querySelectorAll("img").length <= 3
          ) {
            const lines = (el.innerText || "")
              .split("\n")
              .map(x => x.replace(/\s+/g," ").trim())
              .filter(Boolean);

            const name = lines.find(line =>
              line.length >= 5 &&
              line.length <= 220 &&
              !/^(AED|د\.?\s*إ|دإ)?\s*\d/.test(line) &&
              !/^(qty|quantity|الكمية|حذف|remove|delete|خصم|عرض|shipping|شحن)/i.test(line)
            );

            if (name) cards.push({ name, price, img });
            break;
          }
        }
      }

      const seen = new Set();
      return cards.filter(p => {
        const k = `${p.name}|${p.price}|${p.img}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }).catch(() => []);

    let candidates = dedupeCandidates([
      ...networkCandidates,
      ...stateCandidates
    ]);

    // Prefer only candidates strongly tied to cart structures.
    let strong = candidates.filter(c => score(c) >= 8);

    // If network/state gave nothing reliable, use DOM fallback.
    let finalProducts = strong.length ? strong : domProducts.map(p => ({
      name:p.name,
      price:p.price,
      qty:1,
      img:p.img,
      variant:"",
      sourcePath:"dom",
      cartish:true
    }));

    // Detect count from page text; user's test cart has 2 items, this keeps extras out.
    const detectedCount = await page.evaluate(() => {
      const t = (document.body?.innerText || "").replace(/\s+/g," ");

      const patterns = [
        /(?:السلة|cart|bag)[^0-9]{0,30}([0-9]{1,2})\s*(?:قطعة|منتج|items?)/i,
        /([0-9]{1,2})\s*(?:قطعة|منتج|items?)[^0-9]{0,30}(?:السلة|cart|bag)/i
      ];

      for (const re of patterns) {
        const m = t.match(re);
        if (m) {
          const n = Number(m[1]);
          if (n >= 1 && n <= 100) return n;
        }
      }

      return null;
    }).catch(() => null);

    if (detectedCount && finalProducts.length > detectedCount) {
      finalProducts = finalProducts.slice(0, detectedCount);
    }

    // Last safeguard: keep only the top cart-like items if there are obvious recommendation floods.
    if (!detectedCount && finalProducts.length > 8) {
      finalProducts = finalProducts.slice(0, 8);
    }

    const products = finalProducts
      .filter(p => p.name && p.price > 0.5 && p.price < 5000)
      .map(p => ({
        name: clean(p.name),
        usd: priceToUsd(Number(p.price), "AED"),
        aed: Number(p.price),
        qty: Math.max(1, Number(p.qty) || 1),
        img: p.img || "",
        variant: p.variant || ""
      }));

    return {
      url: page.url(),
      detectedCount,
      products
    };
  } finally {
    await context.close().catch(() => {});
  }
}

app.post("/api/cart", async (req, res) => {
  try {
    const url = extractUrl(req.body?.input);

    if (!url || !allowed(url)) {
      return res.status(400).json({
        error: "الصقي رابط SHEIN فقط."
      });
    }

    const cached = cache.get(url);
    if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
      return res.json(cached.data);
    }

    const result = await scrape(url);

    if (!result.products.length) {
      return res.status(422).json({
        error:
          "فتحنا رابط السلة، بس SHEIN ما رجّع بيانات منتجات كافية. جرّبي نفس الرابط مرة ثانية."
      });
    }

    const data = {
      url: result.url,
      detectedCount: result.detectedCount,
      products: result.products
    };

    cache.set(url, { time: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(err);

    const m = String(err?.message || "");

    if (m.includes("Executable doesn't exist")) {
      return res.status(500).json({
        error: "Chromium مو مضبوط على Render."
      });
    }

    if (m.includes("Timeout")) {
      return res.status(504).json({
        error: "SHEIN أخذ وقت أطول من اللازم. جرّبي مرة ثانية."
      });
    }

    res.status(500).json({
      error: "صار خطأ أثناء قراءة السلة."
    });
  }
});

app.get("/health", (req,res) => res.json({ ok:true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("SHEIN Ano cart reader v3 running on", port));
