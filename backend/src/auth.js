// Authentication and authorization (Task 3, DEC-002, DEC-017).
//
// * Login: bcrypt comparison against users.password_hash (bcryptjs; the seed's
//   pgcrypto crypt(..., gen_salt('bf')) hashes are bcrypt-compatible).
//   Unknown e-mail and wrong password give the same 401, and an unknown
//   e-mail still runs one bcrypt comparison so timing does not reveal it.
// * Token: HS256 JWT { sub: user_id (string), role }, issuer "payrail".
// * Every authenticated request re-reads the user (and the vendor it owns)
//   from the database, so a token for a user that no longer matches is refused.
//   Roles are fixed per user (trg_users_role_fixed), and there is no sign-up
//   endpoint, so no request can create or escalate a role.
// * The actor id passed to the workflow functions ALWAYS comes from req.user,
//   never from the request body; the functions re-check role/ownership (PRA01).
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { parseBody } from './validate.js';

const DUMMY_HASH = bcrypt.hashSync('payrail-timing-equaliser', 10);

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(72),          // bcrypt uses at most 72 bytes
}).strict();

export function authService({ db, config }) {
  const sign = (user) =>
    jwt.sign({ role: user.role }, config.jwtSecret, {
      algorithm: 'HS256', expiresIn: config.jwtExpiresIn, issuer: 'payrail', subject: String(user.user_id),
    });

  async function login(req, res) {
    const { email, password } = parseBody(req, loginSchema);
    const u = await db.one('SELECT user_id, full_name, email, role, password_hash FROM users WHERE email = $1', [email]);
    const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) throw new ApiError(401, 'invalid_credentials', 'invalid email or password');
    const user = await loadUser(u.user_id);
    res.json({ token: sign(u), token_type: 'Bearer', expires_in: config.jwtExpiresIn, user });
  }

  async function loadUser(userId) {
    return db.one(
      `SELECT u.user_id, u.full_name, u.email, u.role, v.vendor_id, v.legal_name AS vendor_name, v.kyc_status
         FROM users u LEFT JOIN vendors v ON v.owner_user_id = u.user_id
        WHERE u.user_id = $1`, [userId]);
  }

  /** requires "Authorization: Bearer <jwt>"; sets req.user */
  async function requireAuth(req, res, next) {
    if (req.user) return next();                       // already authenticated by an outer mount
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('Authorization') || '');
    if (!m) throw new ApiError(401, 'unauthenticated', 'missing bearer token');
    let claims;
    try {
      claims = jwt.verify(m[1], config.jwtSecret, { algorithms: ['HS256'], issuer: 'payrail' });
    } catch {
      throw new ApiError(401, 'unauthenticated', 'invalid or expired token');
    }
    if (!/^[1-9][0-9]{0,17}$/.test(String(claims.sub))) throw new ApiError(401, 'unauthenticated', 'invalid token subject');
    const user = await loadUser(claims.sub);
    if (!user || user.role !== claims.role) throw new ApiError(401, 'unauthenticated', 'token no longer valid');
    req.user = user;
    next();
  }

  return { login, loadUser, requireAuth, sign };
}

/** route guard: the authenticated user must have one of the roles */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) throw new ApiError(401, 'unauthenticated', 'authentication required');
  if (!roles.includes(req.user.role)) {
    throw new ApiError(403, 'forbidden', `this action requires role ${roles.join(' or ')}`);
  }
  next();
};

/** vendor routes additionally need the vendor the user owns */
export const requireVendor = (req, res, next) => {
  if (!req.user?.vendor_id) throw new ApiError(403, 'forbidden', 'user does not own a vendor');
  next();
};
