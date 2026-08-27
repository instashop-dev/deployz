import type { ApplicationStackProps } from './application-stack.js';

/**
 * Container contract for the Documenso application (documenso/documenso).
 * Verified against upstream main, 2026-08-27:
 * - Hono server on PORT (default 3000), health at /api/health (200 for
 *   ok/warning — a missing signing certificate is a warning, not an error).
 * - The runtime image has node but NOT curl, so the container health check
 *   shells out to node's fetch.
 * - docker/start.sh runs `prisma migrate deploy` before the server starts;
 *   a fresh install migrates an empty database, so the health checks get a
 *   long start period.
 * - NEXT_PRIVATE_DATABASE_URL boots the app; NEXT_PRIVATE_DIRECT_DATABASE_URL
 *   is what `prisma migrate deploy` reads. Both carry the same URL here.
 */
export const DOCUMENSO_APPLICATION_PROPS = {
  containerPort: 3000,
  healthCheckPath: '/api/health',
  healthCheckShellCommand:
    `node -e "fetch('http://localhost:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"`,
  taskCpu: 512,
  taskMemoryMiB: 1024,
  startupGracePeriodSeconds: 300,
  databaseUrlEnvNames: ['NEXT_PRIVATE_DATABASE_URL', 'NEXT_PRIVATE_DIRECT_DATABASE_URL'],
  containerEnvironment: {
    NEXT_PUBLIC_BASE_PATH: '',
    NEXT_PRIVATE_INTERNAL_WEBAPP_URL: 'http://localhost:3000',
  },
  secretParameters: [
    { parameterId: 'param_PublicUrl', secretKey: 'publicUrl', envName: 'NEXT_PUBLIC_WEBAPP_URL' },
    { parameterId: 'param_NextauthSecret', secretKey: 'nextauthSecret', envName: 'NEXTAUTH_SECRET' },
    { parameterId: 'param_EncryptionKey', secretKey: 'encryptionKey', envName: 'NEXT_PRIVATE_ENCRYPTION_KEY' },
    { parameterId: 'param_EncryptionSecondaryKey', secretKey: 'encryptionSecondaryKey', envName: 'NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY' },
    { parameterId: 'param_SmtpTransport', secretKey: 'smtpTransport', envName: 'NEXT_PRIVATE_SMTP_TRANSPORT' },
    { parameterId: 'param_SmtpHost', secretKey: 'smtpHost', envName: 'NEXT_PRIVATE_SMTP_HOST' },
    { parameterId: 'param_SmtpPort', secretKey: 'smtpPort', envName: 'NEXT_PRIVATE_SMTP_PORT' },
    { parameterId: 'param_SmtpUsername', secretKey: 'smtpUsername', envName: 'NEXT_PRIVATE_SMTP_USERNAME' },
    { parameterId: 'param_SmtpPassword', secretKey: 'smtpPassword', envName: 'NEXT_PRIVATE_SMTP_PASSWORD' },
    { parameterId: 'param_SmtpFromAddress', secretKey: 'smtpFromAddress', envName: 'NEXT_PRIVATE_SMTP_FROM_ADDRESS' },
    { parameterId: 'param_SmtpFromName', secretKey: 'smtpFromName', envName: 'NEXT_PRIVATE_SMTP_FROM_NAME' },
  ],
} satisfies Partial<ApplicationStackProps>;
