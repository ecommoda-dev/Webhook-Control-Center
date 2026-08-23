# Webhook Control Center

أداة EcomModa الداخلية لإدارة اشتراكات شوبيفاي المخصّصة (Custom / API-registered) لكل أدوات الستاك — إنشاء وعرض وتعديل وحذف وإيقاف مؤقت واستئناف — مع مراقبة مبنية داخليًا ومستقبِل اختبار للـ payloads الحقيقية.

## البنية

| القطعة | المكان |
|---|---|
| الواجهة | GitHub Pages — `Index.html` |
| الـ Worker | Cloudflare — `webhook-control-center-worker` (`index.js` + `wrangler.toml`) |

القطعتين بينشروا أوتوماتيك من `main`. الـ Worker بياخد ثواني، الـ Pages بتاخد أطول — طبيعي تلاقي نافذة زمنية القطعتين فيها مش متطابقين.

## التفاصيل

`CLAUDE.md` فيه الروابط والـ endpoints وجداول D1 وفخاخ الأداة والبنود المفتوحة.
