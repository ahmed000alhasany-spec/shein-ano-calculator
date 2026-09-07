const express = require("express");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const AED_PER_USD = 3.6725;
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

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, "").replace(/[^\d.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function aedToUsd(aed) {
  return Number(aed) / AED_PER_USD;
}

async function resolveSharePage(page, startUrl) {
  const seen = new Set();
  let shareCandidate = "";

  page.on("request", req => {
    const u = req.url();
    if (u.includes("/share/cart/")) {
      seen.add(u);
      shareCandidate = u;
    }
  });

  page.on("response", resp => {
    const u = resp.url();
    if (u.includes("/share/cart/")) {
      seen.add(u);
      shareCandidate = u;
    }
  });

  await page.goto(startUrl, {
    waitUntil: "domcontentloaded",
    timeout: 35000
  });

  await page.waitForTimeout(5000);

  if (!shareCandidate) {
    shareCandidate = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href]")].map(a => a.href);
      return links.find(h => h.includes("/share/cart/")) || "";
    }).catch(() => "");
  }

  // بعض روابط OneLink تبقى بصفحة وسيطة؛ إذا لقينا رابط السلة الحقيقي نفتحه مباشرة.
  if (shareCandidate && page.url() !== shareCandidate) {
    await page.goto(shareCandidate, {
      waitUntil: "domcontentloaded",
      timeout: 35000
    }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  return {
    finalUrl: page.url(),
    shareUrl: shareCandidate || ""
  };
}

async function extractExpectedCount(page) {
  return await page.evaluate(() => {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ");

    const pats = [
      /كل المنتجات\s*\((\d{1,3})\)/i,
      /All\s*\((\d{1,3})\)/i,
      /(?:السلة|عربة التسوق|cart|bag)[^0-9]{0,40}(\d{1,3})\s*(?:قطعة|منتج|items?)/i,
      /(\d{1,3})\s*(?:قطعة|منتج|items?)[^0-9]{0,40}(?:السلة|cart|bag)/i
    ];

    for (const re of pats) {
      const m = t.match(re);
      if (m) {
        const n = Number(m[1]);
        if (n > 0 && n <= 200) return n;
      }
    }
    return null;
  }).catch(() => null);
}

async function extractCartCards(page, expectedCount) {
  return await page.evaluate((expectedCount) => {
    const txt = el => (el?.innerText || "").replace(/\s+/g, " ").trim();

    function getPrice(text) {
      const t = String(text || "").replace(/,/g, "");
      const patterns = [
        /(?:AED|د\.?\s*إ|دإ)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
        /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:AED|د\.?\s*إ|دإ)/i
      ];
      for (const re of patterns) {
        const m = t.match(re);
        if (m) return Number(m[1]);
      }
      return null;
    }

    function imageOf(el) {
      const img = el?.querySelector("img");
      return img?.currentSrc || img?.src || img?.getAttribute("data-src") || img?.getAttribute("data-original") || "";
    }

    function quantityOf(el) {
      const t = txt(el);
      let m = t.match(/[−-]\s*(\d{1,2})\s*\+/);
      if (m) return Math.max(1, Number(m[1]));
      m = t.match(/\+\s*(\d{1,2})\s*[−-]/);
      if (m) return Math.max(1, Number(m[1]));
      return 1;
    }

    function nameOf(el, a) {
      const lines = (el?.innerText || "")
        .split("\n")
        .map(s => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const bad = /^(AED|د\.?\s*إ|دإ)?\s*\d+(?:\.\d+)?\s*(AED|د\.?\s*إ|دإ)?$/i;

      const n = lines.find(line =>
        line.length >= 5 &&
        line.length <= 240 &&
        !bad.test(line) &&
        !/^(qty|quantity|الكمية|حذف|remove|delete|خصم|عرض|شحن|shipping|save|حدد|اختيار)/i.test(line)
      );

      return n || (a?.textContent || "").trim() || "منتج SHEIN";
    }

    const allProductLinks = [...document.querySelectorAll('a[href*="goods-p-"], a[href*="/goods-p-"]')];
    const found = [];

    for (const a of allProductLinks) {
      let el = a;
      let chosen = null;

      // نصعد للأب ونبحث عن أصغر كرت فيه السعر/الصورة أو تحكم كمية.
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        const text = txt(el);
        const buttons = [...el.querySelectorAll("button")].map(b => txt(b));
        const hasPlus = buttons.some(x => x.includes("+"));
        const hasMinus = buttons.some(x => x.includes("-") || x.includes("−"));
        const hasQty = hasPlus && hasMinus;
        const price = getPrice(text);
        const img = imageOf(el);

        if (
          text.length >= 8 &&
          text.length <= 1400 &&
          (hasQty || price) &&
          img &&
          el.querySelectorAll('a[href*="goods-p-"]').length <= 3
        ) {
          chosen = { el, price, img, hasQty };
          if (hasQty) break;
        }
      }

      if (!chosen) continue;

      const href = a.href;
      const m = href.match(/goods-p-(\d+)/i);
      const goodsId = m ? m[1] : href;

      found.push({
        goodsId,
        href,
        name: nameOf(chosen.el, a),
        aed: chosen.price,
        qty: quantityOf(chosen.el),
        img: chosen.img,
        score: chosen.hasQty ? 10 : 4
      });
    }

    // إزالة التكرار مع تفضيل الكرت اللي عنده تحكم كمية.
    const best = new Map();
    for (const p of found) {
      const prev = best.get(p.goodsId);
      if (!prev || p.score > prev.score) best.set(p.goodsId, p);
    }

    let arr = [...best.values()].sort((a,b) => b.score - a.score);

    // إذا عرفنا عدد السلة، نلتزم بيه حتى ما نجيب المقترحات.
    if (expectedCount && arr.length > expectedCount) {
      arr = arr.slice(0, expectedCount);
    }

    return arr;
  }, expectedCount).catch(() => []);
}

async function enrichFromProductPage(context, p) {
  // إذا الكرت نفسه بيه اسم + سعر + صورة، ما نحتاج فتح صفحة المنتج.
  if (p.aed && p.img && p.name && p.name !== "منتج SHEIN") return p;

  const page = await context.newPage();
  try {
    await page.goto(p.href, {
      waitUntil: "domcontentloaded",
      timeout: 25000
    });
    await page.waitForTimeout(1800);

    const info = await page.evaluate(() => {
      const body = (document.body?.innerText || "").replace(/\s+/g, " ");

      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title ||
        "";

      const img =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector("img")?.currentSrc ||
        document.querySelector("img")?.src ||
        "";

      let price = null;
      const pats = [
        /(?:AED|د\.?\s*إ|دإ)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
        /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:AED|د\.?\s*إ|دإ)/i
      ];
      for (const re of pats) {
        const m = body.match(re);
        if (m) {
          price = Number(m[1]);
          break;
        }
      }

      return { title, img, price };
    });

    return {
      ...p,
      name: p.name && p.name !== "منتج SHEIN" ? p.name : clean(info.title),
      img: p.img || info.img || "",
      aed: p.aed || info.price || null
    };
  } catch {
    return p;
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeCart(startUrl) {
  const b = await getBrowser();

  // Desktop UA حتى OneLink ما يحاول يفتح التطبيق بدل صفحة الويب.
  const context = await b.newContext({
    locale: "en-AE",
    timezoneId: "Asia/Dubai",
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-AE,en;q=0.9,ar;q=0.8"
    }
  });

  const page = await context.newPage();

  try {
    const resolved = await resolveSharePage(page, startUrl);

    // نحرك الصفحة شوي حتى تتحمل كروت السلة.
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 500));
      window.scrollBy(0, 550);
      await new Promise(r => setTimeout(r, 700));
      window.scrollTo(0, 0);
    }).catch(() => {});

    await page.waitForTimeout(1500);

    const expectedCount = await extractExpectedCount(page);
    let cards = await extractCartCards(page, expectedCount);

    // إذا عدد السلة معروف، لا نسمح بأكثر منه أبداً.
    if (expectedCount && cards.length > expectedCount) {
      cards = cards.slice(0, expectedCount);
    }

    // افتح صفحات المنتجات فقط عند الحاجة، وبحد أقصى 25 قطعة.
    const enriched = [];
    for (const p of cards.slice(0, 25)) {
      enriched.push(await enrichFromProductPage(context, p));
    }

    const products = enriched
      .filter(p => p && p.name && p.aed && Number(p.aed) > 0.5 && Number(p.aed) < 5000)
      .map(p => ({
        name: clean(p.name),
        usd: aedToUsd(Number(p.aed)),
        aed: Number(p.aed),
        qty: Math.max(1, Number(p.qty) || 1),
        img: p.img || "",
        variant: ""
      }));

    return {
      url: resolved.finalUrl,
      shareUrl: resolved.shareUrl,
      expectedCount,
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

    const result = await scrapeCart(url);

    if (!result.products.length) {
      return res.status(422).json({
        error:
          "فتحنا الرابط بس بعد ما ظهرت كروت المنتجات. جرّبي رابط مشاركة جديد من داخل السلة، وإذا استمرت راح نحتاج نقرأ رابط /share/cart المباشر بدل OneLink."
      });
    }

    const data = {
      url: result.shareUrl || result.url,
      detectedCount: result.expectedCount,
      products: result.products
    };

    cache.set(url, { time: Date.now(), data });
    return res.json(data);
  } catch (err) {
    console.error("scrape error:", err);

    const msg = String(err?.message || "");

    if (msg.includes("Executable doesn't exist")) {
      return res.status(500).json({
        error: "Chromium مو مضبوط على Render."
      });
    }

    if (msg.includes("Timeout")) {
      return res.status(504).json({
        error: "SHEIN أخذ وقت أطول من اللازم. جرّبي مرة ثانية."
      });
    }

    return res.status(500).json({
      error: "صار خطأ أثناء قراءة السلة."
    });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("SHEIN Ano direct share/cart reader v4 running on", port);
});
