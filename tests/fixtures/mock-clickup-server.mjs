import http from 'node:http';

export const createMockClickUpServer = () => {
  const requests = [];
  let taskSequence = 0;
  let commentSequence = 0;

  return http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');

    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/requests') {
      response.end(JSON.stringify({ count: requests.length, requests }));
      return;
    }

    const taskMatch = request.method === 'POST'
      && request.url.match(/^\/api\/v2\/list\/([^/]+)\/task$/);
    const commentMatch = request.method === 'POST'
      && request.url.match(/^\/api\/v2\/task\/([^/]+)\/comment$/);
    if (!taskMatch && !commentMatch) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method,
        url: request.url,
        parsed_body: body ? JSON.parse(body) : {},
      });

      if (taskMatch) {
        taskSequence += 1;
        const id = `synthetic-clickup-task-${taskSequence}`;
        response.end(JSON.stringify({ id, url: `http://mock-clickup.local/t/${id}` }));
        return;
      }

      commentSequence += 1;
      response.end(JSON.stringify({ id: `synthetic-clickup-comment-${commentSequence}` }));
    });
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  createMockClickUpServer().listen(Number(process.env.PORT || 8083), '0.0.0.0');
}
