import { forbidden } from '../lib/errors.js';

export const PERMISSIONS = [
  'viewStudents',
  'markAttendance',
  'viewExamResults',
  'enterMarks',
  'sendParentMessages',
  'sendSms',
  'editStudents',
];

/** Admin can do everything; staff need an active account and the permission. */
export function can(user, permission) {
  if (user.role === 'admin') return true;
  return user.isActive && user.permissions.includes(permission);
}

export const canSendMessages = (user) => can(user, 'sendParentMessages') && can(user, 'sendSms');

export function canAccessClass(user, classId) {
  return user.role === 'admin' || user.assignedClassIds.includes(classId);
}

export function requireClass(user, classId) {
  if (!canAccessClass(user, classId)) throw forbidden('This class is not assigned to you');
}

export function requirePermission(user, permission) {
  if (!can(user, permission)) throw forbidden(`Missing permission: ${permission}`);
}
