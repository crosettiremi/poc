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

// POST /api/submit-suggestion - Submits an *update suggestion* for an *existing* criterion to the PENDING table
api.post('/submit-suggestion', async (c) => {
  try {
    // Note: The 'id' here is use_case_id from the use_cases table.
    const { use_case_id, original_criterion, suggested_criterion } = await c.req.json<{ use_case_id: number, original_criterion: string, suggested_criterion: string }>();
    if (!use_case_id || suggested_criterion === undefined || original_criterion === undefined) { // original_criterion can be empty string
      return c.json({ success: false, error: 'Required fields are missing for suggestion.' }, 400);
    }
    const stmt = c.env.DB
      .prepare('INSERT INTO pending_criteria (use_case_id, original_criterion, suggested_criterion) VALUES (?1, ?2, ?3)')
      .bind(use_case_id, original_criterion, suggested_criterion);
    await stmt.run();
    return c.json({ success: true });
  } catch (e) {
    console.error('Suggestion submission failed:', e);
    return c.json({ success: false, error: 'Failed to submit suggestion to database.' }, 500);
  }
});

// POST /api/propose-new-criterion - Submits a *brand new* criterion proposal to the PENDING table
api.post('/propose-new-criterion', async (c) => {
  try {
    const { useCaseName, productName, successCriterion, measurement } = await c.req.json<{ 
        useCaseName: string, 
        productName: string, 
        successCriterion: string, 
        measurement: string 
    }>();

    if (!useCaseName || !productName || !successCriterion || !measurement) {
      return c.json({ success: false, error: 'All fields (Use Case Name, Product Name, Success Criterion, Measurement) are required.' }, 400);
    }

    // Store structured data as JSON strings in existing fields. use_case_id is NULL for new proposals.
    const originalData = JSON.stringify({ ucn: useCaseName, pn: productName });
    const suggestedData = JSON.stringify({ sc: successCriterion, m: measurement });

    const stmt = c.env.DB
      .prepare('INSERT INTO pending_criteria (use_case_id, original_criterion, suggested_criterion) VALUES (NULL, ?1, ?2)')
      .bind(originalData, suggestedData);
    await stmt.run();
    return c.json({ success: true, message: "New criterion proposed successfully." });
  } catch (e) {
    console.error('New proposal submission failed:', e);
    return c.json({ success: false, error: 'Failed to submit new proposal to database.' }, 500);
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
                u.UseCase, -- This will be NULL if p.use_case_id is NULL
                u.Product  -- This will be NULL if p.use_case_id is NULL
            FROM pending_criteria p
            LEFT JOIN use_cases u ON p.use_case_id = u.id -- Changed to LEFT JOIN
            ORDER BY p.submitted_at DESC
        `;
        const { results } = await c.env.DB.prepare(query).all();
        return c.json(results);
    } catch (e) {
        console.error(e);
        return c.json({ error: 'Could not fetch pending criteria' }, 500);
    }
});

// POST /api/reject-criterion - Rejects (deletes) a pending item
api.post('/reject-criterion', async (c) => {
    try {
        const { pending_id } = await c.req.json<{ pending_id: number }>();

        if (!pending_id) {
            return c.json({ success: false, error: 'Pending ID is required for rejection.' }, 400);
        }

        await c.env.DB.prepare('DELETE FROM pending_criteria WHERE id = ?1').bind(pending_id).run();
        return c.json({ success: true, message: "Pending item rejected and removed." });
    } catch (e) {
        console.error('Rejection failed:', e);
        return c.json({ success: false, error: 'Failed to reject item from database.' }, 500);
    }
});
// POST /api/approve-new-criterion - Approves a *brand new* criterion proposal
api.post('/approve-new-criterion', async (c) => {
    try {
        const { pending_id, useCaseName, productName, successCriterion, measurement } = await c.req.json<{
            pending_id: number;
            useCaseName: string;
            productName: string;
            successCriterion: string;
            measurement: string;
        }>();

        if (!pending_id || !useCaseName || !productName || !successCriterion || !measurement) {
            return c.json({ success: false, error: 'All fields are required for approving a new criterion.' }, 400);
        }

        // Create a batch operation to ensure atomicity
        const batch = [
            c.env.DB.prepare('INSERT INTO use_cases (UseCase, Product, SuccessCriterion, Measurement) VALUES (?1, ?2, ?3, ?4)')
                .bind(useCaseName, productName, successCriterion, measurement),
            c.env.DB.prepare('DELETE FROM pending_criteria WHERE id = ?1').bind(pending_id)
        ];

        await c.env.DB.batch(batch);
        return c.json({ success: true, message: "New criterion approved and added." });
    } catch (e) {
        console.error('New criterion approval failed:', e);
        return c.json({ success: false, error: 'Database transaction failed for new criterion approval.' }, 500);
    }
});

// --- Frontend Serving ---
app.get('*', serveStatic({
  root: './',
  manifest: ''
}));

export default app;