import { Hono } from 'hono';

const app = new Hono<{ Bindings: { ORDERS: D1Database } }>();
const CACHE = new Map<string, any>();

app.post('/order', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.items || !Array.isArray(data.items)) {
      return c.json({ error: 'Items required' }, 400);
    };

    const orderId = crypto.randomUUID();
    const createdAt = Date.now();

    await c.env.ORDERS.prepare(
      `INSERT INTO orders (id, created_at, status, subtotal, tax, total, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        orderId,
        createdAt,
        'in_progress',
        calculateSubtotal(data.items),
        calculateTax(data.items),
        calculateTotal(data.items),
        JSON.stringify(data)
      )
      .run();

    CACHE.delete(orderId);

    return c.json({ ok: true, id: orderId });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.get('/order/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (CACHE.has(id)) return c.json(CACHE.get(id));

    const res = await c.env.ORDERS.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first();
    if (!res) return c.text('Order not found', 404);

    const order = JSON.parse(res.raw_json as string);
    order.id = res.id;
    order.created_at = res.created_at;
    order.status = res.status;
    order.subtotal = res.subtotal;
    order.tax = res.tax;
    order.total = res.total;

    CACHE.set(id, order);
    return c.json(order);
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.patch('/order/:id/status', async (c) => {
  try {
    const id = c.req.param('id');
    const { status } = await c.req.json();
    if (!status) return c.json({ error: 'Status required' }, 400);

    await c.env.ORDERS.prepare(`UPDATE orders SET status = ? WHERE id = ?`).bind(status, id).run();
    CACHE.delete(id);

    return c.json({ ok: true });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.patch('/order/:id/:unitid/status', async (c) => {
  try {
    const orderId = c.req.param('id');
    const unitId = c.req.param('unitid');
    const { status } = await c.req.json();
    if (!status) return c.json({ error: 'Status required' }, 400);

    const row = await c.env.ORDERS.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first();
    if (!row) return c.json({ error: 'Order not found' }, 404);

    const order = JSON.parse(row.raw_json as string);

    let found = false;
    for (const item of order.items) {
      for (const unit of item.units) {
        if (unit.id === unitId) {
          unit.status = status;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return c.json({ error: 'Unit not found' }, 404);

    await c.env.ORDERS.prepare(`UPDATE orders SET raw_json = ? WHERE id = ?`).bind(JSON.stringify(order), orderId).run();

    CACHE.delete(orderId);

    return c.json({ ok: true });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

app.post('/meal', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.name || !data.price || !data.vendor_id || !data.vendor_name) {
      return c.json({ error: 'Name, price, vendor_id, vendor_name required' }, 400);
    };

    const mealId = crypto.randomUUID();
    const now = Date.now();
    const tagsJson = data.tags ? JSON.stringify(data.tags) : JSON.stringify([]);

    await c.env.ORDERS.prepare(
      `INSERT INTO meals (id, name, description, price, vendor_id, vendor_name, image_url, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      mealId,
      data.name,
      data.description || '',
      data.price,
      data.vendor_id,
      data.vendor_name,
      data.image_url || '',
      tagsJson,
      now,
      now
    ).run();

    return c.json({ ok: true, id: mealId });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.patch('/meal/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const data = await c.req.json();
    const now = Date.now();

    const tagsJson = data.tags ? JSON.stringify(data.tags) : null;

    await c.env.ORDERS.prepare(
      `UPDATE meals SET
        name = ?,
        description = ?,
        price = ?,
        vendor_id = ?,
        vendor_name = ?,
        image_url = ?,
        tags = ?,
        updated_at = ?
      WHERE id = ?`
    )
      .bind(
        data.name,
        data.description || '',
        data.price,
        data.vendor_id,
        data.vendor_name,
        data.image_url || '',
        tagsJson,
        now,
        id
      )
      .run();

    return c.json({ ok: true });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.delete('/meal/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.ORDERS.prepare(`DELETE FROM meals WHERE id = ?`).bind(id).run();
    return c.json({ ok: true });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.get('/meal', async (c) => {
  try {
    const res = await c.env.ORDERS.prepare(`SELECT * FROM meals`).all();
    const meals = res.results.map((meal: any) => ({
      ...meal,
      tags: meal.tags ? JSON.parse(meal.tags) : [],
    }));
    return c.json(meals);
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  };
});

app.get('/', (c) => c.text('Kiosk API running'));

export default app;

function calculateSubtotal(items: any[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
};

function calculateTax(items: any[]): number {
  return Math.floor(calculateSubtotal(items) * 0.09);
};

function calculateTotal(items: any[]): number {
  return calculateSubtotal(items) + calculateTax(items);
};