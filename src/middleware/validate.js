const { badRequest } = require('../utils/errors');

/**
 * Validates req[part] with a zod schema and replaces it with the parsed value.
 * Usage: validate(schema) for the body, validate(schema, 'query') for queries.
 */
const validate = (schema, part = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[part] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    return next(badRequest(details[0]?.message || 'Invalid input', details));
  }
  if (part === 'query') {
    // req.query is a getter in Express 5; store parsed copy separately.
    req.validQuery = result.data;
  } else {
    req[part] = result.data;
  }
  next();
};

module.exports = validate;
