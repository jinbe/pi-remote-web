import { createSSEStream } from '$lib/server/sse';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) => {
	return createSSEStream(params.id, request);
};
