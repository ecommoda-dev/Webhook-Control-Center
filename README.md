# Webhook Control Center

أداة EcomModa الداخلية لإدارة اشتراكات شوبيفاي المخصّصة (Custom / API-registered) لكل أدوات الستاك — إنشاء وعرض وتعديل وحذف وإيقاف مؤقت واستئناف — مع مراقبة مبنية داخليًا ومستقبِل اختبار للـ payloads الحقيقية.

## البنية

| القطعة | المكان |
|---|---|
| الواجهة | GitHub Pages — `index.html` |
| الـ Worker | Cloudflare — `webhook-control-center-worker` (`index.js` + `wrangler.toml`) |

اتشالت `Index.html` — 23-09-2026، قرار أحمد. الرابط الوحيد: `https://ecommoda-dev.github.io/Webhook-Control-Center/`

القطعتين بينشروا أوتوماتيك من `main`. الـ Worker بياخد ثواني، الـ Pages بتاخد أطول — طبيعي تلاقي نافذة زمنية القطعتين فيها مش متطابقين.

## التفاصيل

`CLAUDE.md` فيه الروابط والـ endpoints وجداول D1 وفخاخ الأداة والبنود المفتوحة.
