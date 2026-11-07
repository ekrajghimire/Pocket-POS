// GET /api/products  ->  { products: [...] }   the full product list, downloaded once per login/refresh
import { route, sendJson } from '../lib/http.js';
import { requireSession } from '../lib/auth.js';
import { readProducts } from '../lib/sheets.js';

export default route('GET', async (req, res) => {
  if (!requireSession(req, res)) return;
  const products = await readProducts();
  sendJson(res, 200, { products, fetched_at: new Date().toISOString() });
});
