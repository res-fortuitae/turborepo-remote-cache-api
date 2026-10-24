import dashboard from "../index.html";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3000,
  routes: { "/*": dashboard },
  development: { hmr: true, console: true },
});

console.log(`Dashboard: ${server.url}`);
