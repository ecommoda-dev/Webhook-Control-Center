# مركز التحكم في الويبهوكس (`Webhook-Control-Center`)

**بتعمل إيه:** إدارة اشتراكات شوبيفاي المخصّصة (Custom / API-registered) لكل أدوات الستاك — إنشاء وعرض وتعديل وحذف وإيقاف مؤقت واستئناف — مع مراقبة مبنية داخليًا ومستقبِل اختبار للـ payloads الحقيقية.
**مين بيستخدمها:** إدارة / تطوير
**الإصدار:** Worker `v1.3.0` · الواجهة `v1.3.0`   ← الاتنين مستقلين، طبيعي يختلفوا

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Webhook-Control-Center/
الـ Worker : https://webhook-control-center-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: webhook-control-center-worker     ← لازم يطابق name في wrangler.toml
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| `check_employee` · `register_pin` · `verify_employee` · `log_logout` · `get_employees` | الدخول والموظفين |
| `list_subscriptions` | كل الاشتراكات الحية + الموقوفة مؤقتًا من الـ registry |
| `get_topics_reference` | قائمة مرجعية لأشهر الـ topics (مش القائمة الكاملة) |
| `get_known_tool_names` | أسماء الأدوات المسجّلة في logs + الأداة دي نفسها |
| `create_subscription` · `update_subscription` · `delete_subscription` | إدارة الاشتراك على شوبيفاي + الـ registry |
| `pause_subscription` · `resume_subscription` · `delete_paused_subscription` | الإيقاف المؤقت والاستئناف |
| `reconcile_subscriptions` | مقارنة حية: مين شوبيفاي مسحه بصمت |
| `get_monitoring_summary` | نشاط كل أداة + المحذوف من شوبيفاي |
| `get_test_received` · `clear_test_received` | عرض/مسح الـ payloads اللي وصلت للمستقبِل |
| `get_logs` · `get_logs_count` · `get_logs_export` | سجل العمليات |

**راوت خارج البوابة:** `POST /test-receive` — مستقبِل الاختبار. مفيش `WORKER_SECRET` عليه لأن شوبيفاي مش بيبعت `Authorization`؛ التحقق بـ HMAC عن طريق `CLIENT_SECRET`.

## D1

```
tool  : webhook_control_center
type  : create · update · delete · pause · resume · reconcile · login · logout
```

> ⚠️ القيم دي **لسه مش مسجّلة** في جدول D1 في `ecommoda-constants` §7 — بند مفتوح تحت.

## D1 إضافية (جدولين زيادة عن الـ logs المشترك)

الأداة دي — وحدها في الستاك — بتكتب وتقرا من جدولين إضافيين في **نفس** قاعدة `ecommoda-dev-logs`:

```
webhook_registry         سجل محلي لكل اشتراك اتعمل من الأداة:
                         subscription_gid · topic · uri · tool_name · purpose
                         metafields_json · filter · include_fields_json
                         metafield_fetch_fields · status · created_by
                         created_at · last_verified_at · notes
                         status: active | paused | deleted_manually | removed_by_shopify

test_received_webhooks   الـ payloads اللي وصلت على /test-receive:
                         received_at · topic · webhook_id · shop_domain
                         api_version · hmac_valid · payload_json
                         enriched_metafields_json
```

> **الاتنين موجودين فعلاً في `ecommoda-dev-logs` — مفيش أي migration مطلوب.**

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون.

```
Bindings : DB → ecommoda-dev-logs
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET
Vars     : SHOP_DOMAIN     ← من [vars] في wrangler.toml
```

## CORS

`ALLOWED_ORIGINS` صارمة (`https://ecommoda-dev.github.io` بس) — لأن الأداة **أداة كتابة**: بتنشئ وتمسح اشتراكات ويبهوك حية على شوبيفاي.

## خط الأساس بعد النقل

> الأرقام اللي الأداة رجّعتها بعد ما اتأكدنا إنها شغالة من صفحة الواجهة — مرجع لأي شك بعد كده.

```
٢ اشتراكات نشطة  (stylebox_price_sync / PRODUCTS_UPDATE · manual_order_creation / DRAFT_ORDERS_CREATE)
الواجهة v1.3.0 · الـ Worker v1.3.0 · 23-08-2026
```

## فخاخ الأداة دي

- **راوت `/test-receive` لازم يفضل أول حاجة في الـ handler — قبل بوابة `WORKER_SECRET` بالظبط.** شوبيفاي مش بيبعت `Authorization` header، فلو الترتيب اتغيّر كل تسليمة هترجع 401 قبل ما الـ HMAC يتفحص أصلاً.
- **ملكية الاشتراكات:** `webhookSubscriptions` بترجّع **بس** الاشتراكات اللي اتعملت بنفس الـ OAuth client (`CLIENT_ID`). أي اشتراك اتعمل من واجهة الأدمن مش هيظهر هنا.
- **مفيش pause أصلي في شوبيفاي:** "الإيقاف المؤقت" هنا = حذف حقيقي للاشتراك مع الاحتفاظ بإعداداته في `webhook_registry` بحالة `paused`، والاستئناف بيعمل اشتراك جديد بـ `subscription_gid` جديد بيتحدّث في نفس الصف.
- **صيغة الـ topic بتختلف:** الهيدر `X-Shopify-Topic` بييجي REST (`products/update`) بينما `webhook_registry.topic` مخزّن GraphQL enum (`PRODUCTS_UPDATE`). `restTopicToGraphQLTopic` هي اللي بتوصّلهم — من غيرها الـ enrichment مش بيشتغل **من غير أي رسالة خطأ**.
- **`/test-receive` مبيرجعش 500 أبدًا** بعد ما الـ HMAC يعدّي — أي فشل بعد كده بيتبلع والرد 200، لأن تكرار الردود غير الـ 2xx بيخلي شوبيفاي يمسح الاشتراك بصمت.
- **حساسية الحروف في GitHub Pages:** الرابط المختصر كان بيرجع **404** لأن الملف كان اسمه `Index.html` بحرف كبير، وPages بيدوّر على `index.html` صغيّرة كملف افتراضي للمجلد. **اتحل** — الملف بقى `index.html`، و`Index.html` بقى صفحة تحويل. متسمّيش أي ملف واجهة بحرف كبير تاني.

## استرجاع النسخ القديمة

> ده بديل الـ tags — دفع الـ tags ممنوع من جلسات Claude Code السحابية.

```
آخر commit فيه النسخ المرقّمة القديمة: e659be3
git show e659be3:1.2.1.html
```

## مسائل مفتوحة

- `tool = webhook_control_center` وقيم الـ `type` بتاعتها **مش مسجّلة** في `ecommoda-constants` §7 — لازم تتضاف هناك
- **Build watch paths متضبّطة على `index.js` و `wrangler.toml` بس** (مش `*`) — تجربة للبند المفتوح في `ecommoda-tool-migration-playbook` §13-ب. يعني تعديل الواجهة لوحده **مش** بيشغّل build للـ Worker. لو الأداة كبرت وضافت ملفات جديدة بيعتمد عليها الـ Worker (`package.json` مثلًا)، **لازم تتضاف للـ paths** وإلا الـ Worker هيفضل على نسخة قديمة من غير أي رسالة.
