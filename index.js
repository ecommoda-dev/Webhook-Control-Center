// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// Webhook Control Center — EcomModa Worker (v1.3.0)
// Manages Custom (API-registered) Shopify webhook subscriptions for every
// other tool in the stack: create / list / update / delete / pause / resume
// via webhookSubscription* mutations, plus self-built monitoring (Shopify
// has no delivery-log API and no native pause — see About modal for why).
// Also doubles as its own test receiver at POST /test-receive (HMAC via
// CLIENT_SECRET) so a subscription can be pointed at itself to inspect
// real payloads before wiring a brand-new tool.
// ══════════════════════════════════════════════════════════════
const TOOL_NAME = 'webhook_control_center'; // D1 log tool value — registered in d1-schema.md

// ══════════════════════════════════════════════════════════════
// §CORS — Option B (write tool: creates/deletes live Shopify webhooks)
// ══════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = ['https://ecommoda-dev.github.io'];
function getCORS(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// ─── §HELPERS::safeEqual / verifyShopifyHmac (webhook-receivers.md, verbatim) ───
// Used only by the /test-receive route below — CLIENT_SECRET signs any
// webhook created through webhookSubscriptionCreate (this app's own OAuth
// client), same value already present as an env var for the OAuth calls.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyShopifyHmac(secret, rawBody, headerHmac) {
  if (!secret || !headerHmac) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig    = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const digest = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return safeEqual(digest, headerHmac);
}

// ══════════════════════════════════════════════════════════════
// SHARED: Auth & Logging Functions — EcomModa D1 Pattern v1.3.0
// Copy this block VERBATIM into every Worker — no modifications
// ══════════════════════════════════════════════════════════════

async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return {
    exists:   true,
    hasPin:   !!row.pin,
    isActive: !!row.is_active,
  };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

// Accepts either a single value or a comma-separated list (multi-select
// filters from the HTML) — builds an `IN (?,?,...)` clause either way.
function buildInClause(column, value, sql, binds) {
  if (!value) return sql;
  const values = String(value).split(',').map(v => v.trim()).filter(Boolean);
  if (!values.length) return sql;
  sql += ` AND ${column} IN (${values.map(() => '?').join(',')})`;
  binds.push(...values);
  return sql;
}

async function getLogs(db, {
  tool     = null,
  employee = null,
  type     = null,
  search   = null,
  limit    = 100,
  offset   = 0,
} = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];

  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  sql = buildInClause('employee', employee, sql, b);
  sql = buildInClause('type',     type,     sql, b);
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 100), offset);

  return (await db.prepare(sql).bind(...b).all()).results;
}

async function getLogsCount(db, {
  tool     = null,
  employee = null,
  type     = null,
  search   = null,
} = {}) {
  let sql = "SELECT COUNT(*) as total FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];

  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  sql = buildInClause('employee', employee, sql, b);
  sql = buildInClause('type',     type,     sql, b);
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }

  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

async function getLogsExport(db, {
  tool     = null,
  employee = null,
  type     = null,
  search   = null,
} = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];

  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  sql = buildInClause('employee', employee, sql, b);
  sql = buildInClause('type',     type,     sql, b);
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 2000';

  return (await db.prepare(sql).bind(...b).all()).results;
}

// ══════════════════════════════════════════════════════════════
// END SHARED BLOCK
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §TEST-RECEIVE — self-test webhook receiver (webhook-receivers.md rules)
// Route: POST /test-receive — no login, no WORKER_SECRET (Shopify doesn't
// send it), HMAC via CLIENT_SECRET instead. 401 only for HMAC; everything
// else that got past HMAC is 200 + a D1 row, never 500 (repeated non-2xx
// makes Shopify silently delete the subscription).
// ══════════════════════════════════════════════════════════════
// ─── §HELPERS::restTopicToGraphQLTopic ───
// X-Shopify-Topic always arrives REST-style ("products/update") regardless
// of how the subscription was created. webhook_registry.topic stores the
// GraphQL enum form ("PRODUCTS_UPDATE") passed to webhookSubscriptionCreate.
// Without this conversion the registry lookup in handleTestReceive never
// matches — enrichment silently never fires, no error anywhere.
function restTopicToGraphQLTopic(restTopic) {
  return String(restTopic || '').toUpperCase().replace(/\//g, '_');
}

async function handleTestReceive(request, env, ctx) {
  const rawBody   = await request.text();               // raw bytes first — always
  const hmacHdr   = request.headers.get('X-Shopify-Hmac-Sha256');
  const topic     = request.headers.get('X-Shopify-Topic') || 'unknown';
  const webhookId = request.headers.get('X-Shopify-Webhook-Id') || request.headers.get('X-Shopify-Event-Id') || null;
  const shopDomain= request.headers.get('X-Shopify-Shop-Domain') || null;
  const apiVersion= request.headers.get('X-Shopify-Api-Version') || null;
  const selfOrigin= new URL(request.url).origin;

  const valid = await verifyShopifyHmac(env.CLIENT_SECRET, rawBody, hmacHdr);

  const insert = (hmacValid, enrichedJson) => env.DB.prepare(`
    INSERT INTO test_received_webhooks
      (received_at, topic, webhook_id, shop_domain, api_version, hmac_valid, payload_json, enriched_metafields_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(new Date().toISOString(), topic, webhookId, shopDomain, apiVersion, hmacValid ? 1 : 0, rawBody, enrichedJson).run();

  if (!valid) {
    ctx.waitUntil(insert(false, null).catch(() => {}));
    return new Response('Invalid signature', { status: 401 });
  }

  // Enrichment is best-effort — a failure here must never affect the 200
  // response or block the receive from being logged.
  ctx.waitUntil((async () => {
    let enrichedJson = null;
    try {
      const reg = await env.DB.prepare(
        "SELECT metafields_json, metafield_fetch_fields FROM webhook_registry WHERE status='active' AND uri = ? AND topic = ? LIMIT 1"
      ).bind(`${selfOrigin}/test-receive`, restTopicToGraphQLTopic(topic)).first();

      if (reg?.metafields_json) {
        const metafieldPairs = JSON.parse(reg.metafields_json);
        if (Array.isArray(metafieldPairs) && metafieldPairs.length) {
          const fetchFields = reg.metafield_fetch_fields ? JSON.parse(reg.metafield_fetch_fields) : DEFAULT_METAFIELD_FETCH_FIELDS;
          const payload = JSON.parse(rawBody);
          const token = await getAccessToken(env);
          const enrichment = await fetchMetafieldEnrichment(env, token, payload, metafieldPairs, fetchFields);
          if (enrichment) enrichedJson = JSON.stringify(enrichment);
        }
      }
    } catch (e) { /* best-effort — swallow, the raw payload is still saved below */ }

    await insert(true, enrichedJson).catch(() => {});
  })());

  return new Response(JSON.stringify({ ok: true, received: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// ══════════════════════════════════════════════════════════════
// §SHOPIFY — OAuth + GraphQL helpers
// ══════════════════════════════════════════════════════════════
async function getAccessToken(env) {
  const shopDomain = env.SHOP_DOMAIN.replace(/\/$/, '');
  const resp = await fetch(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        grant_type:    'client_credentials',
      }),
    }
  );
  if (!resp.ok) throw new Error(`OAuth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in response');
  return data.access_token;
}

async function shopifyGQL(env, token, query, variables = {}) {
  const shopDomain = env.SHOP_DOMAIN.replace(/\/$/, '');
  const resp = await fetch(
    `https://${shopDomain}/admin/api/2026-01/graphql.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return resp.json();
}

// ─── §SHOPIFY::metafieldEnrichment ───
// Confirmed selectable fields on the Metafield object (shopify.dev/docs/api/
// admin-graphql/latest/objects/metafield) — allow-list, never pass through
// unvalidated field names from D1 into a GraphQL query string.
const METAFIELD_FETCHABLE_FIELDS = ['id', 'namespace', 'key', 'value', 'type', 'description', 'createdAt', 'updatedAt'];
const DEFAULT_METAFIELD_FETCH_FIELDS = ['namespace', 'key', 'value'];

// Direct follow-up query for metafield values, bypassing the unreliable
// (community-reported, not officially guaranteed) variant-metafield
// inclusion in webhook payloads. Reads product-level and each variant-level
// admin_graphql_api_id already present in the received payload, then fetches
// the configured namespace/key pairs fresh via the Node interface.
async function fetchMetafieldEnrichment(env, token, payload, metafieldPairs, fetchFields) {
  const fields = fetchFields.filter(f => METAFIELD_FETCHABLE_FIELDS.includes(f));
  const selection = (fields.length ? fields : DEFAULT_METAFIELD_FETCH_FIELDS).join(' ');

  const targets = [];
  if (payload?.admin_graphql_api_id) {
    targets.push({ id: payload.admin_graphql_api_id, kind: 'product', label: payload.title || null });
  }
  if (Array.isArray(payload?.variants)) {
    for (const v of payload.variants) {
      if (v?.admin_graphql_api_id) {
        targets.push({ id: v.admin_graphql_api_id, kind: 'variant', label: v.sku || v.title || null });
      }
    }
  }
  if (!targets.length) return null;

  const aliasBlocks = metafieldPairs.map((mf, i) =>
    `mf${i}: metafield(namespace: ${JSON.stringify(String(mf.namespace))}, key: ${JSON.stringify(String(mf.key))}) { ${selection} }`
  ).join('\n');

  const query = `
    query EnrichMetafields($ids: [ID!]!) {
      nodes(ids: $ids) {
        id
        ... on Product { ${aliasBlocks} }
        ... on ProductVariant { ${aliasBlocks} }
      }
    }`;

  const resp = await shopifyGQL(env, token, query, { ids: targets.map(t => t.id) });
  const nodes = resp?.data?.nodes || [];

  return targets.map(t => {
    const node = nodes.find(n => n?.id === t.id) || {};
    const metafields = metafieldPairs.map((mf, i) => ({
      namespace: mf.namespace,
      key: mf.key,
      ...(node[`mf${i}`] || { found: false }),
    }));
    return { id: t.id, kind: t.kind, label: t.label, metafields };
  });
}

// ─── §SHOPIFY::fetchAllSubscriptions ───
// Pages through webhookSubscriptions(first:50). Ownership trap applies:
// only returns subscriptions created by THIS OAuth client (CLIENT_ID).
async function fetchAllSubscriptions(env, token) {
  const query = `
    query GetAllWebhookSubscriptions($cursor: String) {
      webhookSubscriptions(first: 50, after: $cursor) {
        edges {
          node {
            id
            legacyResourceId
            topic
            format
            uri
            filter
            includeFields
            metafieldNamespaces
            metafields { namespace key }
            apiVersion { handle }
            createdAt
            updatedAt
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  let all = [];
  let cursor = null;
  do {
    const resp = await shopifyGQL(env, token, query, { cursor });
    const conn = resp?.data?.webhookSubscriptions;
    if (!conn) break;
    all = all.concat(conn.edges.map(e => e.node));
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

// ─── §SHOPIFY::TOPICS_REFERENCE ───
// Common topics — NOT the full Shopify enum. Free-text topic input is also
// accepted; an invalid name comes back from Shopify with every valid value
// listed in the error, surfaced as-is to the caller.
const TOPICS_REFERENCE = [
  { topic: 'ORDERS_CREATE',          event: 'orders/create',          scope: 'read_orders' },
  { topic: 'ORDERS_UPDATED',         event: 'orders/updated',         scope: 'read_orders' },
  { topic: 'ORDERS_CANCELLED',       event: 'orders/cancelled',       scope: 'read_orders' },
  { topic: 'ORDERS_FULFILLED',       event: 'orders/fulfilled',       scope: 'read_orders' },
  { topic: 'ORDERS_PARTIALLY_FULFILLED', event: 'orders/partially_fulfilled', scope: 'read_orders' },
  { topic: 'DRAFT_ORDERS_CREATE',    event: 'draft_orders/create',    scope: 'read_draft_orders' },
  { topic: 'DRAFT_ORDERS_UPDATE',    event: 'draft_orders/update',    scope: 'read_draft_orders' },
  { topic: 'DRAFT_ORDERS_DELETE',    event: 'draft_orders/delete',    scope: 'read_draft_orders' },
  { topic: 'PRODUCTS_CREATE',        event: 'products/create',        scope: 'read_products' },
  { topic: 'PRODUCTS_UPDATE',        event: 'products/update',        scope: 'read_products' },
  { topic: 'PRODUCTS_DELETE',        event: 'products/delete',        scope: 'read_products' },
  { topic: 'INVENTORY_LEVELS_UPDATE',event: 'inventory_levels/update',scope: 'read_inventory' },
  { topic: 'FULFILLMENTS_CREATE',    event: 'fulfillments/create',    scope: 'read_fulfillments' },
  { topic: 'FULFILLMENTS_UPDATE',    event: 'fulfillments/update',    scope: 'read_fulfillments' },
  { topic: 'REFUNDS_CREATE',         event: 'refunds/create',         scope: 'read_orders' },
  { topic: 'CUSTOMERS_CREATE',       event: 'customers/create',       scope: 'read_customers' },
  { topic: 'CUSTOMERS_UPDATE',       event: 'customers/update',       scope: 'read_customers' },
  { topic: 'APP_UNINSTALLED',        event: 'app/uninstalled',        scope: '(mandatory compliance topic)' },
];

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── Webhook receiver route — BEFORE the WORKER_SECRET gate ───
    // Shopify never sends Authorization: Bearer, so this must be checked
    // first or every test delivery 401s before HMAC is even looked at.
    if (url.pathname === '/test-receive' && request.method === 'POST') {
      return handleTestReceive(request, env, ctx);
    }

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: getCORS(request),
      });

    const action = url.searchParams.get('action') || '';

    try {

      // ─── §AUTH ────────────────────────────────────────────────────

      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

        await writeLog(env.DB, {
          tool:     TOOL_NAME,
          type:     'login',
          employee: username,
          notes:    `دخول: ${displayName}`,
        });
        return json({ ok: true, displayName }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        if (username) {
          await writeLog(env.DB, {
            tool:     TOOL_NAME,
            type:     'logout',
            employee: username,
            notes:    `خروج: ${username.replace(/_/g, ' ')}`,
          });
        }
        return json({ ok: true }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }

      // ────────────────────────────────────────────────────────────

      // ─── §WEBHOOKS — management (create/list/update/delete + reconcile) ──
      // §WEBHOOKS::listSubscriptions

      if (action === 'list_subscriptions') {
        const token = await getAccessToken(env);
        const live  = await fetchAllSubscriptions(env, token);

        const { results: registryRows } = await env.DB.prepare(
          "SELECT * FROM webhook_registry WHERE status != 'deleted_manually'"
        ).all();
        const byGid = Object.fromEntries(registryRows.map(r => [r.subscription_gid, r]));

        const liveSubs = live.map(node => {
          const reg = byGid[node.id];
          return {
            id:               node.id,
            legacyResourceId: node.legacyResourceId,
            topic:            node.topic,
            uri:              node.uri,
            filter:           node.filter,
            includeFields:    node.includeFields,
            metafields:       node.metafields,
            createdAt:        node.createdAt,
            updatedAt:        node.updatedAt,
            toolName:         reg?.tool_name || null,
            purpose:          reg?.purpose   || null,
            notes:            reg?.notes     || null,
            metafieldFetchFields: reg?.metafield_fetch_fields ? JSON.parse(reg.metafield_fetch_fields) : null,
            trackedLocally:   !!reg,
            registryStatus:   reg?.status || 'untracked',
            paused:           false,
          };
        });

        // §WEBHOOKS::pauseResume — paused subscriptions have no live Shopify
        // object (deleted on purpose at pause time) so fetchAllSubscriptions
        // never returns them; they only exist in this registry.
        const pausedSubs = registryRows.filter(r => r.status === 'paused').map(r => ({
          id:               r.subscription_gid,
          legacyResourceId: null,
          topic:            r.topic,
          uri:              r.uri,
          filter:           r.filter,
          includeFields:    r.include_fields_json ? JSON.parse(r.include_fields_json) : null,
          metafields:       r.metafields_json ? JSON.parse(r.metafields_json) : null,
          createdAt:        r.created_at,
          updatedAt:        r.last_verified_at,
          toolName:         r.tool_name || null,
          purpose:          r.purpose   || null,
          notes:            r.notes     || null,
          metafieldFetchFields: r.metafield_fetch_fields ? JSON.parse(r.metafield_fetch_fields) : null,
          trackedLocally:   true,
          registryStatus:   'paused',
          paused:           true,
        }));

        return json({ ok: true, subscriptions: [...liveSubs, ...pausedSubs] }, 200, request);
      }

      // §WEBHOOKS::getTopicsReference
      if (action === 'get_topics_reference') {
        return json({
          ok: true,
          topics: TOPICS_REFERENCE,
          note: 'قائمة مرجعية لأشهر الـ topics — مش كل القائمة الكاملة. أي topic تاني تقدر تكتبه يدوي؛ لو الاسم غلط شوبيفاي هيرجع رسالة فيها كل الأسماء الصحيحة.',
        }, 200, request);
      }

      // §WEBHOOKS::getKnownToolNames
      // Distinct tool values already writing to the shared logs table, plus
      // this tool's own TOOL_NAME (so it always offers itself for the
      // self-test quick-create option even before it has logged anything).
      if (action === 'get_known_tool_names') {
        const { results } = await env.DB.prepare('SELECT DISTINCT tool FROM logs ORDER BY tool').all();
        const names = new Set(results.map(r => r.tool));
        names.add(TOOL_NAME);
        return json({ ok: true, toolNames: [...names].sort() }, 200, request);
      }

      // §WEBHOOKS::createSubscription
      if (action === 'create_subscription') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const body = await request.json().catch(() => ({}));
        const { topic, uri, format, metafields, filter, includeFields, toolName, purpose, notes, employee, metafieldFetchFields } = body;

        if (!topic || !uri) return json({ ok: false, error: 'topic و uri مطلوبان' }, 400, request);

        const token = await getAccessToken(env);
        const sub = { uri, format: format || 'JSON' };
        if (Array.isArray(metafields) && metafields.length)       sub.metafields    = metafields;
        if (filter)                                                sub.filter        = filter;
        if (Array.isArray(includeFields) && includeFields.length) sub.includeFields = includeFields;

        const mutation = `
          mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
              webhookSubscription { id topic uri }
              userErrors { field message }
            }
          }`;
        const resp = await shopifyGQL(env, token, mutation, { topic, sub });

        if (resp.errors) {
          return json({ ok: false, error: resp.errors[0]?.message || 'GraphQL error', graphqlErrors: resp.errors }, 400, request);
        }
        const result = resp?.data?.webhookSubscriptionCreate;
        if (result?.userErrors?.length) {
          return json({ ok: false, error: result.userErrors.map(e => e.message).join(' / '), userErrors: result.userErrors }, 400, request);
        }
        const created = result?.webhookSubscription;
        if (!created?.id) return json({ ok: false, error: 'فشل الإنشاء بدون سبب واضح من شوبيفاي' }, 500, request);

        const now = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO webhook_registry
            (subscription_gid, topic, uri, tool_name, purpose, metafields_json, filter, include_fields_json, metafield_fetch_fields, status, created_by, created_at, last_verified_at, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `).bind(
          created.id, topic, uri, toolName || null, purpose || null,
          metafields ? JSON.stringify(metafields) : null,
          filter || null,
          includeFields ? JSON.stringify(includeFields) : null,
          Array.isArray(metafieldFetchFields) && metafieldFetchFields.length ? JSON.stringify(metafieldFetchFields) : null,
          employee || null, now, now, notes || null
        ).run();

        await writeLog(env.DB, {
          tool: TOOL_NAME, type: 'create', employee: employee || null,
          notes: `إنشاء webhook: ${topic} → ${uri}`,
          extra: { subscriptionGid: created.id, toolName },
        });

        return json({ ok: true, subscription: created }, 200, request);
      }

      // §WEBHOOKS::updateSubscription
      if (action === 'update_subscription') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const body = await request.json().catch(() => ({}));
        const { subscriptionGid, uri, filter, includeFields, metafields, toolName, purpose, notes, employee, metafieldFetchFields } = body;
        if (!subscriptionGid) return json({ ok: false, error: 'subscriptionGid مطلوب' }, 400, request);

        const shopifyFieldsPresent = uri !== undefined || filter !== undefined || includeFields !== undefined || metafields !== undefined;

        if (shopifyFieldsPresent) {
          const token = await getAccessToken(env);
          const sub = {};
          if (uri !== undefined)           sub.uri           = uri;
          if (filter !== undefined)        sub.filter        = filter;
          if (includeFields !== undefined) sub.includeFields = includeFields;
          if (metafields !== undefined)    sub.metafields    = metafields;

          const mutation = `
            mutation UpdateWebhook($id: ID!, $sub: WebhookSubscriptionInput!) {
              webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
                webhookSubscription { id uri }
                userErrors { field message }
              }
            }`;
          const resp = await shopifyGQL(env, token, mutation, { id: subscriptionGid, sub });
          if (resp.errors) return json({ ok: false, error: resp.errors[0]?.message || 'GraphQL error' }, 400, request);
          const result = resp?.data?.webhookSubscriptionUpdate;
          if (result?.userErrors?.length) return json({ ok: false, error: result.userErrors.map(e => e.message).join(' / ') }, 400, request);
        }

        const sets = [];
        const binds = [];
        if (uri !== undefined)           { sets.push('uri = ?');                  binds.push(uri); }
        if (filter !== undefined)        { sets.push('filter = ?');               binds.push(filter); }
        if (includeFields !== undefined) { sets.push('include_fields_json = ?');  binds.push(JSON.stringify(includeFields)); }
        if (metafields !== undefined)    { sets.push('metafields_json = ?');      binds.push(JSON.stringify(metafields)); }
        if (metafieldFetchFields !== undefined) { sets.push('metafield_fetch_fields = ?'); binds.push(Array.isArray(metafieldFetchFields) && metafieldFetchFields.length ? JSON.stringify(metafieldFetchFields) : null); }
        if (toolName !== undefined)      { sets.push('tool_name = ?');            binds.push(toolName); }
        if (purpose !== undefined)       { sets.push('purpose = ?');              binds.push(purpose); }
        if (notes !== undefined)         { sets.push('notes = ?');                binds.push(notes); }

        if (sets.length) {
          binds.push(subscriptionGid);
          await env.DB.prepare(`UPDATE webhook_registry SET ${sets.join(', ')} WHERE subscription_gid = ?`).bind(...binds).run();
        }

        await writeLog(env.DB, { tool: TOOL_NAME, type: 'update', employee: employee || null, notes: `تعديل webhook: ${subscriptionGid}` });
        return json({ ok: true }, 200, request);
      }

      // §WEBHOOKS::deleteSubscription
      if (action === 'delete_subscription') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { subscriptionGid, employee } = await request.json().catch(() => ({}));
        if (!subscriptionGid) return json({ ok: false, error: 'subscriptionGid مطلوب' }, 400, request);

        const token = await getAccessToken(env);
        const mutation = `
          mutation DeleteWebhook($id: ID!) {
            webhookSubscriptionDelete(id: $id) {
              deletedWebhookSubscriptionId
              userErrors { field message }
            }
          }`;
        const resp = await shopifyGQL(env, token, mutation, { id: subscriptionGid });
        if (resp.errors) return json({ ok: false, error: resp.errors[0]?.message || 'GraphQL error' }, 400, request);
        const result = resp?.data?.webhookSubscriptionDelete;
        if (result?.userErrors?.length) return json({ ok: false, error: result.userErrors.map(e => e.message).join(' / ') }, 400, request);

        await env.DB.prepare("UPDATE webhook_registry SET status = 'deleted_manually', last_verified_at = ? WHERE subscription_gid = ?")
          .bind(new Date().toISOString(), subscriptionGid).run();

        await writeLog(env.DB, { tool: TOOL_NAME, type: 'delete', employee: employee || null, notes: `حذف webhook: ${subscriptionGid}` });
        return json({ ok: true }, 200, request);
      }

      // §WEBHOOKS::pauseSubscription
      // شوبيفاي مالوش mutation لتعليق اشتراك مؤقتًا — "الإيقاف" هنا معناه حذف
      // الاشتراك الحي من شوبيفاي فعليًا (بتتوقف الاستقبالات فورًا) مع الاحتفاظ
      // الكامل بإعداداته (topic/uri/filter/includeFields/metafields) في نفس
      // صف webhook_registry بحالة 'paused' — عشان resume_subscription يقدر
      // يعيد إنشاءه من غير إعادة كتابة أي حاجة.
      if (action === 'pause_subscription') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { subscriptionGid, employee } = await request.json().catch(() => ({}));
        if (!subscriptionGid) return json({ ok: false, error: 'subscriptionGid مطلوب' }, 400, request);

        const token = await getAccessToken(env);
        const mutation = `
          mutation DeleteWebhook($id: ID!) {
            webhookSubscriptionDelete(id: $id) {
              deletedWebhookSubscriptionId
              userErrors { field message }
            }
          }`;
        const resp = await shopifyGQL(env, token, mutation, { id: subscriptionGid });
        if (resp.errors) return json({ ok: false, error: resp.errors[0]?.message || 'GraphQL error' }, 400, request);
        const result = resp?.data?.webhookSubscriptionDelete;
        if (result?.userErrors?.length) return json({ ok: false, error: result.userErrors.map(e => e.message).join(' / ') }, 400, request);

        await env.DB.prepare("UPDATE webhook_registry SET status = 'paused', last_verified_at = ? WHERE subscription_gid = ?")
          .bind(new Date().toISOString(), subscriptionGid).run();

        await writeLog(env.DB, { tool: TOOL_NAME, type: 'pause', employee: employee || null, notes: `إيقاف مؤقت لـ webhook: ${subscriptionGid}` });
        return json({ ok: true }, 200, request);
      }

      // §WEBHOOKS::resumeSubscription
      // بيعيد إنشاء الاشتراك من الإعدادات المحفوظة وقت الإيقاف. شوبيفاي بيدي
      // subscription id جديد كل مرة — صف webhook_registry بتاع نفس الأداة
      // بيتحدّث في مكانه (subscription_gid الجديد) بدل ما يتعمل صف جديد،
      // عشان الأرشفة والملاحظات المحلية (tool_name/purpose/notes) تفضل واحدة.
      if (action === 'resume_subscription') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { subscriptionGid, employee } = await request.json().catch(() => ({}));
        if (!subscriptionGid) return json({ ok: false, error: 'subscriptionGid مطلوب' }, 400, request);

        const reg = await env.DB.prepare(
          "SELECT * FROM webhook_registry WHERE subscription_gid = ? AND status = 'paused'"
        ).bind(subscriptionGid).first();
        if (!reg) return json({ ok: false, error: 'الاشتراك ده مش موقوف مؤقتًا أو مش موجود' }, 404, request);

        const token = await getAccessToken(env);
        const sub = { uri: reg.uri, format: 'JSON' };
        if (reg.metafields_json)     sub.metafields    = JSON.parse(reg.metafields_json);
        if (reg.filter)              sub.filter        = reg.filter;
        if (reg.include_fields_json) sub.includeFields = JSON.parse(reg.include_fields_json);

        const mutation = `
          mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
              webhookSubscription { id topic uri }
              userErrors { field message }
            }
          }`;
        const resp = await shopifyGQL(env, token, mutation, { topic: reg.topic, sub });
        if (resp.errors) return json({ ok: false, error: resp.errors[0]?.message || 'GraphQL error' }, 400, request);
        const result = resp?.data?.webhookSubscriptionCreate;
        if (result?.userErrors?.length) return json({ ok: false, error: result.userErrors.map(e => e.message).join(' / ') }, 400, request);
        const created = result?.webhookSubscription;
        if (!created?.id) return json({ ok: false, error: 'فشل الاستئناف بدون سبب واضح من شوبيفاي' }, 500, request);

        const now = new Date().toISOString();
        await env.DB.prepare("UPDATE webhook_registry SET subscription_gid = ?, status = 'active', created_at = ?, last_verified_at = ? WHERE subscription_gid = ?")
          .bind(created.id, now, now, subscriptionGid).run();

        await writeLog(env.DB, {
          tool: TOOL_NAME, type: 'resume', employee: employee || null,
          notes: `استئناف webhook: ${reg.topic} → ${reg.uri}`,
          extra: { oldGid: subscriptionGid, newGid: created.id },
        });
        return json({ ok: true, subscription: created }, 200, request);
      }

      // §WEBHOOKS::deletePausedSubscription
      // حذف نهائي لصف موقوف مؤقتًا — D1 فقط، من غير أي نداء لشوبيفاي، لأن
      // الاشتراك أصلاً اتحذف من هناك وقت الإيقاف (pause_subscription).
      if (action === 'delete_paused_subscription') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { subscriptionGid, employee } = await request.json().catch(() => ({}));
        if (!subscriptionGid) return json({ ok: false, error: 'subscriptionGid مطلوب' }, 400, request);

        const reg = await env.DB.prepare(
          "SELECT topic FROM webhook_registry WHERE subscription_gid = ? AND status = 'paused'"
        ).bind(subscriptionGid).first();
        if (!reg) return json({ ok: false, error: 'الاشتراك ده مش موقوف مؤقتًا أو مش موجود' }, 404, request);

        await env.DB.prepare("UPDATE webhook_registry SET status = 'deleted_manually', last_verified_at = ? WHERE subscription_gid = ?")
          .bind(new Date().toISOString(), subscriptionGid).run();

        await writeLog(env.DB, { tool: TOOL_NAME, type: 'delete', employee: employee || null, notes: `حذف نهائي لـ webhook موقوف: ${reg.topic}` });
        return json({ ok: true }, 200, request);
      }

      // §WEBHOOKS::reconcileSubscriptions
      // المصدر الوحيد الموثوق لمعرفة إن شوبيفاي مسح subscription بصمت (بعد
      // فشل متكرر) — مفيش أي API بيرجع delivery history. المقارنة هنا حية.
      if (action === 'reconcile_subscriptions') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { employee } = await request.json().catch(() => ({}));

        const token = await getAccessToken(env);
        const live  = await fetchAllSubscriptions(env, token);
        const liveIds = new Set(live.map(n => n.id));

        const { results: activeRows } = await env.DB.prepare(
          "SELECT subscription_gid FROM webhook_registry WHERE status = 'active'"
        ).all();

        const now = new Date().toISOString();
        let removedCount = 0;
        for (const row of activeRows) {
          if (!liveIds.has(row.subscription_gid)) {
            await env.DB.prepare("UPDATE webhook_registry SET status = 'removed_by_shopify', last_verified_at = ? WHERE subscription_gid = ?")
              .bind(now, row.subscription_gid).run();
            removedCount++;
          } else {
            await env.DB.prepare("UPDATE webhook_registry SET last_verified_at = ? WHERE subscription_gid = ?")
              .bind(now, row.subscription_gid).run();
          }
        }

        const { results: registryRows } = await env.DB.prepare('SELECT subscription_gid FROM webhook_registry').all();
        const registeredIds = new Set(registryRows.map(r => r.subscription_gid));
        const untracked = live
          .filter(n => !registeredIds.has(n.id))
          .map(n => ({ id: n.id, topic: n.topic, uri: n.uri, createdAt: n.createdAt }));

        await writeLog(env.DB, {
          tool: TOOL_NAME, type: 'reconcile', employee: employee || null,
          notes: removedCount > 0
            ? `Reconcile: ${removedCount} subscription اتشالوا من شوبيفاي`
            : 'Reconcile: كل الاشتراكات النشطة موجودة',
          extra: { removedCount, untrackedCount: untracked.length },
        });

        return json({ ok: true, removedCount, untracked, checkedAt: now }, 200, request);
      }

      // §WEBHOOKS::getMonitoringSummary
      // بيقرا من جدول logs المشترك (نفس D1 لكل الأدوات) — activity لكل
      // tool_name مسجّل، وfailed_24h بيعتمد على convention type:'failed'
      // الموجودة أصلاً في webhook-receivers.md لأي Worker مستقبِل.
      if (action === 'get_monitoring_summary') {
        const { results: activeRegistry } = await env.DB.prepare(
          "SELECT tool_name FROM webhook_registry WHERE status='active' AND tool_name IS NOT NULL AND tool_name != ''"
        ).all();
        const tools = [...new Set(activeRegistry.map(r => r.tool_name))];

        let activity = [];
        if (tools.length) {
          const placeholders = tools.map(() => '?').join(',');
          const sql = `
            SELECT tool,
                   MAX(timestamp) as last_activity,
                   SUM(CASE WHEN type = 'failed' AND timestamp >= datetime('now','-1 day') THEN 1 ELSE 0 END) as failed_24h,
                   COUNT(*) as total_rows
            FROM logs
            WHERE tool IN (${placeholders})
            GROUP BY tool`;
          const r = await env.DB.prepare(sql).bind(...tools).all();
          const byTool = Object.fromEntries(r.results.map(x => [x.tool, x]));
          activity = tools.map(t => byTool[t] || { tool: t, last_activity: null, failed_24h: 0, total_rows: 0 });
        }

        const { results: removed } = await env.DB.prepare(
          "SELECT subscription_gid, topic, uri, tool_name, last_verified_at FROM webhook_registry WHERE status='removed_by_shopify' ORDER BY last_verified_at DESC LIMIT 50"
        ).all();

        const activeCountRow   = await env.DB.prepare("SELECT COUNT(*) as cnt FROM webhook_registry WHERE status='active'").first();
        const lastReconcileRow = await env.DB.prepare('SELECT MAX(last_verified_at) as t FROM webhook_registry').first();

        return json({
          ok: true,
          activity,
          removedByShopify: removed,
          activeCount: activeCountRow?.cnt ?? 0,
          lastReconcileAt: lastReconcileRow?.t ?? null,
        }, 200, request);
      }

      // ────────────────────────────────────────────────────────────

      // ─── §TEST-RECEIVE — browser-facing endpoints for the viewer tab ──
      // §TEST-RECEIVE::getTestReceived
      if (action === 'get_test_received') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        const { results } = await env.DB.prepare(
          'SELECT id, received_at, topic, webhook_id, shop_domain, api_version, hmac_valid, payload_json, enriched_metafields_json FROM test_received_webhooks ORDER BY received_at DESC LIMIT ?'
        ).bind(limit).all();
        return json({ ok: true, entries: results }, 200, request);
      }
      // §TEST-RECEIVE::clearTestReceived
      if (action === 'clear_test_received') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        await env.DB.prepare('DELETE FROM test_received_webhooks').run();
        return json({ ok: true }, 200, request);
      }
      // ────────────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ───────────────────────────────────────────
      if (action === 'get_logs') {
        const entries = await getLogs(env.DB, {
          tool:     url.searchParams.get('tool')     || TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          type:     url.searchParams.get('type')     || null,
          search:   url.searchParams.get('search')   || null,
          limit:    parseInt(url.searchParams.get('limit')  || '100'),
          offset:   parseInt(url.searchParams.get('offset') || '0'),
        });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, {
          tool:     url.searchParams.get('tool')     || TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          type:     url.searchParams.get('type')     || null,
          search:   url.searchParams.get('search')   || null,
        });
        return json({ ok: true, total }, 200, request);
      }

      if (action === 'get_logs_export') {
        const entries = await getLogsExport(env.DB, {
          tool:     url.searchParams.get('tool')     || TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          type:     url.searchParams.get('type')     || null,
          search:   url.searchParams.get('search')   || null,
        });
        return json({ ok: true, entries }, 200, request);
      }
      // ────────────────────────────────────────────────────────────

      return json({ error: 'Unknown action' }, 404, request);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500, request);
    }
  },
};
