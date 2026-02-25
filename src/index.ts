import { Hono } from 'hono';

const app = new Hono<{ Bindings: { ORDERS: D1Database } }>();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  return next();
});

type Addon = {
  id: string;
  name: string;
  price: number; // cents
};

type Meal = {
  id: string;
  name: string;
  description?: string;
  price: number; // cents
  imageUrl?: string;
  tags?: string[];
  addons: Addon[];
  isAvailable: boolean;
};

type Unit = {
  id: string;
  status: 'pending' | 'preparing' | 'ready';
  line_id?: string;
};

type OrderLine = {
  id: string;
  mealId: string;
  name: string;
  unitPrice: number; // cents
  quantity: number;
  addons: Addon[];
  units: Unit[];
};

type Order = {
  id: string;
  createdAt: number;
  lockedAt: number;
  expiresAt: number;
  status: 'pending' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  subtotal: number;
  tax: number;
  total: number;
  items: OrderLine[];
};

const HOURS = (h: number) => h * 60 * 60 * 1000;

async function fetchMenuAddonsMap(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT id, menu_item_id, name, price_delta, is_required, max_select FROM menu_addons`
    )
    .all();
  const map = new Map<string, any[]>();
  for (const r of (result.results || []) as any[]) {
    const mid = r.menu_item_id;
    if (!map.has(mid)) map.set(mid, []);
    map.get(mid)!.push({
      id: r.id,
      name: r.name,
      price: r.price_delta,
      is_required: !!r.is_required,
      max_select: r.max_select,
    });
  }
  return map;
}

app.get('/api', async (c) => c.json({ status: 'alive' }));

app.get('/api/menu', async (c) => {
  const db = c.env.ORDERS;
  const mealsRes = await db
    .prepare(`SELECT id, name, description, price, image_url, is_featured, is_available, created_at FROM menu_items WHERE is_available = 1`)
    .all();

  const addonsRes = await db
    .prepare(`SELECT id, menu_item_id, name, price_delta, is_required, max_select FROM menu_addons`)
    .all();

  const addonMap = new Map<string, any[]>();
  for (const a of (addonsRes.results || []) as any[]) {
    const k = a.menu_item_id;
    if (!addonMap.has(k)) addonMap.set(k, []);
    addonMap.get(k)!.push({
      id: a.id,
      name: a.name,
      price: a.price_delta,
      is_required: !!a.is_required,
      max_select: a.max_select,
    });
  }

  const payload: Meal[] = (mealsRes.results || []).map((m: any) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    price: m.price,
    imageUrl: m.image_url,
    tags: [],
    addons: addonMap.get(m.id) || [],
    isAvailable: !!m.is_available,
  }));

  return c.json(payload);
});

app.post('/api/menu', async (c) => {
  const db = c.env.ORDERS;
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  await db
    .prepare(
      `INSERT INTO menu_items (id, name, description, price, image_url, is_featured, is_available, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      body.name || '',
      body.description || null,
      body.price || 0,
      body.imageUrl || null,
      body.isFeatured ? 1 : 0,
      body.isAvailable === undefined ? 1 : body.isAvailable ? 1 : 0,
      createdAt
    )
    .run();

  if (Array.isArray(body.addons)) {
    for (const a of body.addons) {
      const aid = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO menu_addons (id, menu_item_id, name, price_delta, is_required, max_select, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(aid, id, a.name || '', a.price_delta || 0, a.is_required ? 1 : 0, a.max_select || 1, createdAt)
        .run();
    }
  }

  return c.json({ id }, 201);
});

app.patch('/api/menu/:id', async (c) => {
  const db = c.env.ORDERS;
  const id = c.req.param('id');
  const body = await c.req.json();

  await db
    .prepare(
      `UPDATE menu_items SET name = COALESCE(?, name),
                               description = COALESCE(?, description),
                               price = COALESCE(?, price),
                               image_url = COALESCE(?, image_url),
                               is_featured = COALESCE(?, is_featured),
                               is_available = COALESCE(?, is_available)
       WHERE id = ?`
    )
    .bind(
      body.name ?? null,
      body.description ?? null,
      body.price ?? null,
      body.imageUrl ?? null,
      body.isFeatured === undefined ? null : body.isFeatured ? 1 : 0,
      body.isAvailable === undefined ? null : body.isAvailable ? 1 : 0,
      id
    )
    .run();

  if (Array.isArray(body.addons)) {
    await db.prepare(`DELETE FROM menu_addons WHERE menu_item_id = ?`).bind(id).run();
    const createdAt = Date.now();
    for (const a of body.addons) {
      const aid = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO menu_addons (id, menu_item_id, name, price_delta, is_required, max_select, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(aid, id, a.name || '', a.price_delta || 0, a.is_required ? 1 : 0, a.max_select || 1, createdAt)
        .run();
    }
  }

  return c.json({ success: true });
});

app.delete('/api/menu/:id', async (c) => {
  const db = c.env.ORDERS;
  const id = c.req.param('id');

  await db.prepare(`UPDATE menu_items SET is_available = 0 WHERE id = ?`).bind(id).run();

  return c.json({ success: true });
});


app.get('/api/orders', async (c) => {
  const db = c.env.ORDERS;
  const active = c.req.query('active');

  if (active === 'true') {
    const now = Date.now();
    const res = await db
      .prepare(`SELECT * FROM orders WHERE status != 'completed' AND expires_at > ? ORDER BY created_at DESC`)
      .bind(now)
      .all();
    return c.json(res.results || []);
  } else {
    const res = await db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all();
    return c.json(res.results || []);
  }
});

app.post('/api/orders', async (c) => {
  const db = c.env.ORDERS;
  const body = await c.req.json();

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'items required' }, 400);
  }

  const mealsRes = await db.prepare(`SELECT id, name, price FROM menu_items WHERE id IN (${body.items.map(()=>'?').join(',')})`).bind(...body.items.map((i:any)=>i.mealId)).all().catch(()=>({ results: [] }));

  const mealsMap = new Map<string, any>();
  if (mealsRes && Array.isArray(mealsRes.results) && mealsRes.results.length > 0) {
    for (const m of mealsRes.results as any[]) mealsMap.set(m.id, m);
  } else {
    for (const it of body.items) {
      const r = await db.prepare(`SELECT id, name, price FROM menu_items WHERE id = ?`).bind(it.mealId).first() as any;
      if (r) mealsMap.set(r.id, r);
    }
  }

  const allAddonIds: string[] = [];
  for (const it of body.items) {
    if (Array.isArray(it.addons)) {
      for (const aid of it.addons) allAddonIds.push(aid);
    }
  }

  const addonsMap = new Map<string, any>();
  if (allAddonIds.length > 0) {
    const placeholders = allAddonIds.map(()=>'?').join(',');
    const addonsRes = await db.prepare(`SELECT id, menu_item_id, name, price_delta FROM menu_addons WHERE id IN (${placeholders})`).bind(...allAddonIds).all();
    for (const a of (addonsRes.results || []) as any[]) addonsMap.set(a.id, a);
  }

  const orderId = crypto.randomUUID();
  const createdAt = Date.now();
  const lockedAt = createdAt + HOURS(4); // read-only after 4 hours
  const expiresAt = createdAt + HOURS(24); // expire after 24 hours

  let subtotal = 0;

  await db
    .prepare(
      `INSERT INTO orders (id, created_at, locked_at, expires_at, status, subtotal, tax, total)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .bind(orderId, createdAt, lockedAt, expiresAt, 0, 0, 0)// temporary zeros for totals
    .run();

  for (const it of body.items) {
    const meal = mealsMap.get(it.mealId);
    if (!meal) {
      await db.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run();
      return c.json({ error: `meal not found: ${it.mealId}` }, 400);
    }

    const basePrice = meal.price || 0;
    const addonSnapshots: Addon[] = [];
    let addonsTotalDelta = 0;

    if (Array.isArray(it.addons)) {
      for (const aid of it.addons) {
        const a = addonsMap.get(aid);
        if (!a) {
          await db.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run();
          return c.json({ error: `addon not found: ${aid}` }, 400);
        }
        if (a.menu_item_id !== meal.id) {
          await db.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run();
          return c.json({ error: `addon ${aid} does not belong to meal ${meal.id}` }, 400);
        }
        addonSnapshots.push({ id: a.id, name: a.name, price: a.price_delta });
        addonsTotalDelta += a.price_delta;
      }
    }

    const unitPriceSnapshot = (basePrice || 0) + addonsTotalDelta;
    const qty = Number(it.quantity || 1);
    subtotal += unitPriceSnapshot * qty;

    const lineId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO order_lines (id, order_id, meal_id, name_snapshot, quantity, unit_price_snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(lineId, orderId, meal.id, meal.name, qty, unitPriceSnapshot)
      .run();

    for (const asnap of addonSnapshots) {
      const olaId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO order_line_addons (id, line_id, addon_id, name_snapshot, price_delta_snapshot)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(olaId, lineId, asnap.id, asnap.name, asnap.price)
        .run();
    }

    for (let i = 0; i < qty; i++) {
      await db
        .prepare(`INSERT INTO order_units (id, line_id, status) VALUES (?, ?, 'pending')`)
        .bind(crypto.randomUUID(), lineId)
        .run();
    }
  }

  const tax = body.tax ?? 0;
  const total = subtotal + tax;

  await db
    .prepare(`UPDATE orders SET subtotal = ?, tax = ?, total = ? WHERE id = ?`)
    .bind(subtotal, tax, total, orderId)
    .run();

  return c.json({ id: orderId }, 201);
});

app.get('/api/orders/:id', async (c) => {
  const db = c.env.ORDERS;
  const id = c.req.param('id');

  const orderRow = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first() as any;
  if (!orderRow) return c.json({ error: 'Not found' }, 404);

  const linesRes = await db.prepare(`SELECT id, order_id, meal_id, name_snapshot, quantity, unit_price_snapshot FROM order_lines WHERE order_id = ?`).bind(id).all();
  const lines = (linesRes.results || []) as any[];

  const lineIds = lines.map(l => l.id);
  let addonsRes = { results: [] as any[] };
  let unitsRes = { results: [] as any[] };

  if (lineIds.length > 0) {
    const placeholders = lineIds.map(()=>'?').join(',');
    addonsRes = await db.prepare(`SELECT id, line_id, addon_id, name_snapshot, price_delta_snapshot FROM order_line_addons WHERE line_id IN (${placeholders})`).bind(...lineIds).all();
    unitsRes = await db.prepare(`SELECT id, line_id, status FROM order_units WHERE line_id IN (${placeholders})`).bind(...lineIds).all();
  }

  const addonsByLine = new Map<string, any[]>();
  for (const a of addonsRes.results as any[]) {
    if (!addonsByLine.has(a.line_id)) addonsByLine.set(a.line_id, []);
    addonsByLine.get(a.line_id)!.push({
      id: a.addon_id,
      name: a.name_snapshot,
      price: a.price_delta_snapshot
    });
  }

  const unitsByLine = new Map<string, any[]>();
  for (const u of unitsRes.results as any[]) {
    if (!unitsByLine.has(u.line_id)) unitsByLine.set(u.line_id, []);
    unitsByLine.get(u.line_id)!.push({
      id: u.id,
      status: u.status,
      line_id: u.line_id
    });
  }

  const items: OrderLine[] = lines.map(l => ({
    id: l.id,
    mealId: l.meal_id,
    name: l.name_snapshot,
    unitPrice: l.unit_price_snapshot,
    quantity: l.quantity,
    addons: addonsByLine.get(l.id) || [],
    units: unitsByLine.get(l.id) || []
  }));

  const resp: Order = {
    id: orderRow.id,
    createdAt: orderRow.created_at,
    lockedAt: orderRow.locked_at,
    expiresAt: orderRow.expires_at,
    status: orderRow.status,
    subtotal: orderRow.subtotal,
    tax: orderRow.tax,
    total: orderRow.total,
    items
  };

  return c.json(resp);
});

app.patch('/api/orders/:id', async (c) => {
  const db = c.env.ORDERS;
  const id = c.req.param('id');
  const body = await c.req.json();

  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first() as any;
  if (!order) return c.json({ error: 'Not found' }, 404);

  const now = Date.now();
  if (now > order.expires_at) {
    await db.prepare(`DELETE FROM orders WHERE id = ?`).bind(id).run();
    return c.json({ error: 'Order expired' }, 404);
  }

  if (now > order.locked_at) {
    return c.json({ error: 'Order locked (read-only)' }, 403);
  }

  if (!body.status) return c.json({ error: 'status required' }, 400);

  await db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).bind(body.status, id).run();

  return c.json({ success: true });
});

app.patch('/api/orders/:id/units/:unitid', async (c) => {
  const db = c.env.ORDERS;
  const orderId = c.req.param('id');
  const unitId = c.req.param('unitid');
  const body = await c.req.json();

  if (!body.status) return c.json({ error: 'status required' }, 400);
  const newStatus = body.status;

  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first() as any;
  if (!order) return c.json({ error: 'Order not found' }, 404);

  const now = Date.now();
  if (now > order.expires_at) {
    await db.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run();
    return c.json({ error: 'Order expired' }, 404);
  }
  if (now > order.locked_at) {
    return c.json({ error: 'Order locked (read-only)' }, 403);
  }

  const update = await db.prepare(`UPDATE order_units SET status = ? WHERE id = ?`).bind(newStatus, unitId).run();
  const unitRow = await db.prepare(`SELECT id, line_id FROM order_units WHERE id = ?`).bind(unitId).first();
  if (!unitRow) return c.json({ error: 'Unit not found' }, 404);

  const lineRow = await db.prepare(`SELECT id, order_id FROM order_lines WHERE id = ?`).bind(unitRow.line_id).first();
  if (!lineRow || lineRow.order_id !== orderId) {
    return c.json({ error: 'Unit does not belong to order' }, 400);
  }

  const unitCheck = await db.prepare(`
    SELECT status FROM order_units WHERE line_id IN (
      SELECT id FROM order_lines WHERE order_id = ?
    )
  `).bind(orderId).all();

  let allReady = true;
  for (const u of (unitCheck.results || []) as any[]) {
    if (u.status !== 'ready') {
      allReady = false;
      break;
    }
  }

  if (allReady) {
    await db.prepare(`UPDATE orders SET status = 'ready' WHERE id = ?`).bind(orderId).run();
  }

  return c.json({ success: true });
});

export default app;