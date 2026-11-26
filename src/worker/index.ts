import { Hono } from 'hono';
import { ZodError } from 'zod';
import { requireMember, sameOriginJson } from './auth';
import { publicEmail } from './email/public';
import type { AppEnv } from './env';
import { signIn } from './google';
import { announcements } from './routes/announcements';
import { attention } from './routes/attention';
import { claims } from './routes/claims';
import { campaigns } from './routes/campaigns';
import { directory } from './routes/directory';
import { email } from './routes/email';
import { expenses } from './routes/expenses';
import { firm } from './routes/firm';
import { imports } from './routes/imports';
import { marketing } from './routes/marketing';
import { people } from './routes/people';
import { properties } from './routes/properties';
import { pncs } from './routes/pncs';
import { reports } from './routes/reports';
import { team } from './routes/team';
import { HttpError } from './util';

export const app = new Hono<AppEnv>();

// Private data: never cache, never frame, send nothing to other sites.
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});
app.use('/api/*', sameOriginJson, requireMember);

// Signing in, health checks, unsubscribe links and Amazon SES notifications: the only routes that don't require a member.
app.route('/auth', signIn);
app.get('/healthz', c => c.text('ok'));
app.route('/', publicEmail);

app.route('/api', people);
app.route('/api', firm);
app.route('/api/pncs', pncs);
app.route('/api/expenses', expenses);
app.route('/api', directory);
app.route('/api/imports', imports);
app.route('/api/marketing', marketing);
app.route('/api/marketing', campaigns);
app.route('/api', team);
app.route('/api/reports', reports);
app.route('/api', attention);
app.route('/api/email', email);
app.route('/api/properties', properties);
app.route('/api/announcements', announcements);
app.route('/api/claims', claims);

app.notFound(c => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found.' }, 404) : c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found.', 404)));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof ZodError) return c.json({ error: err.issues[0]?.message ?? 'Invalid request.' }, 400);
  if (/UNIQUE constraint failed: matters\.file_number/.test(String(err))) return c.json({ error: 'That file number is already in use.' }, 409);
  console.error('Unhandled error', err);
  return c.json({ error: 'Something went wrong on the server. Nothing was saved; please try again.' }, 500);
});
