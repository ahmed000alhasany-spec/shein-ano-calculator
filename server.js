import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("."));

app.post("/api/cart", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || !/^https?:\/\/.+shein\.com\//i.test(url)) {
      return res.status(400).json({
        ok: false,
        error: "رابط SHEIN غير صحيح"
      });
    }

    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
        "accept-language": "ar-AE,ar;q=0.9,en;q=0.8"
      }
    });

    const html = await response.text();

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "تعذر فتح رابط SHEIN"
      });
    }

    const products = extractProducts(html);

    if (!products.length) {
      return res.status(422).json({
        ok: false,
        error:
          "فتحنا الرابط، لكن SHEIN ما أرسل تفاصيل السلة بشكل قابل للقراءة. راح نحتاج نطوّر طريقة القراءة."
      });
    }

    const totalAED = products.reduce(
      (sum, p) => sum + p.priceAED * p.quantity,
      0
    );

    return res.json({
      ok: true,
      sourceUrl: response.url,
      currency: "AED",
      products,
      totalAED: Number(totalAED.toFixed(2))
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      ok: false,
      error: "صار خطأ أثناء قراءة السلة"
    });
  }
});

function extractProducts(html) {
  const products = [];
  const seen = new Set();

  // يحاول يقرأ JSON-LD والبيانات المضمنة بالصفحة
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const match of scripts) {
    try {
      const data = JSON.parse(match[1]);
      scanObject(data, products, seen);
    } catch {}
  }

  // يبحث داخل البيانات المضمنة عن أسماء وأسعار منتجات SHEIN
  const priceRegex =
    /"(?:salePrice|retailPrice|unitPrice|price|amount)"\s*:\s*(?:"?AED\s*)?"?([0-9]+(?:\.[0-9]+)?)/gi;

  const nameRegex =
    /"(?:goods_name|goodsName|productName|name)"\s*:\s*"([^"]{3,200})"/gi;

  const names = [...html.matchAll(nameRegex)].map(m =>
    decodeText(m[1])
  );

  const prices = [...html.matchAll(priceRegex)]
    .map(m => Number(m[1]))
    .filter(n => n > 0 && n < 100000);

  const count = Math.min(names.length, prices.length);

  for (let i = 0; i < count; i++) {
    addProduct(products, seen, {
      name: names[i],
      priceAED: prices[i],
      quantity: 1
    });
  }

  return products.slice(0, 100);
}

function scanObject(value, products, seen) {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach(v => scanObject(v, products, seen));
    return;
  }

  if (typeof value !== "object") return;

  const name =
    value.name ||
    value.productName ||
    value.goods_name ||
    value.goodsName;

  let price = null;

  if (value.offers) {
    const offer = Array.isArray(value.offers)
      ? value.offers[0]
      : value.offers;

    price =
      offer?.price ||
      offer?.lowPrice ||
      offer?.salePrice;
  }

  price =
    price ||
    value.salePrice ||
    value.unitPrice ||
    value.price;

  const quantity =
    Number(
      value.quantity ||
      value.goods_num ||
      value.qty ||
      1
    ) || 1;

  if (name && price) {
    const parsedPrice = parsePrice(price);

    if (parsedPrice > 0) {
      addProduct(products, seen, {
        name: String(name),
        priceAED: parsedPrice,
        quantity
      });
    }
  }

  Object.values(value).forEach(v =>
    scanObject(v, products, seen)
  );
}

function parsePrice(value) {
  if (typeof value === "number") return value;

  if (typeof value === "object" && value !== null) {
    value =
      value.amount ||
      value.price ||
      value.value ||
      value.salePrice ||
      "";
  }

  const match = String(value)
    .replace(/,/g, "")
    .match(/[0-9]+(?:\.[0-9]+)?/);

  return match ? Number(match[0]) : 0;
}

function addProduct(products, seen, product) {
  const name = decodeText(product.name).trim();
  const priceAED = Number(product.priceAED);
  const quantity = Math.max(1, Number(product.quantity) || 1);

  if (!name || !priceAED) return;

  const key = `${name}|${priceAED}`;

  if (seen.has(key)) return;
  seen.add(key);

  products.push({
    name,
    priceAED: Number(priceAED.toFixed(2)),
    quantity
  });
}

function decodeText(text) {
  return String(text)
    .replace(/\\u([\dA-F]{4})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
}

app.listen(PORT, () => {
  console.log(`SHEIN Ano running on port ${PORT}`);
});
