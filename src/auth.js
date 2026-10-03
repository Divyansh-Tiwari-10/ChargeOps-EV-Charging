import jwt from 'jsonwebtoken';
import { pool } from './db.js';

export function signInToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ sub: String(user.user_id), roles: user.roles }, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  });
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in is required.' });
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await pool.execute(
      `SELECT u.user_id, u.email, u.display_name, u.is_active,
              GROUP_CONCAT(r.role_name ORDER BY r.role_name) AS role_list
       FROM user_account u
       LEFT JOIN user_role ur ON ur.user_id=u.user_id
       LEFT JOIN app_role r ON r.role_id=ur.role_id
       WHERE u.user_id=? GROUP BY u.user_id`, [claims.sub]
    );
    const account = rows[0];
    if (!account?.is_active) return res.status(401).json({ error: 'Account is inactive.' });
    req.user = { ...account, roles: account.role_list ? account.role_list.split(',') : [] };
    next();
  } catch {
    res.status(401).json({ error: 'Sign-in token is invalid or expired.' });
  }
}

export function allowRoles(...allowed) {
  return (req, res, next) => {
    if (!req.user?.roles?.some(role => allowed.includes(role))) {
      return res.status(403).json({ error: 'Your account cannot perform this action.' });
    }
    next();
  };
}
