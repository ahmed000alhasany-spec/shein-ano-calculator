const express = require("express");
const path = require("path");
const { chromium } = require("playwright");

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function extractUrl(input) {
  const match = String(input || "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function shortText(value, max = 3500) {
  try {
    const text =
      typeof value === "string"
        ? value
        : JSON.stringify(value);

    return text.length > max
      ? text.slice(0, max) + "...[CUT]"
      : text;
  } catch {
    return "";
  }
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

app.post("/api/cart", async (req, res) => {
  const startUrl = extractUrl(req.body?.input);

  if (!startUrl) {
    return res.status(400).json({
      error: "ما لكينا رابط SHEIN."
    });
  }

  let browser;

  try {
    browser = await launchBrowser();

    const context = await browser.newContext({
      locale: "ar-AE",
      timezoneId: "Asia/Dubai",

      viewport: {
        width: 390,
        height: 844
      },

      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
        "Version/18.0 Mobile/15E148 Safari/604.1",

      extraHTTPHeaders: {
        "Accept-Language":
          "ar-AE,ar;q=0.9,en;q=0.8"
      }
    });

    const page = await context.newPage();

    const xhrLog = [];
    const jsonLog = [];
    const navigationLog = [];

    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) {
        navigationLog.push(frame.url());
      }
    });

    page.on("response", async response => {
      try {
        const request = response.request();

        const type = request.resourceType();

        if (type !== "xhr" && type !== "fetch") {
          return;
        }

        const url = response.url();

        const entry = {
          method: request.method(),
          status: response.status(),
          type,
          url
        };

        xhrLog.push(entry);

        const headers = response.headers();

        const contentType =
          String(headers["content-type"] || "")
            .toLowerCase();

        let body = "";

        try {
          body = await response.text();
        } catch {}

        if (!body) return;

        let parsed = null;

        try {
          parsed = JSON.parse(body);
        } catch {}

        const searchable =
          parsed !== null
            ? JSON.stringify(parsed)
            : body;

        const looksUseful =
          /goods|product|sku|price|group_id|861923525|cart|share|mall_price|sale_price|retail_price|goods_id/i.test(
            searchable
          );

        if (looksUseful) {
          jsonLog.push({
            method: request.method(),
            status: response.status(),
            url,
            contentType,
            requestPostData:
              shortText(request.postData() || "", 1500),
            body: shortText(
              parsed !== null ? parsed : body,
              5000
            )
          });
        }
      } catch (e) {
        console.log(
          "XHR CAPTURE ERROR:",
          e.message
        );
      }
    });

    console.log(
      "STEP 1 ORIGINAL:",
      startUrl
    );

    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 40000
    });

    await page.waitForTimeout(8000);

    const landingUrl = page.url();

    console.log(
      "STEP 2 LANDING:",
      landingUrl
    );

    /*
      إذا OneLink وصلنا لصفحة
      cart/share/landing
      نبقى عليها حتى تشتغل طلبات البيانات.
    */

    if (
      landingUrl.includes(
        "/cart/share/landing"
      )
    ) {
      console.log(
        "FOUND REAL SHARE LANDING"
      );
    }

    /*
      نحاول نحرك الصفحة حتى نشغل
      lazy loading وأي API يتأخر.
    */

    for (let i = 0; i < 5; i++) {
      await page
        .evaluate(() => {
          window.scrollBy(
            0,
            window.innerHeight * 0.8
          );
        })
        .catch(() => {});

      await page.waitForTimeout(1200);
    }

    await page
      .evaluate(() => {
        window.scrollTo(0, 0);
      })
      .catch(() => {});

    await page.waitForTimeout(5000);

    /*
      نجمع معلومات الصفحة نفسها.
    */

    const pageData = await page.evaluate(() => {
      const text =
        document.body?.innerText || "";

      const links = Array.from(
        document.querySelectorAll("a[href]")
      )
        .map(a => a.href)
        .filter(Boolean)
        .slice(0, 100);

      const productLinks = links.filter(
        x =>
          /goods-p-|product|goods/i.test(x)
      );

      const images = Array.from(
        document.querySelectorAll("img")
      )
        .map(img =>
          img.currentSrc ||
          img.src ||
          img.getAttribute("data-src") ||
          ""
        )
        .filter(Boolean)
        .slice(0, 100);

      return {
        title: document.title,
        url: location.href,
        visibleText: text.slice(0, 6000),
        productLinks,
        imageCount: images.length
      };
    });

    /*
      نطبع النتائج بشكل واضح جداً.
    */

    console.log(
      "========== SHEIN XHR DIAGNOSTIC START =========="
    );

    console.log(
      "FINAL URL:",
      page.url()
    );

    console.log(
      "NAVIGATIONS:",
      JSON.stringify(
        navigationLog,
        null,
        2
      )
    );

    console.log(
      "TOTAL XHR FETCH:",
      xhrLog.length
    );

    console.log(
      "XHR URLS:",
      JSON.stringify(
        xhrLog.slice(0, 120),
        null,
        2
      )
    );

    console.log(
      "USEFUL JSON COUNT:",
      jsonLog.length
    );

    /*
      كل JSON مفيد نطبعه وحده
      حتى Render Search يلكاه بسهولة.
    */

    jsonLog
      .slice(0, 30)
      .forEach((item, index) => {
        console.log(
          `===== USEFUL_JSON_${index + 1} =====`
        );

        console.log(
          JSON.stringify(
            item,
            null,
            2
          )
        );
      });

    console.log(
      "PAGE DATA:",
      JSON.stringify(
        pageData,
        null,
        2
      )
    );

    console.log(
      "========== SHEIN XHR DIAGNOSTIC END =========="
    );

    await context.close();

    return res.status(422).json({
      error:
        "تم فحص طلبات بيانات السلة. هسه افتح Render > Logs وابحث عن USEFUL_JSON_1 وصوّرلي النتيجة."
    });

  } catch (error) {
    console.error(
      "DIAGNOSTIC V2 ERROR:",
      error
    );

    return res.status(500).json({
      error:
        "صار خطأ بالفحص. افتح Render > Logs وابحث عن DIAGNOSTIC V2 ERROR."
    });

  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version:
      "SHEIN-Ano-XHR-Diagnostic-v2"
  });
});

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    "SHEIN Ano XHR Diagnostic v2 running on",
    PORT
  );
});
