// Each client owns exactly two observers and one heartbeat; no store lifecycle.
export function streamHandler(store) {
  return (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onReading = (reading) => send('reading', reading);
    const onStatus = (status) => send('status', status);

    send('status', store.status());
    store.on('reading', onReading);
    store.on('status', onStatus);
    const ping = setInterval(() => res.write(': ping\n\n'), 25 * 1000);

    req.on('close', () => {
      clearInterval(ping);
      store.off('reading', onReading);
      store.off('status', onStatus);
    });
  };
}
