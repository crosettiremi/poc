import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

// --- Type Definitions ---
type Env = {
  Bindings: {
    DB: D1Database;
    POC_TEMPLATE: R2Bucket;
  };
};

type UseCase = { UseCase: string; }
type Product = { Product: string; }
type SuccessCriterion = {
    UseCase: string;
    Product: string;
    SuccessCriterion: string;
    Measurement: string;
};

const app = new Hono<Env>();

// --- API Routes ---
const api = app.basePath('/api');

// --- Helper Functions ---

/**
 * Escapes special XML characters to prevent breaking the DOCX structure.
 * @param str The input string.
 * @returns The escaped string.
 */
function escapeXml(str: string): string {
    return str.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}


/**
 * Creates the OpenXML markup for the success criteria table.
 * @param data The array of success criteria objects.
 * @returns A string of OpenXML.
 */
function createTableXml(data: SuccessCriterion[]): string {
    if (!data || data.length === 0) {
        return ''; // Return empty string if there's no data
    }

    // Define the table header row
    const headerRow = `
        <w:tr>
            <w:tc><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Use Case</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Product</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Success Criterion</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Measurement</w:t></w:r></w:p></w:tc>
        </w:tr>
    `;

    // Create a row for each data item, ensuring all content is escaped
    const dataRows = data.map(item => `
        <w:tr>
            <w:tc><w:p><w:r><w:t>${escapeXml(item.UseCase)}</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>${escapeXml(item.Product)}</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>${escapeXml(item.SuccessCriterion)}</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>${escapeXml(item.Measurement)}</w:t></w:r></w:p></w:tc>
        </w:tr>
    `).join('');

    // Return the full table XML
    return `
        <w:tbl>
            <w:tblPr>
                <w:tblStyle w:val="GridTable4-Accent5"/>
                <w:tblW w:w="0" w:type="auto"/>
                <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>
            </w:tblPr>
            <w:tblGrid>
                <w:gridCol w:w="2310"/>
                <w:gridCol w:w="1590"/>
                <w:gridCol w:w="3000"/>
                <w:gridCol w:w="2500"/>
            </w:tblGrid>
            ${headerRow}
            ${dataRows}
        </w:tbl>
    `;
}

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
 * POST /api/generate-poc-document - Generates a DOCX file with success criteria.
 */
api.post('/generate-poc-document', async (c) => {
    const templateKey = "Generate POC Plan Template (Short) - In Development.docx";
    try {
        const criteriaData = await c.req.json<SuccessCriterion[]>();
        if (!criteriaData || !Array.isArray(criteriaData)) {
            return c.json({ error: 'Invalid report data provided.' }, 400);
        }

        const object = await c.env.POC_TEMPLATE.get(templateKey);
        if (object === null) {
            console.error(`Template object '${templateKey}' not found in R2 bucket.`);
            return c.json({ error: 'POC template file not found.' }, 404);
        }
        const templateArrayBuffer = await object.arrayBuffer();

        const zip = new PizZip(templateArrayBuffer);
        
        // Initialize docxtemplater without the custom parser
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
        });
        
        // Instead of using a parser, pass the data to the render method.
        // The key 'SUCCESS_CRITERIA_TABLE' must match the tag in your template.
        doc.render({
            SUCCESS_CRITERIA_TABLE: createTableXml(criteriaData)
        });

        const generatedDocBuffer = doc.getZip().generate({
            type: 'blob',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        const headers = new Headers({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': 'attachment; filename="Proof_of_Concept_Plan.docx"'
        });

        return new Response(generatedDocBuffer, { headers });

    } catch (e) {
        console.error('Failed to generate PoC document:', e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        return c.json({ error: 'Could not generate the PoC document.', details: errorMessage }, 500);
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