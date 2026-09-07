const express = require("express");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "150kb" }));
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
    return (
      h === "onelink.shein.com" ||
      h === "shein.com" ||
      h.endsWith(".shein.com")
    );
  } catch {
    return false;
  }
}

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function num(v) {
  if (v == null) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  if (typeof v === "object") {
    for (const k of [
      "amount",
      "value",
      "salePrice",
      "sale_price",
      "retailPrice",
      "retail_price",
      "unitPrice",
      "unit_price",
      "price",
      "mallPrice"
    ]) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        const n = num(v[k]);
        if (n != null) return n;
      }
    }
    return null;
  }

  const s = String(v).replace(/,/g, "").replace(/[^\d.]/g, "");
  const n = Number(s);

  return Number.isFinite(n) && n > 0 ? n : null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return null;

  for (const k of keys) {
    if (obj[k] != null && obj[k] !== "") return obj[k];
  }

  return null;
}

function normImage(v) {
  if (!v) return "";

  if (typeof v === "object") {
    v = pick(v, ["url", "src", "original", "medium", "large"]);
  }

  if (typeof v !== "string") return "";

  v = v.replace(/\\\//g, "/");

  if (v.startsWith("//")) {
    v = "https:" + v;
  }

  return v;
}

function normalizeCandidate(obj, pathHint = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }

  const name = pick(obj, [
    "goods_name",
    "goodsName",
    "product_name",
    "productName",
    "product_title",
    "productTitle",
    "name",
    "title"
  ]);

  let price = null;

  const priceRaw = pick(obj, [
    "salePrice",
    "sale_price",
    "retailPrice",
    "retail_price",
    "unitPrice",
    "unit_price",
    "price",
    "mallPrice",
    "amount"
  ]);

  price = num(priceRaw);

  if (!price) {
    for (const k of [
      "priceInfo",
      "price_info",
      "salePrice",
      "retailPrice",
      "price"
    ]) {
      if (obj[k] && typeof obj[k] === "object") {
        price = num(obj[k]);

        if (price) break;
      }
    }
  }

  if (!name || !price) return null;

  const qty =
    num(
      pick(obj, [
        "quantity",
        "qty",
        "goods_num",
        "goodsNum",
        "count",
        "num"
      ])
    ) || 1;

  const img = normImage(
    pick(obj, [
      "goods_img",
      "goodsImg",
      "productImage",
      "product_image",
      "mainImage",
      "main_image",
      "image",
      "img",
      "thumbnail"
    ])
  );

  const id = String(
    pick(obj, [
      "goods_id",
      "goodsId",
      "product_id",
      "productId",
      "sku",
      "sku_code",
      "id"
    ]) || ""
  );

  const variant = clean(
    [
      pick(obj, ["sku_name", "skuName", "variant"]),
      pick(obj, ["size"]),
      pick(obj, ["color"])
    ]
      .filter(Boolean)
      .join(" / ")
  );

  const lowerPath = pathHint.toLowerCase();

  let score = 0;

  if (/cart|bag|checkout|shopping/.test(lowerPath)) score += 10;

  if (
    /goods_list|goodslist|cart_list|cartlist|items|products/.test(lowerPath)
  ) {
    score += 5;
  }

  if (qty >= 1 && qty <= 50) score += 3;
  if (img) score += 2;
  if (id) score += 2;

  const lowerName = clean(name).toLowerCase();

  if (
    /coupon|discount|shipping|subtotal|total|recommend|you may also like|خصم|شحن|المجموع|موصى/.test(
      lowerName
    )
  ) {
    score -= 15;
  }

  return {
    id,
    name: clean(name),
    price,
    qty: Math.max(1, Math.round(qty)),
    img,
    variant,
    score,
    sourcePath: pathHint
  };
}

function walk(value, pathHint, out, depth = 0) {
  if (depth > 20 || value == null) return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${pathHint}[${i}]`, out, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const c = normalizeCandidate(value, pathHint);

  if (c) out.push(c);

  for (const [k, v] of Object.entries(value)) {
    walk(v, `${pathHint}.${k}`, out, depth + 1);
  }
}

function dedupe(arr) {
  const best = new Map();

  for (const c of arr) {
    if (!c.name || !c.price || c.price < 0.5 || c.price > 5000) {
      continue;
    }

    const key = c.id || `${c.name}|${c.price}|${c.variant}`;

    const prev = best.get(key);

    if (!prev || c.score > prev.score) {
      best.set(key, c);
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}

function extractShareCartStrings(value, found, depth = 0) {
  if (depth > 20 || value == null) return;

  if (typeof value === "string") {
    const matches =
      value.match(
        /https?:\\?\/\\?\/[^"'\\\s]+\/share\/cart\/[^"'\\\s<]+/gi
      ) || [];

    for (let m of matches) {
      m = m.replace(/\\\//g, "/");
      found.add(m);
    }

    const rels =
      value.match(/\/share\/cart\/[^"'\\\s<]+/gi) || [];

    for (const r of rels) {
      found.add(r.replace(/\\\//g, "/"));
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const x of value) {
      extractShareCartStrings(x, found, depth + 1);
    }

    return;
  }

  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      extractShareCartStrings(v, found, depth + 1);
    }
  }
}

async function resolveOneLink(page, startUrl) {
  const shareUrls = new Set();
  const allNetworkCandidates = [];
  const responseSeen = new Set();

  function maybeCaptureUrl(u) {
    if (!u) return;

    if (u.includes("/share/cart/")) {
      shareUrls.add(u);
    }
  }

  page.on("request", (req) => {
    maybeCaptureUrl(req.url());
  });

  page.on("response", async (resp) => {
    try {
      const url = resp.url();

      maybeCaptureUrl(url);

      const req = resp.request();
      const type = req.resourceType();

      if (!["xhr", "fetch", "document"].includes(type)) return;

      const lower = url.toLowerCase();

      if (!/(cart|bag|checkout|goods|product|share|api)/.test(lower)) {
        return;
      }

      if (responseSeen.has(url)) return;

      responseSeen.add(url);

      const ct = (resp.headers()["content-type"] || "").toLowerCase();

      if (ct.includes("json")) {
        const data = await resp.json().catch(() => null);

        if (data) {
          const tmp = [];

          walk(data, `response:${url}`, tmp);

          allNetworkCandidates.push(...tmp);

          const found = new Set();

          extractShareCartStrings(data, found);

          for (const x of found) {
            if (x.startsWith("http")) {
              shareUrls.add(x);
            } else if (x.startsWith("/share/cart/")) {
              try {
                const base = new URL(url);

                shareUrls.add(
                  `${base.protocol}//${base.host}${x}`
                );
              } catch {}
            }
          }
        }
      } else if (type === "document" || ct.includes("text")) {
        const text = await resp.text().catch(() => "");

        if (text) {
          const found = new Set();

          extractShareCartStrings(text, found);

          for (const x of found) {
            if (x.startsWith("http")) {
              shareUrls.add(x);
            } else if (x.startsWith("/share/cart/")) {
              try {
                const base = new URL(url);

                shareUrls.add(
                  `${base.protocol}//${base.host}${x}`
                );
              } catch {}
            }
          }
        }
      }
    } catch {}
  });

  await page.goto(startUrl, {
    waitUntil: "domcontentloaded",
    timeout: 35000
  });

  await page.waitForTimeout(7000);

  const domFound = await page
    .evaluate(() => {
      const out = new Set();

      const push = (v) => {
        if (!v) return;

        const s = String(v);

        if (s.includes("/share/cart/")) {
          out.add(s);
        }
      };

      for (const a of document.querySelectorAll("a[href]")) {
        push(a.href);
      }

      for (const el of document.querySelectorAll(
        "[data-url],[data-href],[data-link]"
      )) {
        push(el.getAttribute("data-url"));
        push(el.getAttribute("data-href"));
        push(el.getAttribute("data-link"));
      }

      for (const m of document.querySelectorAll("meta[content]")) {
        push(m.content);
      }

      for (const s of document.scripts) {
        const t = s.textContent || "";

        const abs =
          t.match(
            /https?:\\?\/\\?\/[^"'\\\s]+\/share\/cart\/[^"'\\\s<]+/gi
          ) || [];

        for (let x of abs) {
          out.add(x.replace(/\\\//g, "/"));
        }

        const rel =
          t.match(/\/share\/cart\/[^"'\\\s<]+/gi) || [];

        for (let x of rel) {
          out.add(x.replace(/\\\//g, "/"));
        }
      }

      const html =
        document.documentElement.outerHTML || "";

      const abs2 =
        html.match(
          /https?:\\?\/\\?\/[^"'\\\s]+\/share\/cart\/[^"'\\\s<]+/gi
        ) || [];

      for (let x of abs2) {
        out.add(x.replace(/\\\//g, "/"));
      }

      const rel2 =
        html.match(/\/share\/cart\/[^"'\\\s<]+/gi) || [];

      for (let x of rel2) {
        out.add(x.replace(/\\\//g, "/"));
      }

      return [...out];
    })
    .catch(() => []);

  for (const u of domFound) {
    if (u.startsWith("http")) {
      shareUrls.add(u);
    } else if (u.startsWith("/share/cart/")) {
      try {
        const cur = new URL(page.url());

        shareUrls.add(
          `${cur.protocol}//${cur.host}${u}`
        );
      } catch {}
    }
  }

  const globals = await page
    .evaluate(() => {
      const keys = [
        "__NEXT_DATA__",
        "__INITIAL_STATE__",
        "gbRawData",
        "__NUXT__",
        "__APOLLO_STATE__"
      ];

      const out = [];

      for (const k of keys) {
        try {
          if (window[k]) out.push(window[k]);
        } catch {}
      }

      return out;
    })
    .catch(() => []);

  for (const g of globals) {
    const found = new Set();

    extractShareCartStrings(g, found);

    for (const x of found) {
      if (x.startsWith("http")) {
        shareUrls.add(x);
      } else if (x.startsWith("/share/cart/")) {
        try {
          const cur = new URL(page.url());

          shareUrls.add(
            `${cur.protocol}//${cur.host}${x}`
          );
        } catch {}
      }
    }
  }

  return {
    shareUrls: [...shareUrls],
    networkCandidates: allNetworkCandidates,
    finalUrl: page.url()
  };
}

async function extractExpectedCount(page) {
  return await page
    .evaluate(() => {
      const t =
        (document.body?.innerText || "").replace(/\s+/g, " ");

      const pats = [
        /All\s*\((\d{1,3})\)/i,
        /كل المنتجات\s*\((\d{1,3})\)/i,
        /(?:cart|bag|السلة|عربة التسوق)[^0-9]{0,40}(\d{1,3})\s*(?:items?|قطعة|منتج)/i,
        /(\d{1,3})\s*(?:items?|قطعة|منتج)[^0-9]{0,40}(?:cart|bag|السلة)/i
      ];

      for (const re of pats) {
        const m = t.match(re);

        if (m) {
          const n = Number(m[1]);

          if (n > 0 && n <= 200) {
            return n;
          }
        }
      }

      return null;
    })
    .catch(() => null);
}

async function extractDomProducts(page, expectedCount) {
  const products = await page
    .evaluate((expectedCount) => {
      const txt = (el) =>
        (el?.innerText || "").replace(/\s+/g, " ").trim();

      function imgOf(el) {
        const i = el?.querySelector("img");

        return (
          i?.currentSrc ||
          i?.src ||
          i?.getAttribute("data-src") ||
          ""
        );
      }

      function parsePrice(text) {
        const t = String(text || "").replace(/,/g, "");

        const pats = [
          /(?:AED|د\.?\s*إ|دإ)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
          /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:AED|د\.?\s*إ|دإ)/i
        ];

        for (const re of pats) {
          const m = t.match(re);

          if (m) return Number(m[1]);
        }

        return null;
      }

      function qty(el) {
        const t = txt(el);

        let m = t.match(/[−-]\s*(\d{1,2})\s*\+/);

        if (m) {
          return Math.max(1, Number(m[1]));
        }

        m = t.match(/\+\s*(\d{1,2})\s*[−-]/);

        if (m) {
          return Math.max(1, Number(m[1]));
        }

        return 1;
      }

      const candidates = [];

      const productLinks = [
        ...document.querySelectorAll(
          'a[href*="goods-p-"], a[href*="/product/"]'
        )
      ];

      for (const a of productLinks) {
        let el = a;

        for (
          let i = 0;
          i < 8 && el;
          i++, el = el.parentElement
        ) {
          const text = txt(el);
          const price = parsePrice(text);
          const img = imgOf(el);

          const buttons = [
            ...el.querySelectorAll("button")
          ].map((b) => txt(b));

          const hasPlus = buttons.some((x) =>
            x.includes("+")
          );

          const hasMinus = buttons.some(
            (x) =>
              x.includes("-") ||
              x.includes("−")
          );

          const hasQty = hasPlus && hasMinus;

          if (
            img &&
            price &&
            text.length >= 8 &&
            text.length <= 1400 &&
            el.querySelectorAll("img").length <= 4
          ) {
            const lines = (el.innerText || "")
              .split("\n")
              .map((x) =>
                x.replace(/\s+/g, " ").trim()
              )
              .filter(Boolean);

            const badMoney =
              /^(AED|د\.?\s*إ|دإ)?\s*\d+(?:\.\d+)?\s*(AED|د\.?\s*إ|دإ)?$/i;

            const name = lines.find(
              (line) =>
                line.length >= 5 &&
                line.length <= 240 &&
                !badMoney.test(line) &&
                !/^(qty|quantity|الكمية|حذف|remove|delete|خصم|عرض|شحن|shipping|save|حدد|اختيار)/i.test(
                  line
                )
            );

            if (name) {
              const href = a.href || "";

              const idMatch =
                href.match(/goods-p-(\d+)/i);

              candidates.push({
                id: idMatch
                  ? idMatch[1]
                  : href,
                name,
                price,
                qty: qty(el),
                img,
                score: hasQty ? 10 : 4
              });
            }

            break;
          }
        }
      }

      const best = new Map();

      for (const p of candidates) {
        const prev = best.get(p.id);

        if (!prev || p.score > prev.score) {
          best.set(p.id, p);
        }
      }

      let arr = [...best.values()].sort(
        (a, b) => b.score - a.score
      );

      if (
        expectedCount &&
        arr.length > expectedCount
      ) {
        arr = arr.slice(0, expectedCount);
      }

      return arr;
    }, expectedCount)
    .catch(() => []);

  return products;
}

function convertToOutput(candidates, detectedCount) {
  let arr = dedupe(candidates);

  let strong = arr.filter((x) => x.score >= 8);

  if (strong.length) {
    arr = strong;
  }

  if (
    detectedCount &&
    arr.length > detectedCount
  ) {
    arr = arr.slice(0, detectedCount);
  }

  if (
    !detectedCount &&
    arr.length > 12
  ) {
    arr = arr.slice(0, 12);
  }

  return arr.map((p) => ({
    name: clean(p.name),
    usd: Number(p.price) / AED_PER_USD,
    aed: Number(p.price),
    qty: Math.max(1, Number(p.qty) || 1),
    img: p.img || "",
    variant: p.variant || ""
  }));
}

async function scrape(startUrl) {
  const b = await getBrowser();

  const context = await b.newContext({
    locale: "en-AE",
    timezoneId: "Asia/Dubai",
    viewport: {
      width: 1365,
      height: 900
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language":
        "en-AE,en;q=0.9,ar;q=0.8"
    }
  });

  const page = await context.newPage();

  try {
    const resolved =
      await resolveOneLink(page, startUrl);

    let directShare =
      resolved.shareUrls[0] || "";

    if (directShare) {
      await page
        .goto(directShare, {
          waitUntil: "domcontentloaded",
          timeout: 35000
        })
        .catch(() => {});

      await page.waitForTimeout(6000);
    }

    await page
      .evaluate(async () => {
        window.scrollTo(0, 0);

        await new Promise((r) =>
          setTimeout(r, 500)
        );

        window.scrollBy(0, 500);

        await new Promise((r) =>
          setTimeout(r, 700)
        );

        window.scrollTo(0, 0);
      })
      .catch(() => {});

    await page.waitForTimeout(1200);

    const detectedCount =
      await extractExpectedCount(page);

    let candidates = [
      ...resolved.networkCandidates
    ];

    const stateObjects = await page
      .evaluate(() => {
        const out = [];

        const keys = [
          "__NEXT_DATA__",
          "__INITIAL_STATE__",
          "gbRawData",
          "__NUXT__",
          "__APOLLO_STATE__"
        ];

        for (const k of keys) {
          try {
            if (window[k]) {
              out.push({
                name: k,
                value: window[k]
              });
            }
          } catch {}
        }

        return out;
      })
      .catch(() => []);

    for (const obj of stateObjects) {
      const tmp = [];

      walk(
        obj.value,
        `page:${obj.name}`,
        tmp
      );

      candidates.push(...tmp);
    }

    const dom =
      await extractDomProducts(
        page,
        detectedCount
      );

    if (
      !candidates.length ||
      dedupe(candidates).filter(
        (x) => x.score >= 8
      ).length === 0
    ) {
      candidates.push(
        ...dom.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          qty: p.qty,
          img: p.img,
          variant: "",
          score: p.score,
          sourcePath: "dom"
        }))
      );
    }

    const products = convertToOutput(
      candidates,
      detectedCount
    );

    return {
      directShare,
      finalUrl: page.url(),
      detectedCount,
      products
    };
  } finally {
    await context.close().catch(() => {});
  }
}

app.post("/api/cart", async (req, res) => {
  try {
    const url =
      extractUrl(req.body?.input);

    if (!url || !allowed(url)) {
      return res.status(400).json({
        error:
          "الصقي رابط SHEIN فقط."
      });
    }

    const cached = cache.get(url);

    if (
      cached &&
      Date.now() - cached.time <
        5 * 60 * 1000
    ) {
      return res.json(cached.data);
    }

    const result = await scrape(url);

    if (!result.products.length) {
      return res.status(422).json({
        error:
          "فتحنا رابط SHEIN لكن ما ظهرت بيانات السلة بعد. جرّبي نفس الرابط مرة ثانية بعد ثواني."
      });
    }

    const data = {
      url:
        result.directShare ||
        result.finalUrl,
      detectedCount:
        result.detectedCount,
      products: result.products
    };

    cache.set(url, {
      time: Date.now(),
      data
    });

    return res.json(data);
  } catch (err) {
    console.error(
      "scrape error:",
      err
    );

    const msg = String(
      err?.message || ""
    );

    if (
      msg.includes(
        "Executable doesn't exist"
      )
    ) {
      return res.status(500).json({
        error:
          "Chromium مو مضبوط على Render."
      });
    }

    if (msg.includes("Timeout")) {
      return res.status(504).json({
        error:
          "SHEIN أخذ وقت أطول من اللازم. جرّبي مرة ثانية."
      });
    }

    return res.status(500).json({
      error:
        "صار خطأ أثناء قراءة السلة."
    });
  }
});

app.get("/health", (req, res) =>
  res.json({ ok: true })
);

const port =
  process.env.PORT || 3000;

app.listen(port, () => {
  console.log(
    "SHEIN Ano network/deeplink reader v5 running on",
    port
  );
});
