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

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });
}

app.post("/api/cart", async (req, res) => {
  const input = req.body?.input || "";
  const startUrl = extractUrl(input);

  if (!startUrl) {
    return res.status(400).json({
      error: "ما لكينا رابط SHEIN بالنص."
    });
  }

  let browser;

  try {
    browser = await getBrowser();

    const context = await browser.newContext({
      locale: "ar-AE",
      timezoneId: "Asia/Dubai",

      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
        "Version/18.0 Mobile/15E148 Safari/604.1",

      extraHTTPHeaders: {
        "Accept-Language": "ar-AE,ar;q=0.9,en;q=0.8"
      }
    });

    const page = await context.newPage();

    const redirects = [];
    const interestingRequests = [];
    const interestingResponses = [];

    page.on("request", request => {
      const url = request.url();

      if (
        /shein|onelink|cart|share|shc|goods|product/i.test(url)
      ) {
        interestingRequests.push(url);
      }
    });

    page.on("response", response => {
      const url = response.url();

      if (
        /shein|onelink|cart|share|shc|goods|product/i.test(url)
      ) {
        interestingResponses.push({
          status: response.status(),
          url
        });
      }
    });

    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) {
        redirects.push(frame.url());
      }
    });

    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 40000
    });

    await page.waitForTimeout(10000);

    const pageInfo = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll("a[href]")
      ).map(a => a.href);

      const scripts = Array.from(
        document.querySelectorAll("script")
      ).map(s => s.textContent || "");

      const metas = Array.from(
        document.querySelectorAll("meta")
      ).map(m => ({
        name:
          m.getAttribute("name") ||
          m.getAttribute("property") ||
          m.getAttribute("http-equiv") ||
          "",
        content: m.getAttribute("content") || ""
      }));

      const bodyText =
        document.body?.innerText?.slice(0, 5000) || "";

      const html =
        document.documentElement?.outerHTML?.slice(
          0,
          200000
        ) || "";

      return {
        title: document.title,
        currentUrl: location.href,
        links,
        scripts,
        metas,
        bodyText,
        html
      };
    });

    const allText = [
      pageInfo.html,
      ...pageInfo.scripts,
      ...pageInfo.links,
      ...interestingRequests,
      ...interestingResponses.map(x => x.url)
    ].join("\n");

    const foundShareCart =
      allText.match(
        /https?:[^"'\\\s<>]*\/share\/cart\/[^"'\\\s<>]+/gi
      ) || [];

    const foundRelativeShare =
      allText.match(
        /\/share\/cart\/[^"'\\\s<>]+/gi
      ) || [];

    const shcMatches =
      allText.match(
        /(?:shc|share[_-]?cart)[^"'\\\s<>]{0,150}/gi
      ) || [];

    const deepLinks =
      allText.match(
        /(?:deep_link|deepLink|af_dp|af_web_dp|deep_link_value)[^"'<>]{0,300}/gi
      ) || [];

    const unique = arr =>
      [...new Set(arr)].slice(0, 50);

    const diagnostic = {
      originalLink: startUrl,

      finalLink: page.url(),

      title: pageInfo.title,

      redirects: unique(redirects),

      shareCartLinks: unique([
        ...foundShareCart,
        ...foundRelativeShare
      ]),

      shcData: unique(shcMatches),

      deepLinkData: unique(deepLinks),

      requests: unique(interestingRequests),

      responses: interestingResponses.slice(0, 50),

      visibleText: pageInfo.bodyText
    };

    console.log(
      "SHEIN DIAGNOSTIC:",
      JSON.stringify(diagnostic, null, 2)
    );

    await context.close();

    /*
      مهم:
      نتعمد نرجع رسالة خطأ حتى الواجهة
      ما تعرض منتجات غلط.
      تفاصيل التشخيص راح تكون بـ Render Logs.
    */

    return res.status(422).json({
      error:
        "تم فحص رابط السلة. هسه افتح Render > Logs وصوّرلي آخر جزء من السجل اللي يبدأ بـ SHEIN DIAGNOSTIC."
    });

  } catch (error) {
    console.error("DIAGNOSTIC ERROR:", error);

    return res.status(500).json({
      error:
        "صار خطأ بالتشخيص. افتح Render > Logs وصوّرلي آخر سطور."
    });

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "SHEIN-Ano-Diagnostic-v1"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    "SHEIN Ano Diagnostic v1 running on port",
    PORT
  );
});
