import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

// --- Type Definitions ---
// It's a good practice in TypeScript to define the shape of your environment variables.
type Env = {
  Bindings: {
    DB: D1Database;
  };
};

// Define types for our data models for better code completion and safety.
type UseCase = {
  UseCase: string;
}

type Product = {
  Product: string;
}

// Initialize Hono with the environment types.
const app = new Hono<Env>();

// --- API Routes ---
// This creates a route group for all requests to /api
const api = app.basePath('/api');

// GET /api/filters - Fetches distinct use cases and products for dropdowns
api.get('/filters', async (c) => {
  try {
    const useCasesStmt = c.env.DB.prepare('SELECT DISTINCT UseCase FROM use_cases ORDER BY UseCase');
    const productsStmt = c.env.DB.prepare('SELECT DISTINCT Product FROM use_cases ORDER BY Product');
    
    // Using Promise.all with typed results
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

  let query: string = 'SELECT * FROM use_cases';
	const conditions: string[] = [];
	const params: string[] = [];

	if (useCase && useCase !== 'all') {
		conditions.push('UseCase = ?1');
		params.push(useCase);
	}
	if (product && product !== 'all') {
		conditions.push('Product = ?2');
		params.push(product);
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


// --- Frontend Serving ---
// This tells Hono to serve static files from the project root.
// Hono will look for a 'public' directory by convention if you structure your project that way.
// Any request that doesn't match an API route will try to find a file here.
app.get('*', serveStatic({
  root: './',
  manifest: ''
}));

export default app;
