import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

// --- Type Definitions ---
type Env = {
  Bindings: {
    DB: D1Database;
    // Binding for the R2 bucket containing the PoC template
    POC_TEMPLATE: R2Bucket;
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
  const { useCases, products } = c.req.query();

  const useCaseList = useCases ? useCases.split(',').filter(Boolean) : [];
  const productList = products ? products.split(',').filter(Boolean) : [];

  let query = 'SELECT id, UseCase, Product, SuccessCriterion, Measurement FROM use_cases';
  const conditions: string[] = [];
  const params: string[] = [];

  if (useCaseList.length > 0) {
    conditions.push(`UseCase IN (${useCaseList.map(() => '?').join(',')})`);
    params.push(...useCaseList);
  }

  if (productList.length > 0) {
    conditions.push(`Product IN (${productList.map(() => '?').join(',')})`);
    params.push(...productList);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY UseCase, Product';

  try {
    const stmt = c.env.DB.prepare(query).bind(...params);
    const { results } = await stmt.all();
    return c.json(results);
  } catch (e) {
    console.error(e);
    return c.json({ error: 'Could not fetch use cases from database' }, 500);
  }
});

/**
 * NEW ENDPOINT
 * GET /api/get-poc-template - Securely fetches the .docx template from the private R2 bucket.
 */
api.get('/get-poc-template', async (c) => {
  // The key (filename) of the template in your R2 bucket.
  const templateKey = "Generate POC Plan Template (Short) - In Development.docx";

  try {
    // Access the R2 bucket via the binding
    const object = await c.env.POC_TEMPLATE.get(templateKey);

    if (object === null) {
      console.error(`Template object '${templateKey}' not found in R2 bucket.`);
      return c.json({ error: 'POC template file not found.' }, 404);
    }

    // Set the appropriate headers for a file download
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    // Return the file's content directly in the response
    return new Response(object.body, {
      headers,
    });

  } catch (e) {
    console.error('Failed to fetch template from R2:', e);
    return c.json({ error: 'Could not fetch template from R2 bucket.' }, 500);
  }
});


// POST /api/submit-suggestion - Submits an *update suggestion* for an *existing* criterion
api.post('/submit-suggestion', async (c) => {
  try {
    const { use_case_id, original_criterion, suggested_criterion } = await c.req.json<{ use_case_id: number, original_criterion: string, suggested_criterion: string }>();
    if (!use_case_id || suggested_criterion === undefined || original_criterion === undefined) {
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

// POST /api/propose-new-criterion - Submits a *brand new* criterion proposal
api.post('/propose-new-criterion', async (c) => {
  try {
    const { useCaseName, productName, successCriterion, measurement } = await c.req.json<{ 
        useCaseName: string, 
        productName: string, 
        successCriterion: string, 
        measurement: string 
    }>();

    if (!useCaseName || !productName || !successCriterion || !measurement) {
      return c.json({ success: false, error: 'All fields are required.' }, 400);
    }

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
            SELECT p.id as pending_id, p.suggested_criterion, p.original_criterion, u.id as use_case_id, u.UseCase, u.Product
            FROM pending_criteria p
            LEFT JOIN use_cases u ON p.use_case_id = u.id
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
        if (!pending_id) return c.json({ success: false, error: 'Pending ID is required.' }, 400);
        await c.env.DB.prepare('DELETE FROM pending_criteria WHERE id = ?1').bind(pending_id).run();
        return c.json({ success: true, message: "Pending item rejected." });
    } catch (e) {
        console.error('Rejection failed:', e);
        return c.json({ success: false, error: 'Failed to reject item.' }, 500);
    }
});

// POST /api/approve-new-criterion - Approves a *brand new* criterion proposal
api.post('/approve-new-criterion', async (c) => {
    try {
        const { pending_id, useCaseName, productName, successCriterion, measurement } = await c.req.json<{
            pending_id: number; useCaseName: string; productName: string; successCriterion: string; measurement: string;
        }>();

        if (!pending_id || !useCaseName || !productName || !successCriterion || !measurement) {
            return c.json({ success: false, error: 'All fields are required.' }, 400);
        }

        const batch = [
            c.env.DB.prepare('INSERT INTO use_cases (UseCase, Product, SuccessCriterion, Measurement) VALUES (?1, ?2, ?3, ?4)')
                .bind(useCaseName, productName, successCriterion, measurement),
            c.env.DB.prepare('DELETE FROM pending_criteria WHERE id = ?1').bind(pending_id)
        ];

        await c.env.DB.batch(batch);
        return c.json({ success: true, message: "New criterion approved and added." });
    } catch (e) {
        console.error('New criterion approval failed:', e);
        return c.json({ success: false, error: 'Database transaction failed.' }, 500);
    }
});

// --- Frontend Serving ---
// This must be the last route
app.get('*', serveStatic({
  root: './',
  manifest: ''
}));

export default app;
