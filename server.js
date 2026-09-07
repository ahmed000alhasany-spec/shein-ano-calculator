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

function aedToUsd(aed) {
  return Number(aed) / AED_PER_USD;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function scrapeCart(startUrl) {
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

  try {
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 35000
    });

    await page.waitForTimeout(7000);

    // نخلي العناصر المؤجلة تتحمل، بس بدون ما نوصل لقسم الاقتراحات أسفل الصفحة.
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      for (let i = 0; i < 3; i++) {
        window.scrollBy(0, Math.max(350, window.innerHeight * 0.55));
        await new Promise(r => setTimeout(r, 500));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});

    await page.waitForTimeout(1500);

    const raw = await page.evaluate(() => {
      function txt(el) {
        return (el?.innerText || "").replace(/\s+/g, " ").trim();
      }

      function getImage(el) {
        const img = el?.querySelector("img");
        return (
          img?.currentSrc ||
          img?.src ||
          img?.getAttribute("data-src") ||
          img?.getAttribute("data-original") ||
          ""
        );
      }

      function parseMoney(text) {
        const t = String(text || "").replace(/,/g, "");

        // نفضّل السعر اللي مرتبط بـ AED / د.إ
        let m = t.match(/(?:AED|د\.?\s*إ|دإ)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
        if (m) return { amount: Number(m[1]), currency: "AED" };

        m = t.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:AED|د\.?\s*إ|دإ)/i);
        if (m) return { amount: Number(m[1]), currency: "AED" };

        // بعض صفحات الإمارات تعرض الرقم بدون رمز واضح داخل نفس الكرت.
        const nums = [...t.matchAll(/(?:^|\s)([0-9]+(?:\.[0-9]{1,2})?)(?=\s|$)/g)]
          .map(x => Number(x[1]))
          .filter(n => n > 1 && n < 5000);

        if (nums.length) return { amount: nums[0], currency: "AED" };

        return null;
      }

      function looksLikeQtyControl(el) {
        const text = txt(el);
        const buttons = [...el.querySelectorAll("button")].map(b => txt(b));
        const labels = buttons.join(" | ");

        const hasPlus =
          buttons.some(x => x === "+" || x.includes("+")) ||
          /increase|add/i.test(labels);

        const hasMinus =
          buttons.some(x => x === "-" || x === "−" || x.includes("−")) ||
          /decrease|minus/i.test(labels);

        const hasQtyWord = /qty|quantity|الكمية|عدد/i.test(text);

        return (hasPlus && hasMinus) || (hasQtyWord && (hasPlus || hasMinus));
      }

      // نبدأ من العناصر اللي فعلاً بيها تحكم كمية.
      const all = [...document.querySelectorAll("body *")];
      const qtyNodes = all.filter(el => looksLikeQtyControl(el));

      const cards = [];
      const seenNodes = new Set();

      for (const q of qtyNodes) {
        let el = q;

        // نصعد للأب لحد ما نلقى كرت مع صورة وسعر، بس ما نطلع بعيد.
        for (let i = 0; i < 7 && el; i++, el = el.parentElement) {
          if (seenNodes.has(el)) continue;

          const text = txt(el);
          const image = getImage(el);
          const money = parseMoney(text);

          if (
            image &&
            money &&
            text.length >= 12 &&
            text.length <= 1200 &&
            el.querySelectorAll("img").length <= 4
          ) {
            seenNodes.add(el);
            cards.push({ el, text, image, money });
            break;
          }
        }
      }

      // شيل الكروت المتداخلة: إذا واحد أب لكرت أصغر، نحتفظ بالأصغر.
      const minimal = cards.filter((c, i) => {
        return !cards.some((d, j) =>
          i !== j &&
          c.el.contains(d.el) &&
          c.el !== d.el
        );
      });

      const result = [];

      for (const c of minimal) {
        const text = c.text;
        const lines = (c.el.innerText || "")
          .split("\n")
          .map(x => x.replace(/\s+/g, " ").trim())
          .filter(Boolean);

        const badLine = /^(AED|د\.?\s*إ|دإ)?\s*[0-9]+(?:\.[0-9]{1,2})?\s*(AED|د\.?\s*إ|دإ)?$/i;

        const name = lines.find(line =>
          line.length >= 5 &&
          line.length <= 220 &&
          !badLine.test(line) &&
          !/^(qty|quantity|الكمية|عدد|remove|delete|حذف|save|خصم|عرض|شحن|shipping)/i.test(line) &&
          !/^[+\-−0-9\s.]+$/.test(line)
        ) || "منتج SHEIN";

        let qty = 1;

        // نحاول نلقط الرقم الظاهر بين + و -
        const qText = txt(c.el);
        const qMatch =
          qText.match(/(?:^|\s)[−-]\s*([0-9]{1,2})\s*\+(?:\s|$)/) ||
          qText.match(/(?:^|\s)\+\s*([0-9]{1,2})\s*[−-](?:\s|$)/);

        if (qMatch) qty = Math.max(1, Number(qMatch[1]) || 1);

        result.push({
          name,
          aed: c.money.amount,
          qty,
          img: c.image
        });
      }

      // إزالة التكرار الحقيقي فقط.
      const deduped = [];
      const seen = new Set();

      for (const p of result) {
        const key = `${p.name}|${p.aed}|${p.img}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(p);
      }

      // نحاول نقرأ عدد منتجات السلة من النص، وإذا وجدناه نستخدمه كحد أقصى.
      const bodyText = txt(document.body);
      const countPatterns = [
        /(?:cart|bag|السلة)[^\d]{0,20}([0-9]{1,2})\s*(?:items?|منتج|قطعة)/i,
        /([0-9]{1,2})\s*(?:items?|منتج|قطعة)[^\n]{0,20}(?:cart|bag|السلة)/i
      ];

      let expectedCount = null;
      for (const re of countPatterns) {
        const m = bodyText.match(re);
        if (m) {
          const n = Number(m[1]);
          if (n > 0 && n <= 100) {
            expectedCount = n;
            break;
          }
        }
      }

      return {
        products: expectedCount ? deduped.slice(0, expectedCount) : deduped,
        expectedCount,
        finalUrl: location.href
      };
    });

    const products = (raw.products || [])
      .filter(p =>
        p &&
        p.name &&
        Number.isFinite(Number(p.aed)) &&
        Number(p.aed) > 0.5 &&
        Number(p.aed) < 5000
      )
      .map(p => ({
        name: cleanText(p.name),
        usd: aedToUsd(Number(p.aed)),
        aed: Number(p.aed),
        qty: Math.max(1, Number(p.qty) || 1),
        img: p.img || "",
        variant: ""
      }));

    return {
      finalUrl: raw.finalUrl || page.url(),
      expectedCount: raw.expectedCount || null,
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
        error: "الصقي رابط SHEIN فقط بدون النص الطويل."
      });
    }

    const cached = cache.get(url);
    if (cached && Date.now() - cached.time < 10 * 60 * 1000) {
      return res.json(cached.data);
    }

    const result = await scrapeCart(url);

    if (!result.products.length) {
      return res.status(422).json({
        error:
          "فتحنا السلة بس ما قدرنا نحدد كروت المنتجات الحقيقية. جرّبي رابط مشاركة جديد من داخل السلة."
      });
    }

    const data = {
      url: result.finalUrl,
      products: result.products,
      detectedCount: result.expectedCount
    };

    cache.set(url, { time: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error("Cart scrape error:", err);

    const msg = String(err?.message || "");

    if (msg.includes("Executable doesn't exist")) {
      return res.status(500).json({
        error: "Chromium مو مثبت أو مساره مو مضبوط على Render."
      });
    }

    if (msg.includes("Timeout")) {
      return res.status(504).json({
        error: "SHEIN أخذ وقت أطول من اللازم. جرّبي مرة ثانية."
      });
    }

    return res.status(500).json({
      error: "صار خطأ أثناء قراءة سلة SHEIN."
    });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("SHEIN Ano strict-cart reader running on", port);
});
