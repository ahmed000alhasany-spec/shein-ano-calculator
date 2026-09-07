const express = require("express");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = new Map();
let browserPromise = null;

function getBrowser() {
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

function numberFrom(v) {
  if (v == null) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  if (typeof v === "object") {
    for (const k of [
      "amount", "value", "usd", "priceAmount", "salePrice",
      "retailPrice", "unitPrice", "price", "mallPrice"
    ]) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        const n = numberFrom(v[k]);
        if (n != null) return n;
      }
    }
    return null;
  }

  const s = String(v)
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "");

  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

function normalizeProduct(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const name = pick(obj, [
    "goods_name", "goodsName", "productName", "product_name",
    "product_title", "productTitle", "name", "title"
  ]);

  let priceRaw = pick(obj, [
    "salePrice", "sale_price", "retailPrice", "retail_price",
    "unitPrice", "unit_price", "price", "mallPrice", "amount"
  ]);

  let usd = numberFrom(priceRaw);

  if (!usd) {
    for (const k of ["priceInfo", "price_info", "salePrice", "retailPrice", "price"]) {
      if (obj[k] && typeof obj[k] === "object") {
        usd = numberFrom(obj[k]);
        if (usd) break;
      }
    }
  }

  if (!name || !usd) return null;

  let img = pick(obj, [
    "goods_img", "goodsImg", "productImage", "product_image",
    "mainImage", "main_image", "image", "img", "thumbnail"
  ]);

  if (img && typeof img === "object") {
    img = pick(img, ["url", "src", "original", "medium", "large"]);
  }

  if (typeof img === "string") {
    img = img.replace(/\\\//g, "/");
    if (img.startsWith("//")) img = "https:" + img;
  } else {
    img = "";
  }

  let qty = numberFrom(pick(obj, [
    "qty", "quantity", "goods_num", "goodsNum", "count", "num"
  ])) || 1;

  const variantParts = [];
  for (const k of [
    "sku_name", "skuName", "variant", "size", "color",
    "attr_value_name", "attrValueName"
  ]) {
    if (obj[k] && typeof obj[k] !== "object") variantParts.push(String(obj[k]));
  }

  const id = String(pick(obj, [
    "goods_id", "goodsId", "productId", "product_id", "id", "sku", "sku_code"
  ]) || "");

  return {
    id,
    name: String(name).trim(),
    usd: Number(usd),
    qty: Math.max(1, Math.round(qty)),
    img,
    variant: [...new Set(variantParts)].join(" / ")
  };
}

function walk(value, out, seen, depth = 0) {
  if (depth > 20 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, seen, depth + 1);
    return;
  }

  if (typeof value !== "object") return;

  const p = normalizeProduct(value);
  if (p) {
    const key = `${p.id || p.name}|${p.usd}|${p.variant}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }

  for (const v of Object.values(value)) {
    walk(v, out, seen, depth + 1);
  }
}

function cleanProducts(products) {
  const seen = new Set();
  const out = [];

  for (const p of products) {
    if (!p || !p.name || !Number.isFinite(p.usd)) continue;
    if (p.usd < 0.05 || p.usd > 5000) continue;

    // استبعاد أشياء واضحة مو منتجات
    const lower = p.name.toLowerCase();
    if (
      lower.includes("shipping") ||
      lower.includes("coupon") ||
      lower.includes("discount") ||
      lower.includes("subtotal") ||
      lower.includes("total")
    ) continue;

    const key = `${p.id || p.name}|${p.usd}|${p.variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  return out.slice(0, 250);
}

async function scrapeWithBrowser(startUrl) {
  const browser = await getBrowser();

  const context = await browser.newContext({
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
  const products = [];
  const seen = new Set();

  page.on("response", async (response) => {
    try {
      const type = response.request().resourceType();
      if (!["xhr", "fetch", "document"].includes(type)) return;

      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json") && type !== "document") return;

      const url = response.url().toLowerCase();
      const likely =
        url.includes("cart") ||
        url.includes("share") ||
        url.includes("goods") ||
        url.includes("product") ||
        url.includes("api");

      if (!likely && type !== "document") return;

      if (ct.includes("json")) {
        const data = await response.json().catch(() => null);
        if (data) walk(data, products, seen);
      }
    } catch {}
  });

  try {
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    // ننتظر إعادة التوجيه وطلبات السلة
    await page.waitForTimeout(7000);

    // نزّل الصفحة شوي حتى تتحمل الصور/العناصر المؤجلة
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, Math.max(500, window.innerHeight * 0.8));
        await new Promise(r => setTimeout(r, 700));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});

    await page.waitForTimeout(2500);

    // التقط أي JSON مخزن بالصفحة
    const pageObjects = await page.evaluate(() => {
      const vals = [];
      const keys = [
        "__NEXT_DATA__",
        "__INITIAL_STATE__",
        "gbRawData",
        "__NUXT__",
        "__APOLLO_STATE__"
      ];

      for (const k of keys) {
        try {
          if (window[k]) vals.push(window[k]);
        } catch {}
      }

      for (const s of document.scripts) {
        try {
          const t = (s.textContent || "").trim();
          if (!t) continue;

          if (
            s.type === "application/ld+json" ||
            s.type === "application/json"
          ) {
            vals.push(JSON.parse(t));
          }
        } catch {}
      }

      return vals;
    }).catch(() => []);

    for (const obj of pageObjects) walk(obj, products, seen);

    // محاولة قراءة كروت المنتجات مباشرة من DOM
    const domProducts = await page.evaluate(() => {
      const moneyRe = /\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/;
      const selectors = [
        '[class*="cart-item"]',
        '[class*="goods-item"]',
        '[class*="product-item"]',
        '[class*="product-card"]',
        '[data-goods-id]',
        '[data-product-id]'
      ];

      const nodes = Array.from(
        new Set(selectors.flatMap(sel => Array.from(document.querySelectorAll(sel))))
      );

      const arr = [];

      for (const el of nodes.slice(0, 300)) {
        const text = (el.innerText || "").trim();
        if (!text) continue;

        const imgEl = el.querySelector("img");
        const img =
          imgEl?.currentSrc ||
          imgEl?.src ||
          imgEl?.getAttribute("data-src") ||
          "";

        const priceMatch = text.match(moneyRe);
        const price = priceMatch ? Number(priceMatch[1]) : null;

        const lines = text
          .split("\n")
          .map(x => x.trim())
          .filter(Boolean);

        const name = lines.find(x =>
          x.length >= 4 &&
          !/^\$?\s*\d/.test(x) &&
          !/^(qty|quantity|size|color|delete|remove)/i.test(x)
        );

        if (name && price) {
          arr.push({
            name,
            salePrice: price,
            image: img,
            quantity: 1
          });
        }
      }

      return arr;
    }).catch(() => []);

    for (const p of domProducts) {
      const n = normalizeProduct(p);
      if (!n) continue;
      const key = `${n.id || n.name}|${n.usd}|${n.variant}`;
      if (!seen.has(key)) {
        seen.add(key);
        products.push(n);
      }
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");

    return {
      finalUrl,
      title,
      products: cleanProducts(products)
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
        error: "الصقي رابط مشاركة SHEIN الصحيح."
      });
    }

    const cached = cache.get(url);
    if (cached && Date.now() - cached.time < 20 * 60 * 1000) {
      return res.json(cached.data);
    }

    const result = await scrapeWithBrowser(url);

    if (!result.products.length) {
      return res.status(422).json({
        error:
          "فتحنا رابط SHEIN بمتصفح السيرفر، لكن ما گدرنا نلقط منتجات السلة. " +
          "جرّبي إنشاء رابط مشاركة جديد من داخل السلة نفسها، وإذا بقت نفس المشكلة دزّي الرابط حتى نضبط القارئ على شكل صفحة SHEIN الحالية."
      });
    }

    const data = {
      url: result.finalUrl,
      products: result.products
    };

    cache.set(url, { time: Date.now(), data });
    return res.json(data);
  } catch (err) {
    console.error("Cart scrape error:", err);

    const msg = String(err?.message || "");

    if (msg.includes("Executable doesn't exist")) {
      return res.status(500).json({
        error:
          "متصفح Chromium مو مثبت على Render بعد. لازم يتنفذ أمر تثبيت Playwright أثناء الـBuild."
      });
    }

    if (msg.includes("Timeout")) {
      return res.status(504).json({
        error:
          "SHEIN أخذ وقت أطول من اللازم بالفتح. جرّبي الرابط مرة ثانية."
      });
    }

    return res.status(500).json({
      error:
        "صار خطأ أثناء فتح رابط SHEIN بالمتصفح. جرّبي مرة ثانية بعد قليل."
    });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("SHEIN Ano Playwright server running on", port);
});

// إغلاق نظيف
async function shutdown() {
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
