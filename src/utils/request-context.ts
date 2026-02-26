import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  source: 'http' | 'socket';
  path?: string;
  socketId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, callback: () => T): T => {
  return requestContextStorage.run(context, callback);
};

export const getRequestContext = (): RequestContext | undefined => requestContextStorage.getStore();

