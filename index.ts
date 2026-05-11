const port = Number(process.env.PORT) || 3000;

const server = Bun.serve({
  port,
  routes: {
    "/": new Response("HTTP Live Streaming backend", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
    "/health": Response.json({ ok: true }),
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Backend listening at ${server.url}`);
