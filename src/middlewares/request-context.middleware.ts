import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../utils/request-context';

const REQUEST_ID_HEADER = 'x-request-id';

export const withRequestContext = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = (req.header(REQUEST_ID_HEADER) || randomUUID()).trim();
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext(
    {
      requestId,
      source: 'http',
      path: req.originalUrl || req.path,
    },
    () => next(),
  );
};

