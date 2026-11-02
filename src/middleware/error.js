const { ApiError } = require('../utils/errors');

// Unique constraint/index name -> API field, for "already in use" messages.
const UNIQUE_FIELDS = {
  users_email_key: 'email',
  users_mobile_key: 'mobile',
  classes_name_key: 'name',
  students_roll_key: 'rollNo',
  attendance_class_date_key: 'date',
};

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
    });
  }
  // Postgres error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
  if (err?.code === '23505') {
    const field = UNIQUE_FIELDS[err.constraint] || 'value';
    return res.status(409).json({ error: { code: 'DUPLICATE', message: `This ${field} is already in use` } });
  }
  if (err?.code === '23503') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A referenced record no longer exists' } });
  }
  if (err?.code === '22P02') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid id' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong' } });
}

module.exports = { notFoundHandler, errorHandler };
