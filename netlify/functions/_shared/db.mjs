import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NETLIFY_DATABASE_URL);

// ============================================================================
// SCHEMA & INITIALIZATION
// ============================================================================

async function ensureSchema() {
  try {
    // Create tables if they don't exist
    await sql`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        booking_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(20),
        room VARCHAR(100) NOT NULL,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        paid BOOLEAN DEFAULT FALSE,
        military_discount BOOLEAN DEFAULT FALSE,
        discount_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS public_events (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        room VARCHAR(100) NOT NULL,
        description TEXT,
        is_recurring BOOLEAN DEFAULT FALSE,
        recurrence_pattern VARCHAR(50),
        recurrence_end_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS blackout_dates (
        id SERIAL PRIMARY KEY,
        blackout_date DATE NOT NULL,
        start_time TIME,
        end_time TIME,
        reason VARCHAR(255),
        room VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log('Schema ensured successfully');
  } catch (error) {
    console.error('Error ensuring schema:', error);
  }
}

// ============================================================================
// HTTP RESPONSE HELPERS
// ============================================================================

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

function bad(message, status = 400) {
  return json({ error: message }, status);
}

function noContent() {
  return {
    statusCode: 204,
    headers: { 'Content-Type': 'application/json' },
    body: ''
  };
}

function preflight() {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: ''
  };
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

function requireAdmin(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    throw new Error('Missing authorization token');
  }

  // Verify token signature (simplified; use JWT in production)
  try {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) throw new Error('ADMIN_SECRET not configured');
    // Basic token validation - in production use proper JWT verification
    if (token !== `token_${secret}`) {
      throw new Error('Invalid token');
    }
    return true;
  } catch (error) {
    throw new Error('Unauthorized');
  }
}

// ============================================================================
// BOOKING QUERIES
// ============================================================================

async function getBookings(filters = {}) {
  let query = sql`SELECT * FROM bookings`;

  if (filters.status) {
    query = sql`SELECT * FROM bookings WHERE status = ${filters.status}`;
  }

  if (filters.date) {
    query = sql`SELECT * FROM bookings WHERE booking_date = ${filters.date}`;
  }

  return await query;
}

async function getBookingById(id) {
  const result = await sql`SELECT * FROM bookings WHERE id = ${id}`;
  return result[0];
}

async function createBooking(data) {
  const result = await sql`
    INSERT INTO bookings (
      booking_date, start_time, end_time, customer_name, customer_email, 
      customer_phone, room, notes, military_discount
    ) VALUES (
      ${data.booking_date}, ${data.start_time}, ${data.end_time}, 
      ${data.customer_name}, ${data.customer_email}, ${data.customer_phone}, 
      ${data.room}, ${data.notes}, ${data.military_discount || false}
    )
    RETURNING *
  `;
  return result[0];
}

async function updateBooking(id, updates) {
  const fields = [];
  const values = [];

  Object.entries(updates).forEach(([key, value]) => {
    fields.push(`${key} = $${values.length + 1}`);
    values.push(value);
  });

  if (fields.length === 0) return getBookingById(id);

  values.push(id);
  const query = `UPDATE bookings SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`;
  
  const result = await sql(query, values);
  return result[0];
}

async function deleteBooking(id) {
  const result = await sql`DELETE FROM bookings WHERE id = ${id} RETURNING *`;
  return result[0];
}

// ============================================================================
// PUBLIC EVENTS QUERIES
// ============================================================================

async function getPublicEvents(filters = {}) {
  let query = sql`SELECT * FROM public_events ORDER BY event_date, start_time`;

  if (filters.date) {
    query = sql`SELECT * FROM public_events WHERE event_date = ${filters.date}`;
  }

  if (filters.room) {
    query = sql`SELECT * FROM public_events WHERE room = ${filters.room}`;
  }

  return await query;
}

async function createPublicEvent(data) {
  const result = await sql`
    INSERT INTO public_events (
      event_name, event_date, start_time, end_time, room, description, 
      is_recurring, recurrence_pattern, recurrence_end_date
    ) VALUES (
      ${data.event_name}, ${data.event_date}, ${data.start_time}, 
      ${data.end_time}, ${data.room}, ${data.description}, 
      ${data.is_recurring || false}, ${data.recurrence_pattern}, 
      ${data.recurrence_end_date}
    )
    RETURNING *
  `;
  return result[0];
}

async function deletePublicEvent(id) {
  const result = await sql`DELETE FROM public_events WHERE id = ${id} RETURNING *`;
  return result[0];
}

// ============================================================================
// BLACKOUT DATES QUERIES
// ============================================================================

async function getBlackoutDates(filters = {}) {
  let query = sql`SELECT * FROM blackout_dates ORDER BY blackout_date`;

  if (filters.date) {
    query = sql`SELECT * FROM blackout_dates WHERE blackout_date = ${filters.date}`;
  }

  if (filters.room) {
    query = sql`SELECT * FROM blackout_dates WHERE room = ${filters.room}`;
  }

  return await query;
}

async function createBlackoutDate(data) {
  const result = await sql`
    INSERT INTO blackout_dates (
      blackout_date, start_time, end_time, reason, room
    ) VALUES (
      ${data.blackout_date}, ${data.start_time}, ${data.end_time}, 
      ${data.reason}, ${data.room}
    )
    RETURNING *
  `;
  return result[0];
}

async function deleteBlackoutDate(id) {
  const result = await sql`DELETE FROM blackout_dates WHERE id = ${id} RETURNING *`;
  return result[0];
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  sql,
  ensureSchema,
  json,
  bad,
  noContent,
  preflight,
  requireAdmin,
  getBookings,
  getBookingById,
  createBooking,
  updateBooking,
  deleteBooking,
  getPublicEvents,
  createPublicEvent,
  deletePublicEvent,
  getBlackoutDates,
  createBlackoutDate,
  deleteBlackoutDate
};
