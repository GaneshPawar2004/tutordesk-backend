/** Owner (admin) or staff login: `users` row -> API object (never the password hash). */
const toPublic = (u) => ({
  id: u.id,
  institute: u.institute_id,
  role: u.role,
  name: u.name,
  email: u.email,
  mobile: u.mobile || '',
  subject: u.subject,
  phone: u.phone,
  salary: u.salary ?? null,
  canAccessFees: u.role === 'owner' ? true : u.can_access_fees,
  active: u.active,
  createdAt: u.created_at,
});

/** API field -> column, for staff create/edit. */
const COLUMNS = {
  name: 'name',
  subject: 'subject',
  phone: 'phone',
  email: 'email',
  salary: 'salary',
  canAccessFees: 'can_access_fees',
};

module.exports = { toPublic, COLUMNS };
