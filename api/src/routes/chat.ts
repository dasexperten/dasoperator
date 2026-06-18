// =============================================================================
// Das-Kompanion — AI chatbot for ERP
//
// POST /api/chat { message, session_token?, history? }
//   → { reply, actions?, context? }
//
// The chatbot works STRICTLY within the database — no data generation.
// All actions are permission-checked against the user's role.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { callPro } from '../lib/llm';
import { validateSession, type AuthUser } from '../lib/auth';

const chat = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// System prompt — defines Das-Kompanion's behavior
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Das-Kompanion, an AI assistant for Das Experten ERP system.

YOUR ROLE:
- Help users navigate and understand the ERP database
- Search for documents, operations, partners, products
- Analyze data (sums, trends, statuses)
- Create operations when requested (with confirmation)
- Answer questions about business data

STRICT RULES:
1. NEVER generate or fabricate data — only use what exists in the database
2. NEVER create documents without user confirmation
3. Always check user permissions before actions
4. Respond in the same language as the user
5. Be concise and professional
6. When creating operations, ALWAYS ask for confirmation first

AVAILABLE FUNCTIONS:
- search_operations: Find operations by partner, date range, status, type
- search_partners: Find partners by name, type, country
- search_products: Find products by name, category, manufacturer
- search_documents: Find documents by number, type, operation
- get_operation_details: Get full details of an operation
- get_partner_details: Get full details of a partner
- get_product_details: Get full details of a product
- get_stock_levels: Check current stock levels
- get_net_balances: Check partner balances
- create_operation: Create a new operation (requires confirmation)
- get_dashboard_summary: Get quick overview of business metrics

RESPONSE FORMAT:
- For simple queries: respond directly with the data
- For complex queries: use function calls to fetch data
- For creation requests: confirm with user before executing
- Always link to relevant ERP pages when possible`;

// ---------------------------------------------------------------------------
// Function definitions for LLM
// ---------------------------------------------------------------------------
const FUNCTIONS = [
  {
    name: 'search_operations',
    description: 'Search operations by partner, date range, status, or type',
    parameters: {
      type: 'object',
      properties: {
        partner_name: { type: 'string', description: 'Partner name to search for' },
        date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        status: { type: 'string', enum: ['draft', 'order_fulfilment', 'production', 'shipped', 'delivered', 'cancelled'] },
        operation_type: { type: 'string', enum: ['sale', 'purchase', 'transfer'] },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'search_partners',
    description: 'Search partners by name, type, or country',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Partner name to search for' },
        partner_type: { type: 'string', enum: ['buyer', 'supplier', 'shipper'] },
        country: { type: 'string', description: 'Country filter' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'search_products',
    description: 'Search products by name, category, or manufacturer',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Product name to search for' },
        category: { type: 'string', description: 'Category filter' },
        manufacturer_id: { type: 'string', description: 'Manufacturer ID' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'search_documents',
    description: 'Search documents by number, type, or operation',
    parameters: {
      type: 'object',
      properties: {
        document_number: { type: 'string', description: 'Document number' },
        document_type: { type: 'string', enum: ['CI', 'PL', 'contract', 'annex', 'IS'] },
        operation_id: { type: 'string', description: 'Operation ID' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_operation_details',
    description: 'Get full details of an operation',
    parameters: {
      type: 'object',
      properties: {
        operation_id: { type: 'string', description: 'Operation ID' },
      },
      required: ['operation_id'],
    },
  },
  {
    name: 'get_partner_details',
    description: 'Get full details of a partner',
    parameters: {
      type: 'object',
      properties: {
        partner_id: { type: 'string', description: 'Partner ID' },
      },
      required: ['partner_id'],
    },
  },
  {
    name: 'get_product_details',
    description: 'Get full details of a product',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'get_stock_levels',
    description: 'Check current stock levels for products',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product ID (optional, shows all if omitted)' },
        warehouse_id: { type: 'string', description: 'Warehouse ID (optional)' },
      },
    },
  },
  {
    name: 'get_net_balances',
    description: 'Check partner balances',
    parameters: {
      type: 'object',
      properties: {
        partner_id: { type: 'string', description: 'Partner ID (optional, shows all if omitted)' },
      },
    },
  },
  {
    name: 'create_operation',
    description: 'Create a new operation (requires confirmation)',
    parameters: {
      type: 'object',
      properties: {
        operation_type: { type: 'string', enum: ['sale', 'purchase', 'transfer'], description: 'Type of operation' },
        partner_id: { type: 'string', description: 'Partner ID' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              qty: { type: 'number' },
              unit_price: { type: 'number' },
            },
          },
          description: 'Line items',
        },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['operation_type', 'partner_id', 'items'],
    },
  },
  {
    name: 'get_dashboard_summary',
    description: 'Get quick overview of business metrics',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Execute function calls against the database
// ---------------------------------------------------------------------------
async function executeFunction(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  user: AuthUser,
): Promise<unknown> {
  const db = env.DB;

  // Permission check helper
  const checkPermission = (module: string, required: string) => {
    if (user.role === 'admin') return true;
    const access = user.permissions[module] ?? 'none';
    if (required === 'read') return ['full', 'rw', 'read'].includes(access);
    if (required === 'write') return ['full', 'rw'].includes(access);
    return false;
  };

  switch (name) {
    case 'search_operations': {
      if (!checkPermission('/operations', 'read')) {
        return { error: 'No permission to access operations' };
      }

      let query = `SELECT o.*, p.trade_name as partner_name 
                    FROM operations o 
                    LEFT JOIN partners p ON p.id = o.partner_id 
                    WHERE o.deleted_at IS NULL`;
      const params: unknown[] = [];

      if (args.partner_name) {
        query += ` AND p.trade_name LIKE ?`;
        params.push(`%${args.partner_name}%`);
      }
      if (args.status) {
        query += ` AND o.status = ?`;
        params.push(args.status);
      }
      if (args.operation_type) {
        query += ` AND o.operation_type = ?`;
        params.push(args.operation_type);
      }
      if (args.date_from) {
        query += ` AND o.operation_date >= ?`;
        params.push(Math.floor(new Date(args.date_from as string).getTime() / 1000));
      }
      if (args.date_to) {
        query += ` AND o.operation_date <= ?`;
        params.push(Math.floor(new Date(args.date_to as string).getTime() / 1000));
      }

      query += ` ORDER BY o.operation_date DESC LIMIT ?`;
      params.push(args.limit ?? 10);

      const result = await db.prepare(query).bind(...params).all();
      return { operations: result.results };
    }

    case 'search_partners': {
      if (!checkPermission('/partners', 'read')) {
        return { error: 'No permission to access partners' };
      }

      let query = `SELECT * FROM partners WHERE deleted_at IS NULL`;
      const params: unknown[] = [];

      if (args.name) {
        query += ` AND (trade_name LIKE ? OR legal_name LIKE ?)`;
        params.push(`%${args.name}%`, `%${args.name}%`);
      }
      if (args.partner_type) {
        query += ` AND partner_type = ?`;
        params.push(args.partner_type);
      }
      if (args.country) {
        query += ` AND country LIKE ?`;
        params.push(`%${args.country}%`);
      }

      query += ` ORDER BY trade_name LIMIT ?`;
      params.push(args.limit ?? 10);

      const result = await db.prepare(query).bind(...params).all();
      return { partners: result.results };
    }

    case 'search_products': {
      if (!checkPermission('/products', 'read')) {
        return { error: 'No permission to access products' };
      }

      let query = `SELECT * FROM products WHERE deleted_at IS NULL`;
      const params: unknown[] = [];

      if (args.name) {
        query += ` AND (product_name LIKE ? OR invoice_label LIKE ?)`;
        params.push(`%${args.name}%`, `%${args.name}%`);
      }
      if (args.category) {
        query += ` AND category = ?`;
        params.push(args.category);
      }
      if (args.manufacturer_id) {
        query += ` AND manufacturer_id = ?`;
        params.push(args.manufacturer_id);
      }

      query += ` ORDER BY product_name LIMIT ?`;
      params.push(args.limit ?? 10);

      const result = await db.prepare(query).bind(...params).all();
      return { products: result.results };
    }

    case 'search_documents': {
      if (!checkPermission('/operations', 'read')) {
        return { error: 'No permission to access documents' };
      }

      let query = `SELECT d.*, o.reference as operation_reference 
                    FROM documents d 
                    LEFT JOIN operations o ON o.id = d.operation_id 
                    WHERE d.deleted_at IS NULL`;
      const params: unknown[] = [];

      if (args.document_number) {
        query += ` AND d.document_number LIKE ?`;
        params.push(`%${args.document_number}%`);
      }
      if (args.document_type) {
        query += ` AND d.document_type = ?`;
        params.push(args.document_type);
      }
      if (args.operation_id) {
        query += ` AND d.operation_id = ?`;
        params.push(args.operation_id);
      }

      query += ` ORDER BY d.document_date DESC LIMIT ?`;
      params.push(args.limit ?? 10);

      const result = await db.prepare(query).bind(...params).all();
      return { documents: result.results };
    }

    case 'get_operation_details': {
      if (!checkPermission('/operations', 'read')) {
        return { error: 'No permission to access operations' };
      }

      const op = await db.prepare(
        `SELECT o.*, p.trade_name as partner_name, c.abbreviation as company_abbreviation
         FROM operations o 
         LEFT JOIN partners p ON p.id = o.partner_id
         LEFT JOIN companies c ON c.id = o.our_company_id
         WHERE o.id = ?`
      ).bind(args.operation_id).first();

      if (!op) return { error: 'Operation not found' };

      const items = await db.prepare(
        `SELECT li.*, pr.product_name, pr.invoice_label
         FROM line_items li
         LEFT JOIN products pr ON pr.id = li.product_id
         WHERE li.operation_id = ?`
      ).bind(args.operation_id).all();

      return { operation: op, items: items.results };
    }

    case 'get_partner_details': {
      if (!checkPermission('/partners', 'read')) {
        return { error: 'No permission to access partners' };
      }

      const partner = await db.prepare(
        `SELECT * FROM partners WHERE id = ?`
      ).bind(args.partner_id).first();

      if (!partner) return { error: 'Partner not found' };

      const ops = await db.prepare(
        `SELECT COUNT(*) as count FROM operations WHERE partner_id = ? AND deleted_at IS NULL`
      ).bind(args.partner_id).first();

      return { partner, operations_count: ops?.count ?? 0 };
    }

    case 'get_product_details': {
      if (!checkPermission('/products', 'read')) {
        return { error: 'No permission to access products' };
      }

      const product = await db.prepare(
        `SELECT p.*, m.name as manufacturer_name
         FROM products p
         LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
         WHERE p.id = ?`
      ).bind(args.product_id).first();

      if (!product) return { error: 'Product not found' };

      const stock = await db.prepare(
        `SELECT s.*, w.name as warehouse_name, w.code as warehouse_code
         FROM stocks s
         LEFT JOIN warehouses w ON w.id = s.warehouse_id
         WHERE s.product_id = ?`
      ).bind(args.product_id).all();

      return { product, stock: stock.results };
    }

    case 'get_stock_levels': {
      if (!checkPermission('/warehouses', 'read')) {
        return { error: 'No permission to access warehouses' };
      }

      let query = `SELECT s.*, p.product_name, p.invoice_label, w.name as warehouse_name, w.code as warehouse_code
                    FROM stocks s
                    LEFT JOIN products p ON p.id = s.product_id
                    LEFT JOIN warehouses w ON w.id = s.warehouse_id
                    WHERE 1=1`;
      const params: unknown[] = [];

      if (args.product_id) {
        query += ` AND s.product_id = ?`;
        params.push(args.product_id);
      }
      if (args.warehouse_id) {
        query += ` AND s.warehouse_id = ?`;
        params.push(args.warehouse_id);
      }

      query += ` ORDER BY w.code, p.product_name`;

      const result = await db.prepare(query).bind(...params).all();
      return { stocks: result.results };
    }

    case 'get_net_balances': {
      if (!checkPermission('/finance', 'read')) {
        return { error: 'No permission to access finance' };
      }

      let query = `SELECT partner_id, 
                    SUM(CASE WHEN direction = 'incoming' THEN amount ELSE 0 END) -
                    SUM(CASE WHEN direction = 'outgoing' THEN amount ELSE 0 END) as net_balance,
                    currency
                    FROM payments
                    WHERE deleted_at IS NULL`;
      const params: unknown[] = [];

      if (args.partner_id) {
        query += ` AND partner_id = ?`;
        params.push(args.partner_id);
      }

      query += ` GROUP BY partner_id, currency`;

      const result = await db.prepare(query).bind(...params).all();
      return { balances: result.results };
    }

    case 'create_operation': {
      if (!checkPermission('/operations', 'write')) {
        return { error: 'No permission to create operations' };
      }

      // This is a placeholder — actual creation would need full validation
      return {
        status: 'pending_confirmation',
        message: 'Operation creation requires confirmation. Please confirm with the user.',
        preview: args,
      };
    }

    case 'get_dashboard_summary': {
      if (!checkPermission('/', 'read')) {
        return { error: 'No permission to access dashboard' };
      }

      const ops = await db.prepare(
        `SELECT COUNT(*) as total, 
                SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) as active
         FROM operations WHERE deleted_at IS NULL`
      ).first();

      const partners = await db.prepare(
        `SELECT COUNT(*) as total FROM partners WHERE deleted_at IS NULL`
      ).first();

      const products = await db.prepare(
        `SELECT COUNT(*) as total FROM products WHERE deleted_at IS NULL`
      ).first();

      return {
        operations: ops,
        partners: partners,
        products: products,
      };
    }

    default:
      return { error: `Unknown function: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------
chat.post('/', async (c) => {
  let body: { message?: string; history?: Array<{ role: string; content: string }> };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'bad_json', message: 'invalid JSON body' }]);
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return fail(c, 400, [{ code: 'empty_message', message: 'message is required' }]);
  }

  // Get user from session token (optional — allows anonymous usage with limited access)
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  let user: AuthUser | null = null;

  if (token) {
    user = await validateSession(c.env.DB, token);
  }

  // Default user for anonymous access (read-only, limited)
  if (!user) {
    user = {
      id: 'anonymous',
      name: 'Guest',
      role: 'support',
      permissions: {
        '/': 'read',
        '/partners': 'read',
        '/operations': 'read',
        '/products': 'read',
        '/warehouses': 'read',
      },
    };
  }

  // Build messages array for LLM
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.history ?? []),
    { role: 'user', content: message },
  ];

  try {
    // Call LLM with function calling
    const result = await callPro(messages, {
      env: c.env,
      maxTokens: 4000,
      temperature: 0.3,
    });

    // Check if LLM wants to call functions
    const text = result.text;
    let functionCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    // Try to parse function calls from response
    // (In production, you'd use proper function calling API)
    const functionCallMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (functionCallMatch) {
      try {
        const parsed = JSON.parse(functionCallMatch[1]);
        if (parsed.function_calls) {
          functionCalls = parsed.function_calls;
        }
      } catch {
        // Not a function call, treat as regular response
      }
    }

    // Execute any function calls
    const functionResults: Array<{ name: string; result: unknown }> = [];
    for (const fc of functionCalls) {
      const result = await executeFunction(fc.name, fc.arguments, c.env, user);
      functionResults.push({ name: fc.name, result });
    }

    // If we had function calls, get a final response with the data
    let finalReply = text;
    if (functionResults.length > 0) {
      const dataMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
        { role: 'assistant', content: text },
        { role: 'system', content: `Function results:\n${JSON.stringify(functionResults, null, 2)}` },
      ];

      const finalResult = await callPro(dataMessages, {
        env: c.env,
        maxTokens: 4000,
        temperature: 0.3,
      });

      finalReply = finalResult.text;
    }

    return ok(c, {
      reply: finalReply,
      actions: functionResults.length > 0 ? functionResults : undefined,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[das-kompanion] Error:', error);
    return fail(c, 500, [{ code: 'chat_error', message: 'Failed to process chat message' }]);
  }
});

export default chat;
