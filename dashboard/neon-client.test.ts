import { expect, test } from 'bun:test';
import { createAuthClient } from '@neondatabase/auth';
import { BetterAuthVanillaAdapter } from '@neondatabase/auth/vanilla/adapters';
import { createGateway } from './gateway.ts';

test('pinned Neon SDK account methods pass through the gateway route allowlist', async () => {
  const paths: string[] = [];
  let gateway: ReturnType<typeof createGateway>;
  // The provider is a local fixture: no account is created and no email is sent.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => gateway(request) });
  const origin = server.url.origin;
  gateway = createGateway({ origin, enabled: true, coreUrl: 'http://localhost:8787',
    authUrl: 'https://auth.example.invalid/neondb/auth', cookieSecret: 's'.repeat(32) },
    async () => Response.json({}), async ({ path }) => {
      paths.push(path);
      if (path === 'sign-in/email') return Response.json({ code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }, { status: 403 });
      return Response.json(path === 'get-session' ? null : { success: true });
    });
  const client = createAuthClient(`${origin}/auth/provider`, { adapter: BetterAuthVanillaAdapter({
    fetchOptions: { headers: { origin } },
  }) });
  try {
    const results = [
      await client.getSession(),
      await client.emailOtp.sendVerificationOtp({ email: 'staff@example.invalid', type: 'email-verification' }),
      await client.emailOtp.verifyEmail({ email: 'staff@example.invalid', otp: '000000' }),
      await client.forgetPassword.emailOtp({ email: 'staff@example.invalid' }),
      await client.emailOtp.resetPassword({ email: 'staff@example.invalid', otp: '000000', password: 'synthetic-test-only' }),
    ];
    for (const result of results) expect(result.error).toBeNull();
    expect(paths).toContain('email-otp/reset-password');
    expect(paths).toContain('forget-password/email-otp');
    await expect(client.signIn.email({ email: 'staff@example.invalid', password: 'synthetic-test-only' }))
      .rejects.toMatchObject({ code: 'email_not_confirmed' });
  } finally { server.stop(true); }
});
