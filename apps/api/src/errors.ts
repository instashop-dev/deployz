import { ZodError } from 'zod';

import type { ErrorEnvelope } from '@deployz/contracts';

// API error taxonomy. Every thrown error crosses the boundary as a structured
// envelope ({ error: { code, message, details? } }) — never a stack trace,
// never an internal message. Codes are stable strings; §61 failure codes flow
// through ApiError directly (e.g. new ApiError(422, 'PORT_MISMATCH', ...)).
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export interface ErrorEnvelopeResult {
  statusCode: number;
  body: ErrorEnvelope;
}

// Fastify's own 4xx errors (malformed JSON, unknown route, ...) carry a
// numeric statusCode — forward it; anything else is not a client error.
function frameworkClientStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

// Single funnel: unknown error -> { statusCode, envelope body }. The 500
// branch is deliberately generic — NEVER leak stack traces or internal
// messages to clients.
export function toErrorEnvelope(error: unknown): ErrorEnvelopeResult {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    };
  }

  const frameworkStatus = frameworkClientStatusCode(error);
  if (frameworkStatus !== undefined) {
    return {
      statusCode: frameworkStatus,
      body: {
        error: {
          code: 'REQUEST_ERROR',
          message: error instanceof Error ? error.message : 'Request failed',
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    },
  };
}
