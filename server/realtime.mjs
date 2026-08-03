const clients = new Set();

export function subscribe(response) {
  clients.add(response);
  response.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);
  return () => clients.delete(response);
}

export function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(frame);
}

export function liveClientCount() {
  return clients.size;
}

