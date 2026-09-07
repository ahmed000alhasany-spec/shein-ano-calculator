const express = require("express");
const path = require("path");
const { chromium } = require("playwright");

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const AED_PER_USD = 3.6725;

function extractUrl(input) {
  const m = String(input || "").match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[،)\]]+$/, "") : "";
}

function clean(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function money(text) {
  const s = String(text || "")
    .replace(/,/g, "");

  const patterns = [
    /AED\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /([0-9]+(?:\.[0-9]{1,2})?)\s*AED/i,
    /د\.?\s*إ\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /([0-9]+(?:\.[0-9]{1,2})?)\s*د\.?\s*إ/i
  ];

  for (const re of patterns) {
    const m = s.match(re);

    if (m) {
      const n = Number(m[1]);

      if (
        Number.isFinite(n) &&
        n > 0 &&
        n < 5000
      ) {
        return n;
      }
    }
  }

  return null;
}

function normalizeImage(src) {
  if (!src) return "";

  src = String(src);

  if (src.startsWith("//")) {
    return "https:" + src;
  }

  return src;
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });
}

async function getLandingPage(page, startUrl) {
  await page.goto(startUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });

  await page.waitForTimeout(7000);

  let current = page.url();

  if (
    !current.includes("/cart/share/landing")
  ) {
    await page.waitForTimeout(5000);
    current = page.url();
  }

  if (
    !current.includes("/cart/share/landing")
  ) {
    throw new Error(
      "NO_SHARE_LANDING"
    );
  }

  const u = new URL(current);

  const groupId =
    u.searchParams.get("group_id");

  const country =
    u.searchParams.get("local_country");

  const shc =
    u.searchParams.get("shc");

  if (!groupId) {
    throw new Error(
      "NO_GROUP_ID"
    );
  }

  return {
    url: current,
    groupId,
    country,
    shc
  };
}

async function waitForCart(page) {
  /*
    نخلي صفحة السلة تكمّل تحميلها
    بدون ما ننزل لقسم المقترحات.
  */

  await page.waitForTimeout(5000);

  await page
    .evaluate(() => {
      window.scrollTo(0, 0);
    })
    .catch(() => {});

  await page.waitForTimeout(1500);
}

async function readCartOnly(page) {
  return page.evaluate(() => {
    const clean = text =>
      String(text || "")
        .replace(/\s+/g, " ")
        .trim();

    const getPrice = text => {
      const s =
        String(text || "")
          .replace(/,/g, "");

      const patterns = [
        /AED\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
        /([0-9]+(?:\.[0-9]{1,2})?)\s*AED/i,
        /د\.?\s*إ\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
        /([0-9]+(?:\.[0-9]{1,2})?)\s*د\.?\s*إ/i
      ];

      for (const re of patterns) {
        const m = s.match(re);

        if (m) {
          const n = Number(m[1]);

          if (
            Number.isFinite(n) &&
            n > 0 &&
            n < 5000
          ) {
            return n;
          }
        }
      }

      return null;
    };

    const getImage = el => {
      const img =
        el.querySelector("img");

      if (!img) return "";

      let src =
        img.currentSrc ||
        img.src ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        "";

      if (src.startsWith("//")) {
        src = "https:" + src;
      }

      return src;
    };

    const getQuantity = el => {
      const text =
        clean(el.innerText);

      let m =
        text.match(
          /[−-]\s*(\d{1,2})\s*\+/
        );

      if (m) {
        return Math.max(
          1,
          Number(m[1])
        );
      }

      m =
        text.match(
          /\+\s*(\d{1,2})\s*[−-]/
        );

      if (m) {
        return Math.max(
          1,
          Number(m[1])
        );
      }

      const input =
        el.querySelector(
          'input[type="number"]'
        );

      if (input) {
        const q =
          Number(input.value);

        if (
          Number.isFinite(q) &&
          q > 0 &&
          q <= 99
        ) {
          return q;
        }
      }

      return 1;
    };

    /*
      كلمات إذا ظهرت داخل المنطقة
      نعتبرها Recommendations ونرفضها.
    */

    const badSection =
      /you may also like|recommend|recommended|trending|top picks|similar items|قد يعجبك|موصى|منتجات مشابهة|الأكثر رواجاً|اقتراحات/i;

    /*
      نبحث عن روابط المنتجات،
      لكن فقط بالجزء العلوي من صفحة
      cart/share/landing.
    */

    const links = [
      ...document.querySelectorAll(
        'a[href*="goods-p-"]'
      )
    ];

    const results = [];
    const seen = new Set();

    for (const link of links) {
      const rect =
        link.getBoundingClientRect();

      /*
        نستبعد المنتجات البعيدة جداً
        أسفل الصفحة؛ غالباً توصيات.
      */

      const absoluteTop =
        rect.top + window.scrollY;

      if (absoluteTop > 3500) {
        continue;
      }

      let card = link;

      for (
        let level = 0;
        level < 8 && card;
        level++,
        card = card.parentElement
      ) {
        const text =
          clean(card.innerText);

        if (
          !text ||
          text.length < 5 ||
          text.length > 1200
        ) {
          continue;
        }

        if (badSection.test(text)) {
          continue;
        }

        const price =
          getPrice(text);

        const image =
          getImage(card);

        if (!price || !image) {
          continue;
        }

        /*
          المنتج الحقيقي بالسلة غالباً
          يحتوي عناصر تحكم كمية أو حذف.
        */

        const buttons = [
          ...card.querySelectorAll(
            "button"
          )
        ].map(b =>
          clean(
            b.innerText ||
            b.getAttribute(
              "aria-label"
            ) ||
            ""
          )
        );

        const cardHtml =
          String(
            card.innerHTML || ""
          ).toLowerCase();

        const hasPlus =
          buttons.some(
            x => x.includes("+")
          ) ||
          cardHtml.includes(
            "quantity-plus"
          );

        const hasMinus =
          buttons.some(
            x =>
              x.includes("-") ||
              x.includes("−")
          ) ||
          cardHtml.includes(
            "quantity-minus"
          );

        const hasRemove =
          /remove|delete|trash|حذف/.test(
            text.toLowerCase() +
            " " +
            cardHtml
          );

        /*
          مهم جداً:
          إذا ماكو دليل أنه Cart Item
          ما ناخذه.
        */

        if (
          !(hasPlus && hasMinus) &&
          !hasRemove
        ) {
          continue;
        }

        const href =
          link.href || "";

        const idMatch =
          href.match(
            /goods-p-(\d+)/i
          );

        const id =
          idMatch
            ? idMatch[1]
            : href;

        if (
          !id ||
          seen.has(id)
        ) {
          continue;
        }

        const lines =
          String(
            card.innerText || ""
          )
            .split("\n")
            .map(clean)
            .filter(Boolean);

        const name =
          lines.find(line => {
            if (
              line.length < 5 ||
              line.length > 250
            ) {
              return false;
            }

            if (
              /AED|د\.?\s*إ/i.test(
                line
              )
            ) {
              return false;
            }

            if (
              /^[+\-−\d\s]+$/.test(
                line
              )
            ) {
              return false;
            }

            if (
              /remove|delete|حذف|quantity|الكمية/i.test(
                line
              )
            ) {
              return false;
            }

            return true;
          });

        if (!name) {
          continue;
        }

        seen.add(id);

        results.push({
          id,
          name,
          price,
          qty:
            getQuantity(card),
          img: image
        });

        break;
      }
    }

    return results;
  });
}

app.post(
  "/api/cart",
  async (req, res) => {
    const startUrl =
      extractUrl(
        req.body?.input
      );

    if (!startUrl) {
      return res.status(400).json({
        error:
          "ما لكينا رابط SHEIN."
      });
    }

    let browser;

    try {
      browser =
        await launchBrowser();

      const context =
        await browser.newContext({
          locale: "ar-AE",

          timezoneId:
            "Asia/Dubai",

          viewport: {
            width: 390,
            height: 844
          },

          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",

          extraHTTPHeaders: {
            "Accept-Language":
              "ar-AE,ar;q=0.9,en;q=0.8"
          }
        });

      const page =
        await context.newPage();

      const landing =
        await getLandingPage(
          page,
          startUrl
        );

      console.log(
        "REAL CART:",
        landing
      );

      await waitForCart(page);

      const products =
        await readCartOnly(page);

      console.log(
        "STRICT CART PRODUCTS:",
        products.length
      );

      /*
        إذا ما لقينا Cart Items مؤكدة
        ممنوع نستخدم Recommendations.
      */

      if (!products.length) {
        await context.close();

        return res
          .status(422)
          .json({
            error:
              "وصلنا للسلة الحقيقية، لكن SHEIN ما سمح بعرض منتجات السلة داخل متصفح السيرفر. ما راح نعرض منتجات مقترحة أو أسعار غلط."
          });
      }

      const output =
        products.map(p => ({
          name: p.name,

          usd:
            Number(p.price) /
            AED_PER_USD,

          qty:
            Math.max(
              1,
              Number(p.qty) || 1
            ),

          img:
            normalizeImage(
              p.img
            ),

          variant: ""
        }));

      await context.close();

      return res.json({
        url: landing.url,
        groupId:
          landing.groupId,
        products: output
      });

    } catch (error) {
      console.error(
        "FINAL CART ERROR:",
        error
      );

      if (
        String(
          error.message
        ).includes(
          "NO_SHARE_LANDING"
        )
      ) {
        return res
          .status(422)
          .json({
            error:
              "رابط SHEIN ما وصل إلى صفحة السلة المشتركة."
          });
      }

      if (
        String(
          error.message
        ).includes(
          "NO_GROUP_ID"
        )
      ) {
        return res
          .status(422)
          .json({
            error:
              "وصل الرابط لكن ما حصلنا رقم السلة group_id."
          });
      }

      return res
        .status(500)
        .json({
          error:
            "صار خطأ أثناء قراءة السلة."
        });

    } finally {
      if (browser) {
        await browser
          .close()
          .catch(() => {});
      }
    }
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      version:
        "SHEIN-Ano-Final-Strict-v1"
    });
  }
);

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    "SHEIN Ano FINAL strict cart reader running on",
    PORT
  );
});
