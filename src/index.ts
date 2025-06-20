import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

// --- Type Definitions ---
type Env = {
  Bindings: {
    DB: D1Database;
  };
};

type UseCase = { UseCase: string; }
type Product = { Product: string; }

const app = new Hono<Env>();

// --- API Routes ---
const api = app.basePath('/api');

// GET /api/filters - Fetches distinct values for dropdowns
api.get('/filters', async (c) => {
  try {
    const useCasesStmt = c.env.DB.prepare('SELECT DISTINCT UseCase FROM use_cases ORDER BY UseCase');
    const productsStmt = c.env.DB.prepare('SELECT DISTINCT Product FROM use_cases ORDER BY Product');
    
    const [useCases, products] = await Promise.all([
      useCasesStmt.all<UseCase>(),
      productsStmt.all<Product>()
    ]);

    return c.json({
      useCases: useCases.results,
      products: products.results,
    });
  } catch (e) {
    console.error(e);
    return c.json({ error: 'Could not fetch filters from database' }, 500);
  }
});

// GET /api/usecases - The main endpoint to get filtered data
api.get('/usecases', async (c) => {
  const { useCase, product } = c.req.query();
  const query = 'SELECT id, UseCase, Product, SuccessCriterion, Measurement FROM use_cases' +
    (useCase && useCase !== 'all' ? ' WHERE UseCase = ?1' : '') +
    (product && product !== 'all' ? (useCase && useCase !== 'all' ? ' AND' : ' WHERE') + ' Product = ?2' : '') +
    ' ORDER BY UseCase, Product';
  const params = [useCase, product].filter(p => p && p !== 'all');
  try {
    const stmt = c.env.DB.prepare(query).bind(...params);
    const { results } = await stmt.all();
    return c.json(results);
  } catch (e) {
    console.error(e);
    return c.json({ error: 'Could not fetch use cases from database' }, 500);
  }
});

// POST /api/submit-suggestion - Submits a new criterion to the PENDING table
api.post('/submit-suggestion', async (c) => {
  try {
    const { id, originalCriterion, suggestedCriterion } = await c.req.json<{ id: number, originalCriterion: string, suggestedCriterion: string }>();
    if (!id || !suggestedCriterion) {
      return c.json({ success: false, error: 'Required fields are missing.' }, 400);
    }
    const stmt = c.env.DB
      .prepare('INSERT INTO pending_criteria (use_case_id, original_criterion, suggested_criterion) VALUES (?1, ?2, ?3)')
      .bind(id, originalCriterion, suggestedCriterion);
    await stmt.run();
    return c.json({ success: true });
  } catch (e) {
    console.error('Submission failed:', e);
    return c.json({ success: false, error: 'Failed to submit to database.' }, 500);
  }
});

// GET /api/pending-criteria - Fetches all pending items for the admin page
api.get('/pending-criteria', async (c) => {
    try {
        const query = `
            SELECT 
                p.id as pending_id,
                p.suggested_criterion,
                p.original_criterion,
                u.id as use_case_id,
                u.UseCase,
                u.Product
            FROM pending_criteria p
            JOIN use_cases u ON p.use_case_id = u.id
            ORDER BY p.submitted_at DESC
        `;
        const { results } = await c.env.DB.prepare(query).all();
        return c.json(results);
    } catch (e) {
        console.error(e);
        return c.json({ error: 'Could not fetch pending criteria' }, 500);
    }
});

// POST /api/approve-criterion - Approves a change, updating the main table
api.post('/approve-criterion', async (c) => {
    try {
        const { pending_id, use_case_id, suggested_criterion } = await c.req.json<{ pending_id: number, use_case_id: number, suggested_criterion: string }>();

        // Create a batch operation to ensure atomicity
        const batch = [
            c.env.DB.prepare('UPDATE use_cases SET SuccessCriterion = ?1 WHERE id = ?2').bind(suggested_criterion, use_case_id),
            c.env.DB.prepare('DELETE FROM pending_criteria WHERE id = ?1').bind(pending_id)
        ];

        await c.env.DB.batch(batch);
        return c.json({ success: true });
    } catch (e) {
        console.error('Approval failed:', e);
        return c.json({ success: false, error: 'Database transaction failed.'}, 500);
    }
});


// --- Frontend Serving ---
app.get('*', serveStatic({
  root: './',
  manifest: ''
}));

export default app;