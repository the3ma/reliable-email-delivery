import { http } from 'msw';
import { server } from '../mocks/server';

export interface Call {
  url: URL;
  body: unknown;
}

type Method = 'get' | 'post' | 'put';

/**
 * Records requests to `path` and then falls through to the regular mock handler (an MSW resolver
 * that returns nothing passes the request on), so the mock db still applies the change.
 */
export function spyOn(method: Method, path: string): Call[] {
  const calls: Call[] = [];
  server.use(
    http[method](`*/api/v1${path}`, async ({ request }) => {
      const text = await request.clone().text();
      calls.push({
        url: new URL(request.url),
        body: text ? (JSON.parse(text) as unknown) : undefined,
      });
    }),
  );
  return calls;
}
